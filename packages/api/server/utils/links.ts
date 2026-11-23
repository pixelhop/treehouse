// Links between notes: backlink queries and keeping links working across a
// rename. The single implementation behind the REST routes and both MCP
// surfaces. The index itself is maintained by the file service (./link-index).
//
// SECURITY: every answer here is computed from what ONE actor may read, and
// the actor is required. That covers more than filtering the result list:
//   - a backlink from a note the actor can't read is never listed, so a private
//     note's existence doesn't leak through what it links to;
//   - wikilinks are resolved against the actor's readable paths only, because
//     `[[Plan]]` reaches a different file depending on which `Plan.md` files
//     exist. Resolving against everything would let a hidden `Plan.md` steal a
//     backlink from the one the actor can see, which is a disclosure by absence.
// Same posture as ./search.ts, and for the same reason this is not part of the
// file service with its "no actor means trusted caller" convention.
import { usePrismaClient } from "db";
import {
  createWikilinkResolver,
  dirOf,
  incomingLinkKeys,
  resolveRef,
  type WikilinkResolver,
} from "shared";
import { relinkForMove, type RelinkResult, type ScannedLink, scanLinks } from "shared/linkScan";
import {
  type AccessSubject,
  type AclRow,
  effectiveAcl,
  encodeGrants,
  listWorkspaceAcls,
} from "./acl";
import { type Actor, useFileService } from "./files";
import {
  catchUpLinkIndex,
  isLinkSource,
  linkIndexKeyId,
  linkKeyHash,
  MAX_INDEXED_BYTES,
  noteTags,
  unscannedLinkSources,
} from "./link-index";
import { normalizePath } from "./paths";

/** Most files one rename will rewrite. More are reported, not silently dropped. */
const MAX_RELINKED_FILES = 200;
/**
 * Before a rename rewrites links, every note must be indexed, or a note that
 * isn't yet would keep a link to the old path with nobody told. Indexing runs
 * in batches for at most this long; past it, the rename is refused and asking
 * again carries on from where it stopped.
 */
const RELINK_INDEX_BUDGET_MS = 10_000;
const RELINK_INDEX_BATCH = 200;
/** Attempts per file when someone else writes it between our read and our write. */
const RELINK_ATTEMPTS = 3;

export interface OutgoingLink {
  kind: "wikilink" | "markdown";
  /** The target as written: a wikilink's name, or a markdown link's destination. */
  target: string;
  /** The workspace file it reaches for this actor, or null when it reaches nothing. */
  path: string | null;
}

export interface LinksView {
  path: string;
  /** Readable notes that link to `path`, sorted. */
  backlinks: string[];
  /** Links the note itself makes, resolved. Only when asked for. */
  outgoing?: OutgoingLink[];
  /** The note's own tags (front matter, then inline), as written. */
  tags: string[];
  /**
   * False while notes written before the index existed are still being indexed,
   * so `backlinks` may be missing some. Asking again makes progress.
   */
  complete: boolean;
}

/** What an actor can see, for resolving links the way they would. */
export async function readerView(workspaceId: string, access: AccessSubject) {
  const acls = await listWorkspaceAcls(workspaceId);
  const paths = await useFileService().listPaths(workspaceId, access, acls);
  return { paths, readable: new Set(paths), resolve: createWikilinkResolver(paths) };
}

/** Notes (readable to the view) whose links reach `path`. */
async function backlinkSources(
  workspaceId: string,
  path: string,
  view: { readable: Set<string>; resolve: WikilinkResolver },
): Promise<string[]> {
  // Each stored hash maps back to how a link would have named `path`: a
  // wikilink name (a candidate, still to be resolved) or null for a markdown
  // link (which named the path exactly).
  const byHash = new Map<string, string | null>();
  for (const k of incomingLinkKeys(path)) byHash.set(linkKeyHash(workspaceId, k.key), k.wikilink);
  const rows = await usePrismaClient().fileLinks.findMany({
    where: { workspaceId, keyId: linkIndexKeyId(), targets: { hasSome: [...byHash.keys()] } },
    select: { sourcePath: true, targets: true },
  });
  const reaches = (hash: string) => {
    const name = byHash.get(hash);
    if (name === undefined) return false;
    return name === null || view.resolve(name) === path;
  };
  return rows
    .filter((r) => r.sourcePath !== path && view.readable.has(r.sourcePath))
    .filter((r) => r.targets.some(reaches))
    .map((r) => r.sourcePath)
    .sort();
}

/** One of a note's own links, resolved the way `view` sees the workspace. */
function outgoingEntry(
  link: ScannedLink,
  dir: string,
  view: { readable: Set<string>; resolve: WikilinkResolver },
): OutgoingLink | null {
  if (link.kind === "wiki") {
    // `[[#Heading]]` is a jump within this note, not a link to another.
    const target = link.parts.target;
    return target ? { kind: "wikilink", target, path: view.resolve(target) } : null;
  }
  const ref = resolveRef(dir, link.href);
  if (ref.kind !== "workspace" || !ref.path) return null;
  const path = view.readable.has(ref.path) ? ref.path : null;
  return { kind: "markdown", target: link.href, path };
}

/** A note's own links, once each, in the order they first appear. */
function outgoingLinks(
  text: string,
  path: string,
  view: { readable: Set<string>; resolve: WikilinkResolver },
): OutgoingLink[] {
  const seen = new Set<string>();
  const out: OutgoingLink[] = [];
  for (const link of scanLinks(text)) {
    const entry = outgoingEntry(link, dirOf(path), view);
    const key = entry && `${entry.kind}\0${entry.target}`;
    if (!entry || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Whether a file's own metadata says to scan it. Decided before reading, because
 * reading buffers the whole file, and from the file's record rather than its
 * blob: blobs are shared by content, so a blob's type is whichever file stored
 * those bytes last.
 */
function worthScanning(path: string, node: { contentType: string; size: number }): boolean {
  return isLinkSource(path, node.contentType) && node.size <= MAX_INDEXED_BYTES;
}

/** The bytes of a note to scan for its own links, or null when it isn't one. */
async function scannableBody(workspaceId: string, path: string, access: AccessSubject) {
  const svc = useFileService();
  const node = await svc.stat(workspaceId, path, access);
  if (!node || !worthScanning(path, node)) return null;
  const res = await svc.read(workspaceId, path, access);
  return res.status === "ok" ? res.body : null;
}

/**
 * The notes linking to `path`, and optionally the links it makes, as `access`
 * sees them. Null when the actor can't read `path` or it doesn't exist (callers
 * answer 404 / "Not found" either way, so a private file stays undiscoverable).
 */
export async function getLinks(opts: {
  workspaceId: string;
  /** Required and non-nullable — see the module note. */
  access: AccessSubject;
  path: string;
  outgoing?: boolean;
}): Promise<LinksView | null> {
  const { workspaceId, access } = opts;
  if (!access?.userId) throw new Error("getLinks requires a subject");
  const path = normalizePath(opts.path);
  const svc = useFileService();
  if (!(await svc.stat(workspaceId, path, access))) return null;

  const complete = await catchUpLinkIndex(workspaceId);
  const view = await readerView(workspaceId, access);
  const backlinks = await backlinkSources(workspaceId, path, view);
  const tags = await noteTags(workspaceId, path);
  if (!opts.outgoing) return { path, backlinks, tags, complete };

  const body = await scannableBody(workspaceId, path, access);
  const outgoing = body ? outgoingLinks(new TextDecoder().decode(body), path, view) : [];
  return { path, backlinks, outgoing, tags, complete };
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface RelinkSummary {
  /** Files whose links now point at the new path. */
  updated: string[];
  /**
   * Files that may still have a link to the old path: they changed while being
   * rewritten, couldn't be read or written, aren't valid UTF-8, the new name
   * can't be written in that link's syntax (a `#` or `|` in a wikilink), the
   * index couldn't scan them (too big, or unreadable) so nobody knows, or
   * rewriting them would show a private file's name to their other readers. A
   * file can be in both lists when only some of its links moved.
   */
  failed: string[];
}

type MoveResult =
  | Awaited<ReturnType<ReturnType<typeof useFileService>["move"]>>
  /** Nothing moved: older notes are still being indexed. Retrying makes progress. */
  | { status: "links_pending" };

/** How much indexing a rename may do first. Tests shrink it; nothing else should. */
export interface IndexBudget {
  ms: number;
  batch: number;
}

const DEFAULT_INDEX_BUDGET: IndexBudget = { ms: RELINK_INDEX_BUDGET_MS, batch: RELINK_INDEX_BATCH };

/** Index every note in the workspace, within the budget. True when done. */
async function indexBeforeRename(workspaceId: string, budget: IndexBudget): Promise<boolean> {
  const deadline = Date.now() + budget.ms;
  do {
    if (await catchUpLinkIndex(workspaceId, budget.batch)) return true;
  } while (Date.now() < deadline);
  return false;
}

/**
 * Whether rewriting `doc` for this move would show its readers something they
 * can't see. A restricted file's name reaches people through any note they can
 * read, and `[[Plan]]` may reach a different file for them, one the rewrite
 * would take away. So a note is only rewritten when it's limited to exactly the
 * same people as the file, at both ends of the move: a new name in a new folder
 * must not reach the people on the old one.
 */
function wouldExpose(
  acls: { before: AclRow[]; after: AclRow[] },
  move: { from: string; to: string },
  doc: string,
): boolean {
  const note = encodeGrants(effectiveAcl(acls.after, doc));
  return [effectiveAcl(acls.before, move.from), effectiveAcl(acls.after, move.to)].some(
    (file) => file !== null && encodeGrants(file) !== note,
  );
}

// Decode without loss or we don't rewrite at all: a file that isn't valid
// UTF-8 would come back with replacement characters, and the BOM must survive.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Move a file and, when `updateLinks` is set, rewrite the links that reached it
 * so they reach its new path — in every note the mover can write, plus the
 * moved note's own relative links.
 *
 * Each rewrite is an ordinary write by the mover, attributed to them in the
 * change feed, made against the version just read. If the note changes between
 * that read and the write, the write is dropped (never a conflicted copy: these
 * bytes are ours, not someone's edit) and retried from a fresh read. A note that
 * still can't be written is reported in `failed` and keeps its old link.
 *
 * Not atomic with the move: the move commits first, then the rewrites, so a
 * reader can briefly see a link to the old path. Notes the mover can't read are
 * never touched, so a restricted note's links to the old path are left to break;
 * it renders them as unresolved, and the people on it can fix them. A note other
 * people can read isn't rewritten for a restricted file either (see wouldExpose).
 */
export async function moveWithLinks(args: {
  workspaceId: string;
  from: string;
  to: string;
  baseVersion?: number;
  actor: Actor;
  updateLinks: boolean;
  indexBudget?: IndexBudget;
}): Promise<MoveResult & { links?: RelinkSummary }> {
  const { workspaceId, actor, baseVersion, updateLinks } = args;
  const svc = useFileService();
  const access = actor.access;
  if (!updateLinks || access === "trusted")
    return svc.move({ workspaceId, from: args.from, to: args.to, baseVersion, actor });

  const from = normalizePath(args.from);
  const to = normalizePath(args.to);
  // Who links here is decided from the workspace as it was before the move.
  // The move itself re-checks access, so this read-only look discloses nothing
  // the move's own answer wouldn't.
  const budget = args.indexBudget ?? DEFAULT_INDEX_BUDGET;
  if (!(await indexBeforeRename(workspaceId, budget))) return { status: "links_pending" };
  const before = await readerView(workspaceId, access);
  const readable = before.readable.has(from);
  const sources = readable ? await backlinkSources(workspaceId, from, before) : [];
  const unscanned = readable
    ? (await unscannedLinkSources(workspaceId)).filter((p) => p !== from && before.readable.has(p))
    : [];
  const aclsBefore = await listWorkspaceAcls(workspaceId);

  const res = await svc.move({ workspaceId, from, to, baseVersion, actor });
  if (res.status !== "ok") return res;

  const acls = { before: aclsBefore, after: await listWorkspaceAcls(workspaceId) };
  const held = sources.filter((doc) => wouldExpose(acls, { from, to }, doc));
  const heldBack = new Set(held);
  // The moved note itself goes first: its own relative links and self-links.
  const { summary, movedVersion } = await rewriteLinks({
    workspaceId,
    move: { from, to },
    docs: [to, ...sources.filter((doc) => !heldBack.has(doc))],
    actor,
    access,
    before,
  });
  const unreported = [...held, ...unscanned].filter((p) => !summary.failed.includes(p));
  summary.failed.push(...new Set(unreported));
  return { status: "ok", version: movedVersion ?? res.version, links: summary };
}

/**
 * Rewrite each note in `docs` for a move that has just committed. Returns what
 * happened, and the moved note's new version if it was itself rewritten.
 */
async function rewriteLinks(a: {
  workspaceId: string;
  move: { from: string; to: string };
  docs: string[];
  actor: Actor;
  access: AccessSubject;
  before: { paths: string[]; readable: Set<string>; resolve: WikilinkResolver };
}): Promise<{ summary: RelinkSummary; movedVersion: number | null }> {
  const { from, to } = a.move;
  const resolveAfter = createWikilinkResolver(a.before.paths.map((p) => (p === from ? to : p)));
  const summary: RelinkSummary = { updated: [], failed: [] };
  let movedVersion: number | null = null;
  for (const [i, doc] of a.docs.entries()) {
    const outcome =
      i < MAX_RELINKED_FILES
        ? await relinkSafely({
            workspaceId: a.workspaceId,
            doc,
            docBefore: doc === to ? from : doc,
            move: a.move,
            actor: a.actor,
            access: a.access,
            resolveBefore: a.before.resolve,
            resolveAfter,
            existedBefore: (p) => a.before.readable.has(p),
          })
        : LEFT_BEHIND;
    if (outcome.version !== null) summary.updated.push(doc);
    if (outcome.leftBehind) summary.failed.push(doc);
    if (doc === to) movedVersion = outcome.version;
  }
  return { summary, movedVersion };
}

interface RelinkOutcome {
  /** The new version when the file was rewritten, else null. */
  version: number | null;
  /** Whether a link to the old path is still in the file. */
  leftBehind: boolean;
}

const UNCHANGED: RelinkOutcome = { version: null, leftBehind: false };
const LEFT_BEHIND: RelinkOutcome = { version: null, leftBehind: true };

type RelinkArgs = Parameters<typeof relinkOne>[0];

/**
 * relinkOne, contained. The move has already committed by now, so a storage or
 * database error on one note must neither lose the answer for the move nor
 * stop the other notes being rewritten. It is recorded as left behind.
 */
async function relinkSafely(a: RelinkArgs): Promise<RelinkOutcome> {
  try {
    return await relinkOne(a);
  } catch (err) {
    console.error(`failed to rewrite links in a note in workspace ${a.workspaceId}:`, err);
    return LEFT_BEHIND;
  }
}

async function relinkOne(a: {
  workspaceId: string;
  doc: string;
  docBefore: string;
  move: { from: string; to: string };
  actor: Actor;
  access: AccessSubject;
  resolveBefore: WikilinkResolver;
  resolveAfter: WikilinkResolver;
  existedBefore: (path: string) => boolean;
}): Promise<RelinkOutcome> {
  const node = await useFileService().stat(a.workspaceId, a.doc, a.access);
  if (!node) return LEFT_BEHIND;
  if (!isLinkSource(a.doc, node.contentType)) return UNCHANGED;
  if (!worthScanning(a.doc, node)) return LEFT_BEHIND;
  for (let attempt = 0; attempt < RELINK_ATTEMPTS; attempt++) {
    const outcome = await relinkAttempt(a, node.contentType);
    if (outcome) return outcome;
  }
  return LEFT_BEHIND;
}

/** One read, rewrite and write. Null when the note changed in between: try again. */
async function relinkAttempt(a: RelinkArgs, contentType: string): Promise<RelinkOutcome | null> {
  const svc = useFileService();
  const read = await svc.read(a.workspaceId, a.doc, a.access);
  if (read.status !== "ok") return LEFT_BEHIND;
  const content = decodeExactly(read.body);
  if (content === null) return LEFT_BEHIND;
  const next = relinkForMove({
    content,
    docPathBefore: a.docBefore,
    docPathAfter: a.doc,
    move: a.move,
    resolveBefore: a.resolveBefore,
    resolveAfter: a.resolveAfter,
    existedBefore: a.existedBefore,
  });
  const leftBehind = mayKeepOldLinks(next);
  if (next.changed === 0) return { version: null, leftBehind };
  const written = await svc.write({
    workspaceId: a.workspaceId,
    path: a.doc,
    body: new TextEncoder().encode(next.content),
    contentType,
    baseVersion: read.version,
    actor: a.actor,
    nowIso: new Date().toISOString(),
    ifStale: "fail",
  });
  if (written.ok && written.version !== undefined) return { version: written.version, leftBehind };
  return written.stale ? null : LEFT_BEHIND;
}

/** Unwritable links stay as they were, and a scan cut short may have missed some. */
function mayKeepOldLinks(result: RelinkResult): boolean {
  return result.unwritable > 0 || !result.complete;
}

/** The text of a file, or null unless it decodes without loss. */
function decodeExactly(body: Uint8Array): string | null {
  try {
    return strictUtf8.decode(body);
  } catch {
    return null;
  }
}