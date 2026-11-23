import { Prisma, usePrismaClient } from "db";
import {
  ACCESS_OPS,
  FILE_OPS,
  MAX_RECOVERY_ACTIONS,
  type RecoveryAction,
  type RecoveryKind,
  type RecoveryOutcome,
  type RecoveryPreview,
  type RecoverySkip,
  type RecoverySkipReason,
  recoveryActionKey,
  type TrashItem,
} from "shared";
import {
  type AccessSubject,
  type AclRow,
  canRead,
  canWrite,
  decodeGrants,
  grantLevel,
  restrictionDiffers,
  listWorkspaceAcls,
} from "./acl";
import {
  type Actor,
  blobKeyFor,
  type FileService,
  type RestoreContentResult as ServiceRestoreResult,
  useFileService,
} from "./files";
import { normalizePath } from "./paths";
import { listMembersOfWorkspace } from "./members";
import { limitsForWorkspace } from "./quota";
import { useBlobStore } from "./storage";

// ---------------------------------------------------------------------------
// Recovery: the trash, point-in-time restore and undo, as one engine.
//
// No snapshots are kept, because none are needed. The change feed is an
// append-only log of every file change with its content hash, and bytes are
// content-addressed and never garbage-collected, so the state of any path at
// any moment is the last event for that path at or before it. Every recovery
// is the same four steps:
//
//   1. work out the target state of each path from the log (a planner below);
//   2. compare it with the live FileNodes;
//   3. preview the difference: what will be restored, recreated, deleted or
//      moved back, and what will be left alone and why;
//   4. apply it as ordinary changes through the file service.
//
// Step 4 is the point. Going through the one write path keeps the version
// check, attribution, the change feed and desktop/CLI sync working unchanged,
// and makes a recovery itself something that can be undone.
//
// Visibility: a recovery only ever touches what the person running it can see
// now, AND never brings back content from a moment when the file was private
// to somebody else (even if it has been shared since — what was written while
// private was never meant for them). Paths they can't see are left out
// entirely, never reported, so a recovery can't be used to discover them.
// ---------------------------------------------------------------------------

/** Ops that change what is at a path. Access and comment ops don't. */
const FILE_OP_LIST = Prisma.join([...FILE_OPS]);
/** Ops after which a path holds content. */
const CONTENT_OP_LIST = Prisma.join(["write", "move", "restore", "conflict"]);

/** Changes applied at once within one phase of an apply. */
const APPLY_CONCURRENCY = 8;
/** Blob lookups at once while previewing. */
const STAT_CONCURRENCY = 16;

/** A planned change, with what the apply needs and the preview doesn't show. */
export type PlannedAction =
  | {
      kind: "recreate";
      path: string;
      contentHash: string;
      size: number;
      /** The change that left the path empty: it must still be its last. */
      deletedAt: bigint | null;
      /** Who the content must stay private to, or null if it was shared. */
      keepPrivateTo: string | null;
    }
  | {
      kind: "restore";
      path: string;
      contentHash: string;
      size: number;
      baseVersion: number;
      currentSize: number;
      /**
       * Who the content must stay private to, or null if it was shared. A file
       * shared since gets its own private mark again.
       */
      keepPrivateTo: string | null;
    }
  | { kind: "delete"; path: string; baseVersion: number; size: number }
  | {
      kind: "move";
      from: string;
      path: string;
      baseVersion: number;
      size: number;
      currentSize: number;
      /** Content to put back after the move, when it changed as well. */
      contentHash: string | null;
      /** Who the file must stay private to at its old path, or null. */
      keepPrivateTo: string | null;
    };

export interface RecoveryPlan {
  actions: PlannedAction[];
  skipped: RecoverySkip[];
  /** Change-feed head when the plan was made. */
  head: bigint;
}

/** Describes the operation for its RecoveryOperation row and feed label. */
export interface OperationMeta {
  kind: RecoveryKind;
  scopePath?: string | null;
  targetAt?: Date | null;
  targetKeyId?: string | null;
  targetLabel?: string | null;
}

// ---------------------------------------------------------------------------
// Visibility, now and then
// ---------------------------------------------------------------------------

/** An access_revoked / access_granted event: who made a path private, when. */
export interface AccessEvent {
  path: string;
  op: string;
  actorId: string | null;
  seq: bigint;
  /** On an `access_granted`: who it's limited to from here (encodeGrants). */
  privateTo?: string | null;
}

/**
 * Who `path` was limited to at feed position `seq` (encodeGrants), or null if it
 * was visible to every member. Rebuilt from the access events: making a node
 * private records `access_revoked` by its owner, sharing it again `access_granted`,
 * which names the people when it's still limited to some.
 * The most specific private node covering the path wins, as in effectiveAcl.
 *
 * `events` must be in ascending seq order. A folder's event covers its subtree,
 * never a sibling that merely shares the prefix.
 *
 * Known gap: a private FILE that was moved carries its privacy to the new path
 * without an event, so its history at the new path reads as shared. Its
 * current privacy still applies (it's checked separately), so this only
 * matters once its owner has since shared it again.
 */
export function privateOwnerAt(events: AccessEvent[], path: string, seq: bigint): string | null {
  const state = new Map<string, string | null>();
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.path !== path && !path.startsWith(`${e.path}/`)) continue;
    state.set(e.path, e.op === "access_granted" ? e.privateTo || null : e.actorId);
  }
  let best: string | null = null;
  let bestOwner: string | null = null;
  for (const [aclPath, owner] of state) {
    if (owner === null) continue;
    if (best === null || aclPath.length > best.length) {
      best = aclPath;
      bestOwner = owner;
    }
  }
  return bestOwner;
}

/** What a user can see now, and what they could see before. */
export interface Visibility {
  subject: AccessSubject;
  userId: string;
  acls: AclRow[];
  access: AccessEvent[];
  /** When someone else first made anything private, or null if no one has. */
  othersPrivateFrom: bigint | null;
  /** When this user first made anything private, or null. */
  ownPrivateFrom: bigint | null;
}

/** Feed position of the first `access_revoked` matching `by`, or null. */
function firstRevoke(access: AccessEvent[], by: (e: AccessEvent) => boolean): bigint | null {
  return access.find((e) => e.op === "access_revoked" && by(e))?.seq ?? null;
}

export async function loadVisibility(
  workspaceId: string,
  subject: AccessSubject,
): Promise<Visibility> {
  const db = usePrismaClient();
  const { userId } = subject;
  const [acls, access] = await Promise.all([
    listWorkspaceAcls(workspaceId),
    db.changeEvent.findMany({
      where: { workspaceId, op: { in: [...ACCESS_OPS] } },
      select: { path: true, op: true, actorId: true, seq: true, privateTo: true },
      orderBy: { seq: "asc" },
    }),
  ]);
  return {
    subject,
    userId,
    acls,
    access,
    othersPrivateFrom: firstRevoke(access, (e) => e.actorId === null || e.actorId !== userId),
    ownPrivateFrom: userId ? firstRevoke(access, (e) => e.actorId === userId) : null,
  };
}

/** Was `path` private to someone other than this user at `seq`? */
export function privateToOtherAt(v: Visibility, path: string, seq: bigint): boolean {
  const owner = privateOwnerAt(v.access, path, seq);
  return owner !== null && grantLevel({ grants: decodeGrants(owner) }, v.userId) === "none";
}

/**
 * Was `path` made private or shared, itself or through a folder, after feed
 * position `seq`? A preview taken before that was of a different set of files.
 */
export function accessChangedAfter(v: Visibility, path: string, seq: bigint): boolean {
  return v.access.some((e) => e.seq > seq && (e.path === path || path.startsWith(`${e.path}/`)));
}

/** Can this user see `path` now? */
export function visibleNow(v: Visibility, path: string): boolean {
  return canRead(v.acls, path, v.subject);
}

/** Can this user change `path` now? Stricter: a viewer sees the trash but restores nothing. */
export function changeableNow(v: Visibility, path: string): boolean {
  return canWrite(v.acls, path, v.subject);
}

/**
 * Was this event's path private to someone other than this user when the
 * event was recorded? Events carry that on `privateTo`, which survives folder
 * renames and later sharing.
 *
 * Events recorded before that (`privateTo` null) can't be trusted to say: a
 * private folder that was renamed carried its privacy with it and left no
 * event behind. So they fail closed. Once anyone else has made anything
 * private, every older-style event after that point counts as possibly theirs.
 * All privacy starts with an `access_revoked` (conflicted copies and renames
 * only pass on privacy that already exists), so events from before that point
 * are known to be shared.
 */
export function privateToOther(
  v: Visibility,
  e: { path: string; seq: bigint; privateTo: string | null },
): boolean {
  if (e.privateTo === null) return v.othersPrivateFrom !== null && v.othersPrivateFrom < e.seq;
  if (e.privateTo === "") return false;
  return grantLevel({ grants: decodeGrants(e.privateTo) }, v.userId) === "none";
}

/**
 * Who content recorded by this event was private to, so it can be kept private
 * to them when it comes back. Older-style events fail closed here too: if this
 * user had made anything private by then, it might have been theirs.
 */
export function ownerWhen(
  v: Visibility,
  e: { seq: bigint; privateTo: string | null },
): string | null {
  if (e.privateTo !== null) return e.privateTo || null;
  return v.ownPrivateFrom !== null && v.ownPrivateFrom < e.seq ? v.userId : null;
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

export interface LogEvent {
  path: string;
  op: string;
  seq: bigint;
  version: number | null;
  contentHash: string | null;
  relatedPath: string | null;
  privateTo: string | null;
  principal: string;
  actorId: string | null;
  actorKeyId: string | null;
  actorLabel: string | null;
  createdAt: Date;
}

const LOG_COLUMNS = Prisma.sql`c.path, c.op, c.seq, c.version, c."contentHash", c."relatedPath", c."privateTo", c.principal, c."actorId", c."actorKeyId", c."actorLabel", c."createdAt"`;

/**
 * For each (path, before) pair, the last file event on that path strictly
 * before feed position `before`: the state the path was in just then.
 */
export async function lastEventsBefore(
  workspaceId: string,
  pairs: { path: string; before: bigint }[],
): Promise<Map<string, LogEvent>> {
  const db = usePrismaClient();
  const out = new Map<string, LogEvent>();
  for (let i = 0; i < pairs.length; i += 1000) {
    const chunk = pairs.slice(i, i + 1000);
    const rows = await db.$queryRaw<LogEvent[]>`
      SELECT DISTINCT ON (c.path) ${LOG_COLUMNS}
      FROM change_event c
      JOIN unnest(${chunk.map((p) => p.path)}::text[], ${chunk.map((p) => p.before.toString())}::bigint[])
        AS t(path, before) ON c.path = t.path AND c.seq < t.before
      WHERE c."workspaceId" = ${workspaceId} AND c.op IN (${FILE_OP_LIST})
      ORDER BY c.path, c.seq DESC`;
    for (const r of rows) out.set(r.path, r);
  }
  return out;
}

/** The feed's head: the newest event's position, or 0. */
export async function feedHead(workspaceId: string): Promise<bigint> {
  const agg = await usePrismaClient().changeEvent.aggregate({
    where: { workspaceId },
    _max: { seq: true },
  });
  return agg._max.seq ?? 0n;
}

/** Plaintext size of each recorded content hash, or null where the bytes can't be found. */
async function blobSizes(
  workspaceId: string,
  hashes: string[],
): Promise<Map<string, number | null>> {
  const storage = useBlobStore();
  const unique = [...new Set(hashes)];
  const out = new Map<string, number | null>();
  await pool(unique, STAT_CONCURRENCY, async (hash) => {
    const meta = await storage.stat(blobKeyFor(workspaceId, hash)).catch(() => null);
    out.set(hash, meta?.size ?? null);
  });
  return out;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

/**
 * Deleted files, newest deletion first. A path is in the trash when its last
 * file event is a real deletion (not the old half of a move) and nothing lives
 * there now. Nothing is stored for this: the trash is a view of the log.
 *
 * Retention: everything ever deleted stays listed. The bytes are kept anyway
 * (content-addressed, never garbage-collected) and don't count toward storage,
 * so an expiry would hide recoverable files without saving anything. A cutoff
 * is one extra condition here if that changes.
 */
type TrashRow = LogEvent & { restorable: boolean | null };

/** One page of trash candidates, before visibility filtering. */
function trashPage(
  workspaceId: string,
  before: bigint | null,
  prefix: string | null,
  page: number,
): Promise<TrashRow[]> {
  return usePrismaClient().$queryRaw<TrashRow[]>`
    SELECT ${LOG_COLUMNS},
      (SELECT p."contentHash" IS NOT NULL FROM change_event p
        WHERE p."workspaceId" = c."workspaceId" AND p.path = c.path AND p.seq < c.seq
          AND p.op IN (${CONTENT_OP_LIST})
        ORDER BY p.seq DESC LIMIT 1) AS restorable
    FROM change_event c
    WHERE c."workspaceId" = ${workspaceId}
      AND c.op = 'delete' AND c."relatedPath" IS NULL
      ${before !== null ? Prisma.sql`AND c.seq < ${before}` : Prisma.empty}
      ${prefix ? Prisma.sql`AND starts_with(c.path, ${prefix})` : Prisma.empty}
      AND NOT EXISTS (SELECT 1 FROM change_event l
        WHERE l."workspaceId" = c."workspaceId" AND l.path = c.path AND l.seq > c.seq
          AND l.op IN (${FILE_OP_LIST}))
      AND NOT EXISTS (SELECT 1 FROM file_node f
        WHERE f."workspaceId" = c."workspaceId" AND f.path = c.path)
    ORDER BY c.seq DESC
    LIMIT ${page}`;
}

function trashItem(r: TrashRow): TrashItem {
  return {
    path: r.path,
    deletedAt: r.createdAt.toISOString(),
    seq: Number(r.seq),
    principal: r.principal,
    actorId: r.actorId,
    actorKeyId: r.actorKeyId,
    actorLabel: r.actorLabel,
    restorable: r.restorable === true,
  };
}

export async function listTrash(args: {
  workspaceId: string;
  subject: AccessSubject;
  prefix?: string;
  limit?: number;
  before?: number;
}): Promise<{ items: TrashItem[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const prefix = args.prefix ? `${normalizePath(args.prefix)}/` : null;
  const vis = await loadVisibility(args.workspaceId, args.subject);
  // Hidden from this user now, or private to someone else when it was
  // deleted: for them it was never there.
  const visible = (r: TrashRow) => visibleNow(vis, r.path) && !privateToOther(vis, r);
  const items: TrashItem[] = [];
  let before = args.before !== undefined ? BigInt(args.before) : null;
  const page = Math.max(limit * 2, 100);

  for (;;) {
    const rows = await trashPage(args.workspaceId, before, prefix, page);
    for (const r of rows) {
      before = r.seq;
      if (!visible(r)) continue;
      items.push(trashItem(r));
      if (items.length === limit) return { items, nextBefore: Number(r.seq) };
    }
    if (rows.length < page) return { items, nextBefore: null };
  }
}

/** Is this in the trash, as far as this user can tell? */
function inTrashFor(
  vis: Visibility,
  path: string,
  ev: LogEvent | undefined,
  live: boolean,
): ev is LogEvent {
  if (!ev || ev.op !== "delete" || ev.relatedPath !== null || live) return false;
  return changeableNow(vis, path) && !privateToOther(vis, ev);
}

/** Why a path can't come out of the trash for this user, or null if it can. */
function trashSkip(
  vis: Visibility,
  path: string,
  ev: LogEvent | undefined,
  live: boolean,
  previewHead: bigint | undefined,
): RecoverySkipReason | null {
  // Invisible paths get the same answer as ones never deleted.
  if (!inTrashFor(vis, path, ev, live)) return "not_in_trash";
  // Deleted again since the preview: what's in the trash now isn't what the
  // person was shown.
  if (previewHead !== undefined && ev.seq > previewHead) return "changed";
  return restrictionDiffers(vis.acls, path, ownerWhen(vis, ev)) ? "access_changed" : null;
}

/** Plan bringing deleted files back from the trash, each as it was just before deletion. */
export async function planTrashRestore(args: {
  workspaceId: string;
  subject: AccessSubject;
  paths: string[];
  /** From the preview, on apply: a path changed after it is left alone. */
  previewHead?: bigint;
}): Promise<RecoveryPlan> {
  const { workspaceId } = args;
  const db = usePrismaClient();
  const paths = [...new Set(args.paths.map((p) => normalizePath(p)))];
  const head = await feedHead(workspaceId);
  const vis = await loadVisibility(workspaceId, args.subject);
  const skipped: RecoverySkip[] = [];

  const [last, live] = await Promise.all([
    lastEventsBefore(
      workspaceId,
      paths.map((path) => ({ path, before: head + 1n })),
    ),
    db.fileNode.findMany({
      where: { workspaceId, path: { in: paths } },
      select: { path: true },
    }),
  ]);
  const liveSet = new Set(live.map((n) => n.path));

  const deleted: { path: string; seq: bigint; owner: string | null }[] = [];
  for (const path of paths) {
    const ev = last.get(path);
    const reason = trashSkip(vis, path, ev, liveSet.has(path), args.previewHead);
    if (ev && !reason) deleted.push({ path, seq: ev.seq, owner: ownerWhen(vis, ev) });
    else skipped.push({ path, reason: reason ?? "not_in_trash" });
  }

  const before = await lastEventsBefore(
    workspaceId,
    deleted.map((d) => ({ path: d.path, before: d.seq })),
  );
  const content = deleted.map((d) => ({ ...d, hash: before.get(d.path)?.contentHash ?? null }));
  const sizes = await blobSizes(
    workspaceId,
    content.flatMap((c) => (c.hash ? [c.hash] : [])),
  );
  const actions: PlannedAction[] = [];
  for (const { path, hash, seq, owner } of content) {
    const size = hash ? sizes.get(hash) : null;
    if (!hash || size == null) {
      skipped.push({ path, reason: "unavailable" });
      continue;
    }
    actions.push({
      kind: "recreate",
      path,
      contentHash: hash,
      size,
      deletedAt: seq,
      keepPrivateTo: owner,
    });
  }
  return { actions, skipped, head };
}

// ---------------------------------------------------------------------------
// Point in time
// ---------------------------------------------------------------------------

/** The feed position of `at`: the last event at or before it, or 0. */
export async function cursorAt(workspaceId: string, at: Date): Promise<bigint> {
  const agg = await usePrismaClient().changeEvent.aggregate({
    where: { workspaceId, createdAt: { lte: at } },
    _max: { seq: true },
  });
  return agg._max.seq ?? 0n;
}

/** Every file event after `cursor` up to `head`, oldest first, grouped by path. */
export async function eventsAfter(
  workspaceId: string,
  cursor: bigint,
  head: bigint,
): Promise<Map<string, LogEvent[]>> {
  const rows = await usePrismaClient().$queryRaw<LogEvent[]>`
    SELECT ${LOG_COLUMNS} FROM change_event c
    WHERE c."workspaceId" = ${workspaceId} AND c.seq > ${cursor} AND c.seq <= ${head}
      AND c.op IN (${FILE_OP_LIST})
    ORDER BY c.seq ASC`;
  const byPath = new Map<string, LogEvent[]>();
  for (const r of rows) {
    const list = byPath.get(r.path);
    if (list) list.push(r);
    else byPath.set(r.path, [r]);
  }
  return byPath;
}

/** Is `path` the folder `scope` or inside it? Null scope is the whole workspace. */
export function inScope(path: string, scope: string | null): boolean {
  return scope === null || path.startsWith(`${scope}/`);
}

/**
 * Where the file that was at `path` at feed position `after` lives now, if it
 * was only moved (renamed) since, however many times, and never deleted. Null
 * when it's still at `path`, was deleted, or the trail is lost.
 */
export function lineageEnd(
  byPath: ReadonlyMap<string, LogEvent[]>,
  path: string,
  after: bigint,
): string | null {
  let cur = path;
  let since = after;
  for (let hop = 0; hop < 100; hop++) {
    const gone = (byPath.get(cur) ?? []).find((e) => e.seq > since && e.op === "delete");
    if (!gone) return cur === path ? null : cur;
    const to = gone.relatedPath;
    if (to === null) return null; // deleted, not moved
    const arrived = (byPath.get(to) ?? []).find(
      (e) => e.seq > gone.seq && e.op === "move" && e.relatedPath === cur,
    );
    if (!arrived) return null;
    cur = to;
    since = arrived.seq;
  }
  return null;
}

interface LiveNode {
  path: string;
  version: number;
  size: number;
  contentHash: string;
}

async function liveNodes(workspaceId: string, paths: string[]): Promise<Map<string, LiveNode>> {
  const db = usePrismaClient();
  const out = new Map<string, LiveNode>();
  for (let i = 0; i < paths.length; i += 1000) {
    const rows = await db.fileNode.findMany({
      where: { workspaceId, path: { in: paths.slice(i, i + 1000) } },
      select: { path: true, version: true, size: true, contentHash: true },
    });
    for (const r of rows) out.set(r.path, r);
  }
  return out;
}

/**
 * Did `path` change after the preview at `previewHead`: its content, or who
 * can see it (a file shared with the runner since was never in their preview)?
 */
function changedAfter(
  vis: Visibility,
  byPath: ReadonlyMap<string, LogEvent[]>,
  path: string,
  previewHead: bigint,
): boolean {
  return lastSeq(byPath.get(path)) > previewHead || accessChangedAfter(vis, path, previewHead);
}

/** The newest event's position in a path's list, or 0. */
function lastSeq(events: LogEvent[] | undefined): bigint {
  return events?.[events.length - 1]?.seq ?? 0n;
}

/** What one path should go back to, against what it is now. */
export interface PathTarget {
  path: string;
  /**
   * Content the path had at the target, and who it was private to then (null
   * when shared), or null when it didn't exist then.
   */
  target: { contentHash: string | null; owner: string | null } | null;
  live: LiveNode | null;
}

/**
 * Turn per-path targets into a plan: restore, recreate or delete each path
 * whose content differs, and pair a recreate with a delete when they're the
 * same file renamed (so it's moved back, keeping its comments and history).
 * Shared by point-in-time restore and undo.
 */
export async function diffTargets(args: {
  workspaceId: string;
  targets: PathTarget[];
  byPath: ReadonlyMap<string, LogEvent[]>;
  /** The feed position each path is being put back to. */
  seqFor: (path: string) => bigint;
  skipped: RecoverySkip[];
  /**
   * Paths left out because this user can't see them. Never reported, but a
   * file renamed to or from one of them is held back with it.
   */
  hidden: ReadonlySet<string>;
  acls: AclRow[];
  head: bigint;
}): Promise<RecoveryPlan> {
  const { skipped } = args;
  // A live file that doesn't match the last event the plan read changed in
  // between (after the head was taken): leave it, rather than act on a
  // version nobody previewed.
  const targets: PathTarget[] = [];
  for (const t of args.targets) {
    if (!liveMatchesLog(t, args.byPath)) skipped.push({ path: t.path, reason: "changed" });
    else if (accessChanged(t, args)) skipped.push({ path: t.path, reason: "access_changed" });
    else targets.push(t);
  }
  const sizes = await blobSizes(
    args.workspaceId,
    targets.flatMap((t) => (t.target?.contentHash ? [t.target.contentHash] : [])),
  );
  const { restores, recreates, deletes } = stepsFor(targets, sizes, args.byPath, skipped);
  holdNamesTaken(targets, args.byPath, args.seqFor, skipped);
  holdRenameGroups({ skipped, hidden: args.hidden, byPath: args.byPath }, [
    restores,
    recreates,
    deletes,
  ]);
  const moves = pairRenames(recreates, deletes, targets, args.byPath, args.seqFor);
  return {
    actions: [...moves, ...restores.values(), ...recreates.values(), ...deletes.values()],
    skipped,
    head: args.head,
  };
}

/** Each target's step, sorted by kind; paths that can't be put back go to `skipped`. */
function stepsFor(
  targets: PathTarget[],
  sizes: Map<string, number | null>,
  byPath: ReadonlyMap<string, LogEvent[]>,
  skipped: RecoverySkip[],
) {
  const restores = new Map<string, PlannedAction>();
  const recreates = new Map<string, Extract<PlannedAction, { kind: "recreate" }>>();
  const deletes = new Map<string, Extract<PlannedAction, { kind: "delete" }>>();
  for (const t of targets) {
    const step = stepFor(t, sizes, byPath.get(t.path)?.at(-1)?.seq ?? null);
    if (!step) continue;
    if ("reason" in step) skipped.push(step);
    else if (step.kind === "delete") deletes.set(step.path, step);
    else if (step.kind === "recreate") recreates.set(step.path, step);
    else restores.set(step.path, step);
  }
  return { restores, recreates, deletes };
}

/** Would putting this back leave it with different people on it? A rename counts. */
function accessChanged(
  { path, target, live }: PathTarget,
  args: { acls: AclRow[]; byPath: ReadonlyMap<string, LogEvent[]>; seqFor: (p: string) => bigint },
): boolean {
  if (!target || live?.contentHash === target.contentHash) return false;
  const now = live ? path : (lineageEnd(args.byPath, path, args.seqFor(path)) ?? path);
  return restrictionDiffers(args.acls, path, target.owner, now);
}

/** Does the live file match the newest event read for its path? */
function liveMatchesLog(t: PathTarget, byPath: ReadonlyMap<string, LogEvent[]>): boolean {
  const last = byPath.get(t.path)?.at(-1);
  if (!last) return true;
  if (last.op === "delete") return t.live === null;
  if (!t.live || t.live.version !== last.version) return false;
  return last.contentHash === null || last.contentHash === t.live.contentHash;
}

/**
 * A file renamed since, whose old name another file has taken, is left alone
 * (and, through holdRenameGroups, so is everything renamed with it). Putting
 * its old content back would mean rewriting the newcomer's bytes in place and
 * deleting or rewriting the renamed file, so comments and history would stay
 * on the wrong files. A swap (a to b and b to a) is the same thing twice.
 */
function holdNamesTaken(
  targets: PathTarget[],
  byPath: ReadonlyMap<string, LogEvent[]>,
  seqFor: (path: string) => bigint,
  skipped: RecoverySkip[],
): void {
  const reported = new Set(skipped.map((s) => s.path));
  for (const t of targets) {
    if (!t.live || !t.target || reported.has(t.path)) continue;
    if (lineageEnd(byPath, t.path, seqFor(t.path))) {
      skipped.push({ path: t.path, reason: "name_taken" });
    }
  }
}

/**
 * Keep renamed files whole. Every path linked by a rename since the moment
 * (any number of hops, by anyone) is one group. If any path in a group is left
 * alone (changed since the preview, private, unrecorded, someone else's later
 * edit) or hidden from this user, every path in the group is: putting back
 * only part of a rename would delete the renamed file without bringing back
 * the original, or leave a duplicate. Hidden paths stay unreported; the
 * others are listed as `linked`.
 */
function holdRenameGroups(
  args: {
    skipped: RecoverySkip[];
    hidden: ReadonlySet<string>;
    byPath: ReadonlyMap<string, LogEvent[]>;
  },
  steps: Map<string, unknown>[],
): void {
  const links = renameLinks(args.byPath);
  const reported = new Set(args.skipped.map((s) => s.path));
  const queue = [...reported, ...args.hidden];
  const held = new Set(queue);
  while (queue.length) {
    for (const next of links.get(queue.pop()!) ?? []) {
      if (held.has(next)) continue;
      held.add(next);
      queue.push(next);
    }
  }
  for (const path of held) {
    if (!steps.some((m) => m.delete(path))) continue;
    if (!reported.has(path) && !args.hidden.has(path)) {
      args.skipped.push({ path, reason: "linked" });
    }
  }
}

/** Both ends of every rename in the events read: path → the paths it was renamed to or from. */
function renameLinks(byPath: ReadonlyMap<string, LogEvent[]>): Map<string, string[]> {
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => links.set(a, [...(links.get(a) ?? []), b]);
  for (const events of byPath.values()) {
    for (const e of events) {
      if (e.op === "move" && e.relatedPath) {
        link(e.path, e.relatedPath);
        link(e.relatedPath, e.path);
      }
    }
  }
  return links;
}

/** What one path needs to reach its target: a change, a skip, or nothing. */
function stepFor(
  { path, target, live }: PathTarget,
  sizes: Map<string, number | null>,
  lastChange: bigint | null,
): PlannedAction | RecoverySkip | null {
  if (!target) {
    return live ? { kind: "delete", path, baseVersion: live.version, size: live.size } : null;
  }
  if (live && live.contentHash === target.contentHash) return null;
  const hash = target.contentHash;
  const size = hash ? sizes.get(hash) : null;
  if (!hash || size == null) return { path, reason: "unavailable" };
  const keepPrivateTo = target.owner;
  if (!live) {
    return {
      kind: "recreate",
      path,
      contentHash: hash,
      size,
      deletedAt: lastChange,
      keepPrivateTo,
    };
  }
  return {
    kind: "restore",
    path,
    contentHash: hash,
    size,
    baseVersion: live.version,
    currentSize: live.size,
    keepPrivateTo,
  };
}

/** Pull renamed-file pairs out of `recreates` and `deletes`, as moves back. */
function pairRenames(
  recreates: Map<string, Extract<PlannedAction, { kind: "recreate" }>>,
  deletes: Map<string, Extract<PlannedAction, { kind: "delete" }>>,
  targets: PathTarget[],
  byPath: ReadonlyMap<string, LogEvent[]>,
  seqFor: (path: string) => bigint,
): PlannedAction[] {
  const live = new Map(targets.flatMap((t) => (t.live ? [[t.path, t.live] as const] : [])));
  const moves: PlannedAction[] = [];
  for (const [path, rec] of recreates) {
    // Followed from the point this path goes back to, so it traces the file
    // being restored, not an earlier occupant of the same name.
    const now = lineageEnd(byPath, path, seqFor(path));
    const node = now ? live.get(now) : undefined;
    if (!now || !node || !deletes.has(now)) continue;
    deletes.delete(now);
    recreates.delete(path);
    moves.push({
      kind: "move",
      from: now,
      path,
      baseVersion: node.version,
      size: rec.size,
      currentSize: node.size,
      contentHash: node.contentHash === rec.contentHash ? null : rec.contentHash,
      keepPrivateTo: rec.keepPrivateTo,
    });
  }
  return moves;
}

/**
 * Each path's target at feed position `cursor`, leaving out what was never
 * this user's to see. A file private to someone else at that moment, or whose
 * content arrived while it was, never comes back through them, even if the
 * folder has been shared (or renamed) since: the event's own stamp survives
 * renames, and the access events cover privacy set later. Its later name, if
 * it was renamed, is left alone with it, so the restore never deletes the
 * renamed file while declining to bring back the original.
 */
function targetsAt(args: TargetArgs): PathTarget[] {
  const hidden = hiddenThen(args);
  const targets: PathTarget[] = [];
  for (const path of args.paths) {
    if (hidden.has(path)) {
      args.skipped.push({ path, reason: "private_then" });
      continue;
    }
    const ev = existedAt(args.atThen, path);
    targets.push({
      path,
      target: ev ? { contentHash: ev.contentHash, owner: ownerThen(args, path, ev) } : null,
      live: args.live.get(path) ?? null,
    });
  }
  return targets;
}

interface TargetArgs {
  paths: string[];
  atThen: Map<string, LogEvent>;
  live: Map<string, LiveNode>;
  vis: Visibility;
  /** The feed position each path is being put back to. */
  seqFor: (path: string) => bigint;
  byPath: ReadonlyMap<string, LogEvent[]>;
  skipped: RecoverySkip[];
}

/**
 * Who a path's content must stay private to once it's back: whoever it was
 * private to when the content arrived, or at the moment restored to.
 */
function ownerThen(args: TargetArgs, path: string, ev: LogEvent): string | null {
  return ownerWhen(args.vis, ev) ?? privateOwnerAt(args.vis.access, path, args.seqFor(path));
}

/** The event a path's state came from then, if it existed. */
function existedAt(atThen: Map<string, LogEvent>, path: string): LogEvent | null {
  const ev = atThen.get(path);
  return ev && ev.op !== "delete" ? ev : null;
}

/** Paths whose earlier content this user may not bring back, and their later names. */
function hiddenThen(args: TargetArgs): Set<string> {
  const { vis, seqFor } = args;
  const hidden = new Set<string>();
  for (const path of args.paths) {
    const ev = existedAt(args.atThen, path);
    if (!ev || args.live.get(path)?.contentHash === ev.contentHash) continue;
    if (privateToOther(vis, ev) || privateToOtherAt(vis, path, seqFor(path))) hidden.add(path);
  }
  for (const path of Array.from(hidden)) {
    const renamed = lineageEnd(args.byPath, path, seqFor(path));
    if (renamed) hidden.add(renamed);
  }
  return hidden;
}

/**
 * The paths that haven't changed since the preview (every path, when there's
 * no preview yet). The others are reported as `changed`.
 */
function unchangedSincePreview(
  paths: string[],
  byPath: ReadonlyMap<string, LogEvent[]>,
  vis: Visibility,
  previewHead: bigint | undefined,
  skipped: RecoverySkip[],
): string[] {
  if (previewHead === undefined) return paths;
  return paths.filter((path) => {
    const fresh = !changedAfter(vis, byPath, path, previewHead);
    if (!fresh) skipped.push({ path, reason: "changed" });
    return fresh;
  });
}

/** Each path's target, as it was at feed position `seqFor(path)`, against what it is now. */
async function targetsFor(args: {
  workspaceId: string;
  paths: string[];
  seqFor: (path: string) => bigint;
  vis: Visibility;
  byPath: ReadonlyMap<string, LogEvent[]>;
  skipped: RecoverySkip[];
}): Promise<PathTarget[]> {
  const [atThen, live] = await Promise.all([
    lastEventsBefore(
      args.workspaceId,
      args.paths.map((path) => ({ path, before: args.seqFor(path) + 1n })),
    ),
    liveNodes(args.workspaceId, args.paths),
  ]);
  return targetsAt({ ...args, atThen, live });
}

/**
 * Plan putting a folder (or the whole workspace) back the way it was at `at`.
 * Only paths that changed since then are looked at. A path inside the folder
 * comes back as it was; one created since is deleted (to the trash); a file
 * renamed within the folder is moved back. Nothing outside the folder is
 * touched, including a sibling that merely shares its name's start.
 *
 * With `previewHead`, anything that changed after that preview is skipped as
 * `changed` rather than acted on unseen.
 */
export async function planPointInTime(args: {
  workspaceId: string;
  subject: AccessSubject;
  scope: string | null;
  at: Date;
  previewHead?: bigint;
}): Promise<RecoveryPlan> {
  const { workspaceId } = args;
  const scope = args.scope ? normalizePath(args.scope) : null;
  const head = await feedHead(workspaceId);
  const cursor = await cursorAt(workspaceId, args.at);
  const [byPath, vis] = await Promise.all([
    eventsAfter(workspaceId, cursor, head),
    loadVisibility(workspaceId, args.subject),
  ]);
  const skipped: RecoverySkip[] = [];
  // Out of scope, or not visible to this user now: not theirs to touch, and
  // not reported either.
  const inScopeNow = [...byPath.keys()].filter((path) => inScope(path, scope));
  const hidden = new Set(inScopeNow.filter((path) => !changeableNow(vis, path)));
  const paths = unchangedSincePreview(
    inScopeNow.filter((path) => !hidden.has(path)),
    byPath,
    vis,
    args.previewHead,
    skipped,
  );
  const seqFor = () => cursor;
  const targets = await targetsFor({ workspaceId, paths, seqFor, vis, byPath, skipped });
  return diffTargets({
    workspaceId,
    targets,
    byPath,
    seqFor,
    skipped,
    acls: vis.acls,
    hidden,
    head,
  });
}

// ---------------------------------------------------------------------------
// Undo one key's changes
// ---------------------------------------------------------------------------

/** Who made an event, for "someone else changed it afterwards (…)". */
function whoMade(e: LogEvent, names: ReadonlyMap<string, string>): string {
  if (e.principal === "agent") return e.actorLabel ?? "an agent";
  return (e.actorId && names.get(e.actorId)) || "someone";
}

/** Where a key's changes start on each path it touched, and who changed it after. */
interface KeyTouches {
  /** Paths only this key changed since its first change there: path → that first change. */
  first: Map<string, bigint>;
  /** Paths someone else changed after the key did: path → who. */
  editedLater: Map<string, string>;
  /** The other end of each move the key made, both ways: path → paths. */
  renames: Map<string, string[]>;
  /** The key's name, as its latest event recorded it. */
  label: string | null;
}

function keyTouches(
  byPath: ReadonlyMap<string, LogEvent[]>,
  keyId: string,
  names: ReadonlyMap<string, string>,
): KeyTouches {
  const out: KeyTouches = {
    first: new Map(),
    editedLater: new Map(),
    renames: new Map(),
    label: null,
  };
  let latest = -1n;
  for (const [path, events] of byPath) {
    const mine = events.filter((e) => e.actorKeyId === keyId);
    const first = mine[0];
    if (!first) continue;
    const last = mine[mine.length - 1]!;
    if (last.seq > latest) {
      latest = last.seq;
      out.label = last.actorLabel;
    }
    const ends = mine.flatMap((e) => (e.relatedPath ? [e.relatedPath] : []));
    if (ends.length) out.renames.set(path, ends);
    const others = events.filter((e) => e.seq > first.seq && e.actorKeyId !== keyId);
    if (others.length) {
      out.editedLater.set(path, [...new Set(others.map((e) => whoMade(e, names)))].join(", "));
    } else out.first.set(path, first.seq);
  }
  return out;
}

/**
 * A rename is one change with two ends (and a chain of renames, one change
 * with several). If someone else changed any of them afterwards, all are left
 * alone: putting back only part would delete the renamed file or duplicate it.
 */
function holdRenamePairs(touches: KeyTouches): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const path of touches.first.keys()) {
      const held = (touches.renames.get(path) ?? []).find((end) => touches.editedLater.has(end));
      if (held === undefined) continue;
      touches.first.delete(path);
      touches.editedLater.set(path, touches.editedLater.get(held)!);
      changed = true;
    }
  }
}

/**
 * Plan undoing everything one API key changed since `since`. Each path it
 * touched goes back to how it was just before the key's first change there.
 *
 * Never over someone else's work: a path that anyone else changed after the
 * key did is left alone and listed (`edited_later`, naming who), rather than
 * reverted or kept as a conflicted copy. Both would leave that person to
 * notice and untangle it; this way their work stands, and the preview says
 * exactly which files to look at by hand.
 */
export async function planUndo(args: {
  workspaceId: string;
  subject: AccessSubject;
  keyId: string;
  since: Date;
  previewHead?: bigint;
}): Promise<RecoveryPlan & { label: string | null }> {
  const { workspaceId } = args;
  const head = await feedHead(workspaceId);
  const cursor = await cursorAt(workspaceId, args.since);
  const [byPath, vis, members] = await Promise.all([
    eventsAfter(workspaceId, cursor, head),
    loadVisibility(workspaceId, args.subject),
    listMembersOfWorkspace(workspaceId),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const touches = keyTouches(byPath, args.keyId, names);
  holdRenamePairs(touches);

  const skipped: RecoverySkip[] = [];
  // Not visible to this user now: not theirs to touch, and not reported.
  const hidden = new Set(
    [...touches.first.keys(), ...touches.editedLater.keys()].filter((p) => !changeableNow(vis, p)),
  );
  for (const [path, who] of touches.editedLater) {
    if (!hidden.has(path)) skipped.push({ path, reason: "edited_later", detail: who });
  }
  const paths = unchangedSincePreview(
    [...touches.first.keys()].filter((path) => !hidden.has(path)),
    byPath,
    vis,
    args.previewHead,
    skipped,
  );
  const seqFor = (path: string) => (touches.first.get(path) ?? cursor + 1n) - 1n;
  const targets = await targetsFor({ workspaceId, paths, seqFor, vis, byPath, skipped });
  const plan = await diffTargets({
    workspaceId,
    targets,
    byPath,
    seqFor,
    skipped,
    acls: vis.acls,
    hidden,
    head,
  });
  return { ...plan, label: touches.label };
}

// ---------------------------------------------------------------------------
// Limits, preview, apply
// ---------------------------------------------------------------------------

const PHASES: PlannedAction["kind"][] = ["delete", "move", "restore", "recreate"];

/**
 * Apply order: deletions first, so the space and file slots they free are
 * available to what's brought back; recreations last.
 */
function byPhase(actions: PlannedAction[]): PlannedAction[][] {
  return PHASES.map((kind) => actions.filter((a) => a.kind === kind));
}

type Limits = Awaited<ReturnType<typeof limitsForWorkspace>>;

/** Running totals while walking a plan in apply order. */
export interface Usage {
  bytes: number;
  files: number;
}

/** Does this action put content back (and so count as a new or changed file)? */
function addsContent(a: PlannedAction): a is Exclude<PlannedAction, { kind: "delete" }> {
  return a.kind !== "delete" && (a.kind !== "move" || a.contentHash !== null);
}

/** How much this action grows the workspace's storage. */
function growth(a: PlannedAction): number {
  if (a.kind === "delete") return -a.size;
  if (a.kind === "recreate") return a.size;
  return addsContent(a) ? a.size - a.currentSize : 0;
}

/** A limit any content going back must respect, whatever else is in the plan. */
function contentBlock(a: PlannedAction, limits: Limits): RecoverySkipReason | null {
  if (limits.readOnly) return "read_only";
  return a.size > limits.maxFileBytes ? "too_large" : null;
}

function overFileLimit(a: PlannedAction, used: Usage, limits: Limits): boolean {
  return a.kind === "recreate" && limits.files != null && used.files + 1 > limits.files;
}

function overStorage(a: PlannedAction, used: Usage, limits: Limits): boolean {
  if (limits.storageBytes == null) return false;
  const grows = growth(a);
  return grows > 0 && used.bytes + grows > limits.storageBytes;
}

/** The limit this action would break given what's used so far, or null if it fits. */
export function limitBlocking(
  a: PlannedAction,
  used: Usage,
  limits: Limits,
): RecoverySkipReason | null {
  if (!addsContent(a)) return null;
  const blocked = contentBlock(a, limits);
  if (blocked) return blocked;
  if (overFileLimit(a, used, limits)) return "file_limit";
  return overStorage(a, used, limits) ? "storage_limit" : null;
}

/**
 * Drop the actions that would take the workspace over a plan limit, walking
 * them in apply order against the current usage. They're reported as skipped
 * rather than failing the whole operation. Apply checks each one again.
 */
export async function fitToLimits(workspaceId: string, plan: RecoveryPlan): Promise<RecoveryPlan> {
  const limits = await limitsForWorkspace(workspaceId);
  const db = usePrismaClient();
  const [usage, files] = await Promise.all([
    db.fileNode.aggregate({ where: { workspaceId }, _sum: { size: true } }),
    db.fileNode.count({ where: { workspaceId } }),
  ]);
  const used: Usage = { bytes: usage._sum.size ?? 0, files };
  const actions: PlannedAction[] = [];
  const skipped = [...plan.skipped];

  for (const a of byPhase(plan.actions).flat()) {
    const blocked = limitBlocking(a, used, limits);
    if (blocked) {
      skipped.push({ path: a.path, reason: blocked });
      continue;
    }
    used.bytes += growth(a);
    if (a.kind === "recreate") used.files += 1;
    if (a.kind === "delete") used.files -= 1;
    actions.push(a);
  }
  return { ...plan, actions, skipped };
}

function view(a: PlannedAction): RecoveryAction {
  switch (a.kind) {
    case "recreate":
      return { kind: "recreate", path: a.path, size: a.size };
    case "restore":
      return { kind: "restore", path: a.path, size: a.size, version: a.baseVersion };
    case "delete":
      return { kind: "delete", path: a.path, size: a.size, version: a.baseVersion };
    case "move":
      return {
        kind: "move",
        from: a.from,
        path: a.path,
        size: a.size,
        restoresContent: a.contentHash !== null,
      };
  }
}

/**
 * Hold an apply to the changes its preview showed: `approved` holds their
 * `recoveryActionKey`s. Anything else it would now do, because a limit freed up
 * or a file became visible since, say, is left alone as `not_previewed`.
 */
export function onlyApproved(plan: RecoveryPlan, approved: Set<string> | undefined): RecoveryPlan {
  if (!approved) return plan;
  const actions: PlannedAction[] = [];
  const skipped = [...plan.skipped];
  for (const a of plan.actions) {
    if (approved.has(recoveryActionKey(view(a)))) actions.push(a);
    else skipped.push({ path: a.path, reason: "not_previewed" });
  }
  return { ...plan, actions, skipped };
}

export function previewOf(plan: RecoveryPlan): RecoveryPreview {
  return {
    actions: byPhase(plan.actions).flat().map(view),
    skipped: plan.skipped,
    previewHead: Number(plan.head),
    tooLarge: plan.actions.length > MAX_RECOVERY_ACTIONS,
  };
}

/** A file-service result that didn't land, as the reason it's reported under. */
function skipReasonFor(res: Exclude<ServiceRestoreResult, { status: "ok" }>): RecoverySkipReason {
  switch (res.status) {
    case "blob_missing":
      return "unavailable";
    case "forbidden":
    case "changed":
      return "changed";
    case "limit":
      return res.limit === "storage"
        ? "storage_limit"
        : res.limit === "files"
          ? "file_limit"
          : res.limit === "size"
            ? "too_large"
            : "read_only";
  }
}

interface ApplyContext {
  workspaceId: string;
  actor: Actor;
  applied: RecoveryAction[];
  skipped: RecoverySkip[];
}

type Runner<K extends PlannedAction["kind"]> = (
  ctx: ApplyContext,
  a: Extract<PlannedAction, { kind: K }>,
) => Promise<void>;

function putBack(
  ctx: ApplyContext,
  put: Omit<Parameters<FileService["restoreContent"]>[0], "workspaceId" | "actor">,
) {
  return useFileService().restoreContent({
    ...put,
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
  });
}

/** Record the result of putting content back. */
function settle(ctx: ApplyContext, a: PlannedAction, res: ServiceRestoreResult): void {
  if (res.status === "ok") ctx.applied.push(view(a));
  else ctx.skipped.push({ path: a.path, reason: skipReasonFor(res) });
}

/** One function per kind of change, each a single file-service call (two for a move). */
const RUNNERS: { [K in PlannedAction["kind"]]: Runner<K> } = {
  async delete(ctx, a) {
    const res = await useFileService().remove({
      workspaceId: ctx.workspaceId,
      path: a.path,
      baseVersion: a.baseVersion,
      actor: ctx.actor,
    });
    if (res.status === "ok") ctx.applied.push(view(a));
    else ctx.skipped.push({ path: a.path, reason: "changed" });
  },
  async move(ctx, a) {
    const res = await useFileService().move({
      workspaceId: ctx.workspaceId,
      from: a.from,
      to: a.path,
      baseVersion: a.baseVersion,
      actor: ctx.actor,
      keepPrivateTo: a.keepPrivateTo,
    });
    if (res.status !== "ok") {
      ctx.skipped.push({ path: a.path, reason: "changed" });
      return;
    }
    if (a.contentHash === null) {
      ctx.applied.push(view(a));
      return;
    }
    const put = await putBack(ctx, {
      path: a.path,
      contentHash: a.contentHash,
      expect: res.version,
    });
    // Moved back either way; only the content may not have gone with it.
    ctx.applied.push({ ...view(a), restoresContent: put.status === "ok" } as RecoveryAction);
    if (put.status !== "ok") ctx.skipped.push({ path: a.path, reason: skipReasonFor(put) });
  },
  async restore(ctx, a) {
    settle(
      ctx,
      a,
      await putBack(ctx, {
        path: a.path,
        contentHash: a.contentHash,
        expect: a.baseVersion,
        keepPrivateTo: a.keepPrivateTo,
      }),
    );
  },
  async recreate(ctx, a) {
    settle(
      ctx,
      a,
      await putBack(ctx, {
        path: a.path,
        contentHash: a.contentHash,
        expect: "absent",
        deletedAt: a.deletedAt,
        keepPrivateTo: a.keepPrivateTo,
      }),
    );
  },
};

/**
 * Apply a plan through the file service. Each change is its own atomic write,
 * delete or move, checked against the exact version it was planned from; one
 * that no longer matches, or fails, is reported and the rest carry on. Every
 * event carries the operation's id so the feed can show it as one entry.
 */
export async function applyPlan(args: {
  workspaceId: string;
  plan: RecoveryPlan;
  actor: Actor;
  meta: OperationMeta;
}): Promise<RecoveryOutcome> {
  const { workspaceId, plan, meta } = args;
  if (plan.actions.length > MAX_RECOVERY_ACTIONS) {
    throw new Error(`a recovery may make at most ${MAX_RECOVERY_ACTIONS} changes`);
  }
  if (plan.actions.length === 0) {
    return { operationId: null, applied: [], skipped: plan.skipped };
  }
  const db = usePrismaClient();
  const op = await db.recoveryOperation.create({
    data: {
      workspaceId,
      kind: meta.kind,
      scopePath: meta.scopePath ?? null,
      targetAt: meta.targetAt ?? null,
      targetKeyId: meta.targetKeyId ?? null,
      targetLabel: meta.targetLabel ?? null,
      principal: args.actor.principal,
      actorId: args.actor.actorId,
      actorKeyId: args.actor.actorKeyId,
      actorLabel: args.actor.actorLabel,
    },
  });
  const actor: Actor = { ...args.actor, operationId: op.id };
  const applied: RecoveryAction[] = [];
  const skipped: RecoverySkip[] = [...plan.skipped];
  let failed = 0;

  const ctx: ApplyContext = { workspaceId, actor, applied, skipped };
  for (const phase of byPhase(plan.actions)) {
    await pool(phase, APPLY_CONCURRENCY, async (a) => {
      try {
        await RUNNERS[a.kind](ctx, a as never);
      } catch (err) {
        failed++;
        console.error(`recovery ${op.id}: ${a.kind} failed`, err);
        skipped.push({ path: a.path, reason: "failed" });
      }
    });
  }

  await db.recoveryOperation.update({
    where: { id: op.id },
    data: {
      applied: applied.length,
      skipped: skipped.length - failed,
      failed,
      completedAt: new Date(),
    },
  });
  return { operationId: op.id, applied, skipped };
}