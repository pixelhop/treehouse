import { Prisma, usePrismaClient } from "db";
import { baseContentType, type CommentOp } from "shared";
import { type AclRow, aclCovers, canRead, grantLevel, listWorkspaceAcls, type Viewer } from "./acl";
import { type AnchorRecord, type CreateMatch, resolveAnchor, resolveNewAnchor } from "./anchoring";
import { type Actor, useFileService } from "./files";
import { normalizePath } from "./paths";
import { limitsForWorkspace } from "./quota";
import { NODE_PATH_MAX } from "./workspace";

// ---------------------------------------------------------------------------
// Comment service. The single write path for threads/replies/resolution — REST
// routes and the MCP tools both call it, so the anchor rules, ACL gating, event
// emission, and dedupe invariants live in exactly one place. Every entry point
// gates access itself (fail-as-404: a denial is indistinguishable from a
// missing thread), so callers add no gate of their own.
//
// Lock-order invariant (KTD9, refined): the global order is `file_node` →
// `comment_thread`. move() in files.ts takes its file_node locks first and only
// then re-paths comment_thread, so a comment transaction may lock file_node —
// but ONLY before it touches comment_thread, never after. createThread takes
// that lock (it has to: a move committing between reading the node and
// inserting the row would strand the thread at a path the file has left).
// replyToThread and setResolved take NO file_node lock at all: locking the
// thread row and re-reading its path there is enough, which leaves them
// trivially outside the cycle. Plain SELECTs on file_node inside a comment
// transaction are fine — they take no row locks, so they add no wait-for edge.
//
// Change events: every real mutation emits a `comment_*` event in the SAME
// transaction, with `version` = the file's current version at mutation time.
// The version is null ONLY when the file no longer exists — fielded CLIs treat
// a null-version event as a remote-delete hint, and event rows outlive deploys,
// so a comment event on a live file must never carry null.
// ---------------------------------------------------------------------------

// Input bounds. Bytes, not chars — the payloads land in Postgres and in list
// responses, so the cap must bound storage, not glyph count.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUOTE_BYTES = 4 * 1024;
const MAX_CONTEXT_BYTES = 512;
// Context captured around a forward-re-anchored span, mirroring the resolver's
// own capture sizes (anchoring.ts RANGE_CONTEXT_CHARS / POINT_CONTEXT_CHARS).
const RANGE_CONTEXT_CHARS = 64;
const POINT_CONTEXT_CHARS = 96;
// Replies returned per thread in a list response (bounds unbounded growth).
const DEFAULT_ENTRIES_LIMIT = 20;
const MAX_ENTRIES_LIMIT = 100;
const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;
// The `anchorStatus` filter is computed, not stored: it can only be applied
// after each thread's anchor has been resolved against current content, so that
// one filter cannot page in SQL. Rather than resolve a whole file's history to
// answer it, it resolves at most this many threads and reports `truncated` when
// it hits the ceiling — a bounded answer that says so, not a silent one.
const ANCHOR_SCAN_CAP = 500;

export type AnchorStatus = "anchored" | "ambiguous" | "outdated";
export type ThreadStatus = "open" | "resolved";
export type AnchorKind = "range" | "point";

export interface AttributionView {
  principal: string;
  actorId: string | null;
  actorKeyId: string | null;
  actorLabel: string | null;
}

export interface CommentEntryView {
  id: string;
  body: string;
  author: AttributionView;
  createdAt: string;
}

// Thread payload. Text-first (KD8): the original quote, its contexts, and the
// current-version matching text — never numeric offsets. `pinnedVersion` is the
// display label for recovering an outdated thread via a version read; the
// content hash pin stays server-side (pinned bytes are served by thread id).
export interface CommentThreadView {
  id: string;
  path: string;
  status: ThreadStatus;
  resolvedAt: string | null;
  resolvedAtVersion: number | null;
  resolvedBy: AttributionView | null;
  anchorKind: AnchorKind;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  pinnedVersion: number;
  anchorStatus: AnchorStatus;
  /** The matching text in the CURRENT version; null unless anchored. */
  currentText: string | null;
  createdBy: AttributionView;
  createdAt: string;
  updatedAt: string;
  entries: CommentEntryView[];
  entryCount: number;
  hasMoreEntries: boolean;
}

type ThreadRow = Prisma.CommentThreadGetPayload<Record<string, never>>;
type EntryRow = Prisma.CommentEntryGetPayload<Record<string, never>>;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function attribution(row: {
  principal: string;
  actorId: string | null;
  actorKeyId: string | null;
  actorLabel: string | null;
}): AttributionView {
  return {
    principal: row.principal,
    actorId: row.actorId,
    actorKeyId: row.actorKeyId,
    actorLabel: row.actorLabel,
  };
}

function entryView(e: EntryRow): CommentEntryView {
  return {
    id: e.id,
    body: e.body,
    author: attribution(e),
    createdAt: e.createdAt.toISOString(),
  };
}

async function recordCommentEvent(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  path: string,
  op: CommentOp,
  version: number | null,
  actor: Actor,
): Promise<void> {
  await tx.changeEvent.create({
    data: {
      workspaceId,
      path,
      op,
      version,
      principal: actor.principal,
      actorId: actor.actorId,
      actorKeyId: actor.actorKeyId,
      actorLabel: actor.actorLabel,
    },
  });
}

/**
 * Is this workspace read-only because its subscription lapsed or was never
 * paid for? Comments are a WRITE path — threads, replies and resolutions all
 * mutate the workspace and emit change events — so they answer to the same
 * billing gate as `FileService.write`. Nothing else in the service checked it,
 * which left a fully writable collaboration channel inside a workspace the
 * billing surface promises is paused.
 *
 * Reads are deliberately untouched: an expired workspace stays readable, so
 * existing threads can still be read (and exported) while it is locked.
 */
async function workspaceReadOnly(workspaceId: string): Promise<boolean> {
  return (await limitsForWorkspace(workspaceId)).readOnly;
}

/**
 * Sentinel for a createThread transaction that aborted because the file stopped
 * being markdown under the lock — distinct from `null` (gone / different node),
 * which is a not-found.
 */
const NOT_MARKDOWN = Symbol("not_markdown");

/** Anchor fields stored on a thread row (all derived from the pinned content). */
interface AnchorFields {
  quote: string;
  contextBefore: string;
  contextAfter: string;
  sourceStart: number;
  sourceEnd: number;
}

/** Derive stored anchor fields from a resolved span in `text`. */
function anchorFieldsFromSpan(
  kind: AnchorKind,
  text: string,
  start: number,
  end: number,
): AnchorFields {
  const ctx = kind === "point" ? POINT_CONTEXT_CHARS : RANGE_CONTEXT_CHARS;
  return {
    quote: kind === "point" ? "" : text.slice(start, end),
    contextBefore: text.slice(Math.max(0, start - ctx), start),
    contextAfter: text.slice(end, end + ctx),
    sourceStart: start,
    sourceEnd: kind === "point" ? start : end,
  };
}

function anchorRecordOf(t: {
  anchorKind: string;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  sourceStart: number;
  sourceEnd: number;
}): AnchorRecord {
  return {
    kind: t.anchorKind === "point" ? "point" : "range",
    quote: t.quote,
    contextBefore: t.contextBefore,
    contextAfter: t.contextAfter,
    sourceStart: t.sourceStart,
    sourceEnd: t.sourceEnd,
  };
}

/** Current markdown + hash for a path, or null (deleted path / missing blob). */
async function readCurrent(
  workspaceId: string,
  path: string,
): Promise<{ text: string; hash: string; version: number } | null> {
  const db = usePrismaClient();
  const node = await db.fileNode.findUnique({
    where: { workspaceId_path: { workspaceId, path } },
    select: { contentHash: true, version: true },
  });
  if (!node) return null;
  // Content-addressed read: version-number reuse after move/delete can't serve
  // a stranger's bytes. Access was gated by the caller already.
  const blob = await useFileService().readByHash(workspaceId, node.contentHash);
  if (blob.status !== "ok") return null;
  return { text: decode(blob.body), hash: node.contentHash, version: node.version };
}

/**
 * Anchor status + current matching text for one thread against the current
 * content. Uses the cached resolution when `lastResolvedHash` matches, else
 * runs the resolver and best-effort CAS-updates the cache — guarded on the
 * previous hash value so two concurrent readers can't interleave a stale
 * write, OUTSIDE any transaction, emitting no event. The cache is pure
 * latency: nulling it changes no output (the fresh path computes the same
 * status and the same `currentText` slice).
 */
async function resolveThread(
  t: ThreadRow,
  current: { text: string; hash: string } | null,
): Promise<{ anchorStatus: AnchorStatus; currentText: string | null }> {
  // Deleted path (or unreadable current blob): every thread is outdated and no
  // resolution is attempted — never fabricate currentText.
  if (!current) return { anchorStatus: "outdated", currentText: null };

  if (t.lastResolvedHash === current.hash) {
    const cached: AnchorStatus =
      t.anchorStatus === "anchored" || t.anchorStatus === "ambiguous" ? t.anchorStatus : "outdated";
    const currentText =
      cached === "anchored" && t.resolvedStart !== null && t.resolvedEnd !== null
        ? current.text.slice(t.resolvedStart, t.resolvedEnd)
        : null;
    return { anchorStatus: cached, currentText };
  }

  const res = resolveAnchor(anchorRecordOf(t), current.text, current.hash);
  await usePrismaClient().commentThread.updateMany({
    where: { id: t.id, lastResolvedHash: t.lastResolvedHash },
    data: {
      lastResolvedHash: current.hash,
      resolvedStart: res.start ?? null,
      resolvedEnd: res.end ?? null,
      anchorStatus: res.status,
    },
  });
  return {
    anchorStatus: res.status,
    currentText: res.status === "anchored" ? (res.currentText ?? "") : null,
  };
}

/** The already-windowed slice of one thread's replies, plus its full size. */
interface EntryPage {
  shown: EntryRow[];
  /** Total entries on the thread — an index aggregate, not a row load. */
  total: number;
  /** Entries exist past the end of `shown`. */
  more: boolean;
}

function threadView(
  t: ThreadRow,
  resolution: { anchorStatus: AnchorStatus; currentText: string | null },
  entries: EntryPage,
): CommentThreadView {
  const shown = entries.shown;
  return {
    id: t.id,
    path: t.path,
    status: t.resolvedAt ? "resolved" : "open",
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    resolvedAtVersion: t.resolvedAtVersion,
    resolvedBy:
      t.resolvedAt && t.resolvedPrincipal
        ? {
            principal: t.resolvedPrincipal,
            actorId: t.resolvedActorId,
            actorKeyId: t.resolvedActorKeyId,
            actorLabel: t.resolvedActorLabel,
          }
        : null,
    anchorKind: t.anchorKind === "point" ? "point" : "range",
    quote: t.quote,
    contextBefore: t.contextBefore,
    contextAfter: t.contextAfter,
    pinnedVersion: t.pinnedVersion,
    anchorStatus: resolution.anchorStatus,
    currentText: resolution.currentText,
    createdBy: attribution(t),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    entries: shown.map(entryView),
    entryCount: entries.total,
    hasMoreEntries: entries.more,
  };
}

/**
 * One windowed page of replies for each of `threadIds`, plus each thread's full
 * entry count. A `ROW_NUMBER() OVER (PARTITION BY …)` picks the window, so the
 * bodies that cross the wire are bounded by `threads × limit` however long the
 * histories are. The count is a separate aggregate over the (threadId) index:
 * `entryCount`/`hasMoreEntries` stay exact without loading a row per reply.
 */
async function loadEntryPages(
  threadIds: string[],
  limit: number,
  offset: number,
): Promise<Map<string, EntryPage>> {
  const pages = new Map<string, EntryPage>();
  if (threadIds.length === 0) return pages;

  const counts = await usePrismaClient().commentEntry.groupBy({
    by: ["threadId"],
    where: { threadId: { in: threadIds } },
    _count: { _all: true },
  });
  const totals = new Map(counts.map((c) => [c.threadId, c._count._all]));

  // The window runs over IDS ONLY, then joins back for the rows inside it. The
  // obvious shape — ROW_NUMBER() over `e.*` — reads far worse than no paging at
  // all: the window's tuplestore has to flatten every row it buffers, which
  // detoasts every reply body in the partition before the rn filter discards
  // them. Selecting no body until the window has picked its 20 is the point.
  const rows =
    limit === 0
      ? []
      : await usePrismaClient().$queryRaw<(EntryRow & { rn: bigint })[]>`
          SELECT e.*, w.rn FROM "comment_entry" e
          JOIN (
            SELECT "id", ROW_NUMBER() OVER (
              PARTITION BY "threadId" ORDER BY "createdAt" ASC, "id" ASC
            ) AS rn
            FROM "comment_entry"
            WHERE "threadId" IN (${Prisma.join(threadIds)})
          ) w ON w."id" = e."id"
          WHERE w.rn > ${offset} AND w.rn <= ${offset + limit}`;
  // The window's ORDER BY governs `rn`, but the outer SELECT's row order is not
  // guaranteed — sort by the same key so the reply order is stable.
  rows.sort((a, b) => Number(a.rn - b.rn));

  for (const id of threadIds) pages.set(id, { shown: [], total: totals.get(id) ?? 0, more: false });
  for (const row of rows) pages.get(row.threadId)?.shown.push(row);
  for (const [id, page] of pages) {
    page.more = page.total > offset + page.shown.length;
    pages.set(id, page);
  }
  return pages;
}

// Validate a normalized comment path. Length shares the file routes' ceiling.
function pathTooLong(path: string): boolean {
  return path.length > NODE_PATH_MAX;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// ---------------------------------------------------------------------------
// listThreads
// ---------------------------------------------------------------------------

export interface ListThreadsArgs {
  workspaceId: string;
  actor: Actor;
  path?: string;
  threadId?: string;
  status?: ThreadStatus;
  anchorStatus?: AnchorStatus;
  /** Filter by the creating actor's user id. */
  author?: string;
  limit?: number;
  offset?: number;
  entriesLimit?: number;
  /** Skip this many replies per thread — how a caller pages past the cap. */
  entriesOffset?: number;
}

export type ListThreadsResult =
  | {
      status: "ok";
      threads: CommentThreadView[];
      total: number;
      /** Offset for the next page, or null when this page is the last. */
      nextOffset: number | null;
      /** `total` counts only a bounded scan — see ANCHOR_SCAN_CAP. */
      truncated: boolean;
    }
  | { status: "not_found" };

/** Prisma filter matching exactly the paths one ACL row governs (aclCovers). */
function coversFilter(acl: AclRow): Prisma.CommentThreadWhereInput {
  return acl.kind === "file"
    ? { path: acl.path }
    : { OR: [{ path: acl.path }, { path: { startsWith: `${acl.path}/` } }] };
}

/**
 * `canRead`, expressed as SQL, so a listing can page in the database instead of
 * loading every thread and filtering in memory. Mirrors acl.ts exactly: a path
 * is denied when the LONGEST restriction covering it grants the subject nothing,
 * so each deny row's exclusion is re-opened by any row the subject IS granted
 * nested beneath it (only a nested row can out-specify it, and a deeper deny row
 * contributes its own exclusion). Callers still run `canRead` over the page —
 * that filter must be a no-op, and is there so a divergence fails closed.
 */
function readableFilter(acls: AclRow[], viewer: Viewer): Prisma.CommentThreadWhereInput[] {
  if (viewer === "trusted") return [];
  // A role never narrows READ (viewers read), so the grants decide here, plus the
  // folder of the key the caller came in on.
  const folder = viewer?.keyScope?.folder;
  const inKeyFolder = folder ? [coversFilter({ path: folder, kind: "folder", grants: [] })] : [];
  const granted = (a: AclRow) => !!viewer?.userId && grantLevel(a, viewer.userId) !== "none";
  const deny = acls.filter((a) => !granted(a));
  const allow = acls.filter(granted);
  const denials = deny.map((d) => {
    const nested = allow.filter((a) => a.path.length > d.path.length && aclCovers(d, a.path));
    return {
      NOT: {
        AND: [
          coversFilter(d),
          ...(nested.length ? [{ NOT: { OR: nested.map(coversFilter) } }] : []),
        ],
      },
    };
  });
  return [...inKeyFolder, ...denials];
}

export async function listThreads(args: ListThreadsArgs): Promise<ListThreadsResult> {
  const db = usePrismaClient();
  const { workspaceId, actor } = args;
  const viewer = actor.access;
  const acls = await listWorkspaceAcls(workspaceId);

  let path: string | undefined;
  if (args.path !== undefined) {
    path = normalizePath(args.path);
    // Fail-as-404: a private path a non-reader queries is indistinguishable
    // from one with no threads at all — except it reads as not-found, so the
    // path's existence isn't disclosed by an empty-but-200 list.
    if (!canRead(acls, path, viewer)) return { status: "not_found" };
  }

  const where: Prisma.CommentThreadWhereInput = {
    workspaceId,
    ...(path ? { path } : {}),
    ...(args.threadId ? { id: args.threadId } : {}),
    ...(args.author ? { actorId: args.author } : {}),
    ...(args.status === "open"
      ? { resolvedAt: null }
      : args.status === "resolved"
        ? { resolvedAt: { not: null } }
        : {}),
    AND: readableFilter(acls, viewer),
  };
  const orderBy: Prisma.CommentThreadOrderByWithRelationInput[] = [
    { createdAt: "asc" },
    { id: "asc" },
  ];

  const limit = Math.min(Math.max(args.limit ?? DEFAULT_THREAD_LIMIT, 0), MAX_THREAD_LIMIT);
  const offset = Math.max(args.offset ?? 0, 0);
  const resolutions = new Map<string, { anchorStatus: AnchorStatus; currentText: string | null }>();

  // Resolve anchors per distinct path — one content read per path, cache-aware.
  const resolveAll = async (threads: ThreadRow[]) => {
    const byPath = new Map<string, ThreadRow[]>();
    for (const t of threads) {
      const list = byPath.get(t.path) ?? [];
      list.push(t);
      byPath.set(t.path, list);
    }
    for (const [p, group] of byPath) {
      const current = await readCurrent(workspaceId, p);
      for (const t of group) resolutions.set(t.id, await resolveThread(t, current));
    }
  };

  let page: ThreadRow[];
  let total: number;
  let truncated = false;

  if (args.anchorStatus === undefined) {
    // The common case: every filter is a column, so the page and the count are
    // both SQL. Only the returned page is ever resolved.
    const [rows, count] = await Promise.all([
      db.commentThread.findMany({ where, orderBy, skip: offset, take: limit }),
      db.commentThread.count({ where }),
    ]);
    page = rows.filter((t) => canRead(acls, t.path, viewer));
    total = count;
    await resolveAll(page);
  } else {
    // anchorStatus filters on the RESOLVED status, never the cached column
    // (which may describe a previous hash), so it can only be applied after
    // resolution — and therefore pages over a bounded scan, not in SQL.
    const scan = await db.commentThread.findMany({ where, orderBy, take: ANCHOR_SCAN_CAP });
    truncated = scan.length === ANCHOR_SCAN_CAP;
    const visible = scan.filter((t) => canRead(acls, t.path, viewer));
    await resolveAll(visible);
    const matched = visible.filter(
      (t) => resolutions.get(t.id)!.anchorStatus === args.anchorStatus,
    );
    total = matched.length;
    page = matched.slice(offset, offset + limit);
  }

  if (args.threadId !== undefined && total === 0) {
    // A thread id from another workspace already fell out of the scoped query;
    // a thread on a path this actor can't read reads the same: not found.
    return { status: "not_found" };
  }

  const entriesLimit = Math.min(
    Math.max(args.entriesLimit ?? DEFAULT_ENTRIES_LIMIT, 0),
    MAX_ENTRIES_LIMIT,
  );
  const entryPages = await loadEntryPages(
    page.map((t) => t.id),
    entriesLimit,
    Math.max(args.entriesOffset ?? 0, 0),
  );

  return {
    status: "ok",
    threads: page.map((t) =>
      threadView(
        t,
        resolutions.get(t.id)!,
        entryPages.get(t.id) ?? { shown: [], total: 0, more: false },
      ),
    ),
    total,
    nextOffset: page.length > 0 && offset + page.length < total ? offset + page.length : null,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

export interface CreateThreadArgs {
  workspaceId: string;
  actor: Actor;
  path: string;
  body: string;
  quote?: string;
  contextBefore?: string;
  contextAfter?: string;
  /** 1-based disambiguator when the quote appears more than once. */
  occurrence?: number;
  kind: AnchorKind;
  /** The version the quote was taken from (R15); omitted = current. */
  baseVersion?: number;
}

export type CreateThreadResult =
  | { status: "created"; thread: CommentThreadView }
  | { status: "not_found" }
  | { status: "not_markdown" }
  | { status: "invalid"; error: string }
  | { status: "content_unavailable" }
  | { status: "ambiguous"; occurrences: number }
  | { status: "anchor_not_found" }
  // The stated base version anchored, but the text has since drifted past what
  // the forward re-anchor will silently absorb — never guess a position.
  | { status: "conflict"; baseVersion: number; currentVersion: number; reason: string }
  // The workspace is read-only (lapsed or unpaid subscription): comments are
  // a write path and answer to the same gate as file writes.
  | { status: "read_only" };

export async function createThread(args: CreateThreadArgs): Promise<CreateThreadResult> {
  const db = usePrismaClient();
  const svc = useFileService();
  const { workspaceId, actor, kind } = args;

  if (kind !== "range" && kind !== "point") return { status: "invalid", error: "invalid_kind" };
  if (!args.body || byteLen(args.body) > MAX_BODY_BYTES) {
    return { status: "invalid", error: args.body ? "body_too_large" : "body_required" };
  }
  if (kind === "range" && !args.quote) return { status: "invalid", error: "quote_required" };
  if (args.quote && byteLen(args.quote) > MAX_QUOTE_BYTES) {
    return { status: "invalid", error: "quote_too_large" };
  }
  for (const ctx of [args.contextBefore, args.contextAfter]) {
    if (ctx && byteLen(ctx) > MAX_CONTEXT_BYTES) {
      return { status: "invalid", error: "context_too_large" };
    }
  }
  const path = normalizePath(args.path);
  if (pathTooLong(path)) return { status: "invalid", error: "path_too_long" };
  if (await workspaceReadOnly(workspaceId)) return { status: "read_only" };

  const acls = await listWorkspaceAcls(workspaceId);
  if (!canRead(acls, path, actor.access)) return { status: "not_found" };

  // Plain SELECT: the anchor work below is expensive and must not hold a lock.
  // The row is re-read under a lock inside the transaction (see below).
  const node = await db.fileNode.findUnique({
    where: { workspaceId_path: { workspaceId, path } },
    select: { id: true, contentHash: true, contentType: true, version: true },
  });
  if (!node) return { status: "not_found" };
  if (baseContentType(node.contentType) !== "text/markdown") return { status: "not_markdown" };

  const currentBlob = await svc.readByHash(workspaceId, node.contentHash);
  if (currentBlob.status !== "ok") return { status: "content_unavailable" };
  const currentText = decode(currentBlob.body);

  const input = {
    quote: args.quote ?? "",
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    occurrence: args.occurrence,
    kind,
  };

  let fields: AnchorFields | undefined;
  if (args.baseVersion !== undefined && args.baseVersion !== node.version) {
    // The client quoted an older version: anchor there first, then re-anchor
    // the recorded span forward to current. Meaning-changing drift (the span no
    // longer resolves, or resolves ambiguously) is a conflict, never a guess.
    const base = await svc.readVersion({
      workspaceId,
      path,
      version: args.baseVersion,
      viewer: actor.access,
    });
    if (base.status === "ok") {
      const baseMatch = resolveNewAnchor(input, decode(base.body));
      if (baseMatch.status === "ambiguous") {
        return { status: "ambiguous", occurrences: baseMatch.occurrences ?? 0 };
      }
      if (baseMatch.status === "not_found") return { status: "anchor_not_found" };
      const fwd = resolveAnchor(
        {
          kind,
          quote: baseMatch.quote ?? "",
          contextBefore: baseMatch.contextBefore ?? "",
          contextAfter: baseMatch.contextAfter ?? "",
          sourceStart: baseMatch.start!,
          sourceEnd: baseMatch.end!,
        },
        currentText,
        node.contentHash,
      );
      if (fwd.status !== "anchored") {
        return {
          status: "conflict",
          baseVersion: args.baseVersion,
          currentVersion: node.version,
          reason: fwd.status,
        };
      }
      fields = anchorFieldsFromSpan(kind, currentText, fwd.start!, fwd.end!);
    }
    // Base version unavailable (pre-pointer history, pruned blob): fall through
    // and anchor against current — the quote either matches there or fails
    // structurally, which is strictly more honest than a hard error.
  }

  if (!fields) {
    const match: CreateMatch = resolveNewAnchor(input, currentText);
    if (match.status === "ambiguous") {
      return { status: "ambiguous", occurrences: match.occurrences ?? 0 };
    }
    if (match.status === "not_found") return { status: "anchor_not_found" };
    fields = {
      quote: match.quote ?? "",
      contextBefore: match.contextBefore ?? "",
      contextAfter: match.contextAfter ?? "",
      sourceStart: match.start!,
      sourceEnd: match.end!,
    };
  }

  // Thread + first entry + change event commit together. The pin is the node
  // read above — if a writer lands between that read and this commit, the pin
  // describes the content the commenter actually saw, which is the point.
  const inserted = await db.$transaction(async (tx) => {
    // Serialize against move()/delete BEFORE touching comment_thread, the same
    // direction move() locks in, so the two orders can never form a cycle.
    // Without this a move can complete in the gap above and run its own
    // comment_thread re-path before this row exists, leaving the comment
    // attached to a path its file has left. A move blocked here instead waits,
    // then carries the thread across as it was always meant to.
    const locked = await tx.$queryRaw<{ id: string; version: number; contentType: string }[]>`
      SELECT "id", "version", "contentType" FROM "file_node"
      WHERE "workspaceId" = ${workspaceId} AND "path" = ${path}
      FOR UPDATE`;
    const live = locked[0];
    // Gone, or a different node at this path now (moved away, or deleted and
    // recreated): the file this comment was written on is not here any more, so
    // there is nothing to anchor to. A plain rewrite in the gap is NOT this
    // case — same node, new content — and keeps the documented pin behaviour.
    if (!live || live.id !== node.id) return null;
    // The markdown check above is also a read-then-act: a write can retype the
    // SAME node to text/plain in the gap. Identity alone would let the thread
    // through, and the web hides the Comments tab on a non-markdown file — the
    // thread would exist with no screen that shows it. Re-check under the lock
    // so a racing request lands on the same answer as a serial one.
    if (baseContentType(live.contentType) !== "text/markdown") return NOT_MARKDOWN;

    const t = await tx.commentThread.create({
      data: {
        workspaceId,
        path,
        anchorKind: kind,
        ...fields!,
        pinnedContentHash: node.contentHash,
        pinnedVersion: node.version,
        // Warm the resolution cache: against the pinned content the anchor is
        // anchored at its own recorded span, by construction.
        lastResolvedHash: node.contentHash,
        resolvedStart: fields!.sourceStart,
        resolvedEnd: fields!.sourceEnd,
        anchorStatus: "anchored",
        principal: actor.principal,
        actorId: actor.actorId,
        actorKeyId: actor.actorKeyId,
        actorLabel: actor.actorLabel,
      },
    });
    const e = await tx.commentEntry.create({
      data: {
        workspaceId,
        threadId: t.id,
        body: args.body,
        principal: actor.principal,
        actorId: actor.actorId,
        actorKeyId: actor.actorKeyId,
        actorLabel: actor.actorLabel,
      },
    });
    // The event carries the file's version as of the lock, not as of the read
    // above: a write that landed in between is already committed, and the feed
    // must name the version this comment is live against.
    await recordCommentEvent(tx, workspaceId, path, "comment_created", live.version, actor);
    return { thread: t, entry: e };
  });
  if (inserted === NOT_MARKDOWN) return { status: "not_markdown" };
  if (!inserted) return { status: "not_found" };

  return {
    status: "created",
    thread: threadView(
      inserted.thread,
      {
        anchorStatus: "anchored",
        currentText: kind === "point" ? "" : fields.quote,
      },
      { shown: [inserted.entry], total: 1, more: false },
    ),
  };
}

/**
 * Lock one thread row and return it as of the lock, or null when there is no
 * such thread in this workspace. Takes NO file_node lock, so a comment mutation
 * built on it sits entirely outside the file_node → comment_thread order and
 * cannot participate in a cycle with move().
 */
async function lockThread(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  threadId: string,
): Promise<ThreadRow | null> {
  const rows = await tx.$queryRaw<ThreadRow[]>`
    SELECT * FROM "comment_thread"
    WHERE "id" = ${threadId} AND "workspaceId" = ${workspaceId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

// Lock a thread and authorize its path at the mutation's linearization point,
// or null. A path read before the transaction is only a guess.
async function lockReadableThread(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  threadId: string,
  actor: Actor,
): Promise<ThreadRow | null> {
  const thread = await lockThread(tx, workspaceId, threadId);
  if (!thread) return null;
  return canRead(await listWorkspaceAcls(workspaceId), thread.path, actor.access) ? thread : null;
}

// ---------------------------------------------------------------------------
// replyToThread
// ---------------------------------------------------------------------------

export interface ReplyArgs {
  workspaceId: string;
  actor: Actor;
  threadId: string;
  body: string;
  /** Client-chosen idempotency key: a retried reply inserts once. */
  dedupeKey?: string;
}

export type ReplyResult =
  | { status: "ok"; entry: CommentEntryView; deduped: boolean }
  | { status: "not_found" }
  | { status: "invalid"; error: string }
  // The workspace is read-only (lapsed or unpaid subscription): comments are
  // a write path and answer to the same gate as file writes.
  | { status: "read_only" };

export async function replyToThread(args: ReplyArgs): Promise<ReplyResult> {
  const db = usePrismaClient();
  const { workspaceId, actor, threadId } = args;
  if (!args.body || byteLen(args.body) > MAX_BODY_BYTES) {
    return { status: "invalid", error: args.body ? "body_too_large" : "body_required" };
  }
  if (await workspaceReadOnly(workspaceId)) return { status: "read_only" };

  try {
    const entry = await db.$transaction(async (tx) => {
      // Lock the thread and authorize its path HERE, at the mutation's
      // linearization point. A path read before the transaction is a guess: a
      // move — especially one into a private folder — can land in between, and
      // the reply would commit against a file the actor can no longer read,
      // stamping the event with a path that has moved on. With the row locked,
      // move()'s own re-path either already happened (we see the new path) or
      // must wait for us (the path cannot change under the entry we insert).
      const thread = await lockReadableThread(tx, workspaceId, threadId, actor);
      if (!thread) return null; // foreign, unknown or unreadable: a plain miss
      // Plain SELECT for the event's version stamp — no row lock, so no
      // wait-for edge on file_node. Null only when the file is genuinely
      // deleted (a thread outlives its file and stays repliable).
      const node = await tx.fileNode.findUnique({
        where: { workspaceId_path: { workspaceId, path: thread.path } },
        select: { version: true },
      });
      const e = await tx.commentEntry.create({
        data: {
          workspaceId,
          threadId,
          body: args.body,
          dedupeKey: args.dedupeKey,
          principal: actor.principal,
          actorId: actor.actorId,
          actorKeyId: actor.actorKeyId,
          actorLabel: actor.actorLabel,
        },
      });
      await recordCommentEvent(
        tx,
        workspaceId,
        thread.path,
        "comment_replied",
        node?.version ?? null,
        actor,
      );
      return e;
    });
    if (!entry) return { status: "not_found" };
    return { status: "ok", entry: entryView(entry), deduped: false };
  } catch (err) {
    if (!isUniqueViolation(err) || !args.dedupeKey) throw err;
    // The (threadId, dedupeKey) unique closed a retry race: the transaction
    // (including its event) rolled back, so return the surviving entry as
    // success — one insert, one event, however many concurrent retries.
    const existing = await db.commentEntry.findUnique({
      where: { threadId_dedupeKey: { threadId, dedupeKey: args.dedupeKey } },
    });
    if (!existing) throw err;
    return { status: "ok", entry: entryView(existing), deduped: true };
  }
}

// ---------------------------------------------------------------------------
// setResolved
// ---------------------------------------------------------------------------

export interface SetResolvedArgs {
  workspaceId: string;
  actor: Actor;
  threadId: string;
  resolved: boolean;
}

export type SetResolvedResult =
  | {
      status: "ok";
      resolved: boolean;
      resolvedAt: string | null;
      resolvedAtVersion: number | null;
      resolvedBy: AttributionView | null;
      /** False when the thread was already in the requested state (no event). */
      changed: boolean;
    }
  | { status: "not_found" }
  // The workspace is read-only (lapsed or unpaid subscription): comments are
  // a write path and answer to the same gate as file writes.
  | { status: "read_only" };

export async function setResolved(args: SetResolvedArgs): Promise<SetResolvedResult> {
  const db = usePrismaClient();
  const { workspaceId, actor, threadId, resolved } = args;
  if (await workspaceReadOnly(workspaceId)) return { status: "read_only" };

  const present = (t: ThreadRow): Extract<SetResolvedResult, { status: "ok" }> => ({
    status: "ok",
    resolved: t.resolvedAt !== null,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    resolvedAtVersion: t.resolvedAtVersion,
    resolvedBy:
      t.resolvedAt && t.resolvedPrincipal
        ? {
            principal: t.resolvedPrincipal,
            actorId: t.resolvedActorId,
            actorKeyId: t.resolvedActorKeyId,
            actorLabel: t.resolvedActorLabel,
          }
        : null,
    changed: false,
  });

  const outcome = await db.$transaction(async (tx) => {
    // Same rule as replyToThread: lock the thread and authorize its path at the
    // mutation's linearization point, so a move into a private folder can't
    // slip in between the check and the flip.
    const thread = await lockReadableThread(tx, workspaceId, threadId, actor);
    if (!thread) return null;
    // Already in the target state: success, current state, no event. The row
    // lock — not a CAS predicate — is what makes this exact under concurrency:
    // two resolvers serialize, and only the one that finds the state unflipped
    // writes the single `comment_resolved`.
    if ((thread.resolvedAt !== null) === resolved) return { row: thread, changed: false };

    // Plain SELECT (no row lock) for the version stamp; null-safe, since a
    // deleted file leaves resolvedAtVersion null.
    const node = await tx.fileNode.findUnique({
      where: { workspaceId_path: { workspaceId, path: thread.path } },
      select: { version: true },
    });
    const updated = await tx.commentThread.update({
      where: { id: threadId },
      data: resolved
        ? {
            resolvedAt: new Date(),
            resolvedAtVersion: node?.version ?? null,
            resolvedPrincipal: actor.principal,
            resolvedActorId: actor.actorId ?? null,
            resolvedActorKeyId: actor.actorKeyId ?? null,
            resolvedActorLabel: actor.actorLabel ?? null,
          }
        : {
            resolvedAt: null,
            resolvedAtVersion: null,
            resolvedPrincipal: null,
            resolvedActorId: null,
            resolvedActorKeyId: null,
            resolvedActorLabel: null,
          },
    });
    await recordCommentEvent(
      tx,
      workspaceId,
      thread.path,
      resolved ? "comment_resolved" : "comment_reopened",
      node?.version ?? null,
      actor,
    );
    return { row: updated, changed: true };
  });

  if (!outcome) return { status: "not_found" };
  return { ...present(outcome.row), changed: outcome.changed };
}

// ---------------------------------------------------------------------------
// readPinnedContent
// ---------------------------------------------------------------------------

export type PinnedContentResult =
  | {
      status: "ok";
      body: Uint8Array;
      contentType: string;
      path: string;
      pinnedVersion: number;
    }
  | { status: "not_found" }
  // The pinned blob is genuinely gone (terminal — content-addressed, so it will
  // never come back under this hash). Routes map this to 410.
  | { status: "gone" };

export async function readPinnedContent(args: {
  workspaceId: string;
  actor: Actor;
  threadId: string;
}): Promise<PinnedContentResult> {
  const db = usePrismaClient();
  const { workspaceId, actor, threadId } = args;

  const thread = await db.commentThread.findFirst({ where: { id: threadId, workspaceId } });
  if (!thread) return { status: "not_found" };
  // Gate on the thread's CURRENT path — a thread carried onto a private path by
  // a move stops serving its pinned bytes to non-readers.
  if (!canRead(await listWorkspaceAcls(workspaceId), thread.path, actor.access)) {
    return { status: "not_found" };
  }

  const res = await useFileService().readByHash(workspaceId, thread.pinnedContentHash);
  if (res.status !== "ok") return { status: "gone" };
  return {
    status: "ok",
    body: res.body,
    contentType: res.contentType,
    path: thread.path,
    pinnedVersion: thread.pinnedVersion,
  };
}