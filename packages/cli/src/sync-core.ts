import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  type Dirent,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { contentTypeFor, isKeepFile } from "shared";
import type { ApiClient, PutConflict, PutForbidden } from "./api-client";
import type { IndexMap } from "./index-store";
import { type Action, type IndexEntry, reconcile, type RemoteState } from "./reconcile";
import { type ByteStream, hashedFile, sha256OfFile } from "./streams";

// ---------------------------------------------------------------------------
// Sync core: the filesystem IO + the single-path reconcile primitive shared by
// the full-pass `runSync` (see sync.ts) and the incremental engine (engine.ts).
// The reconcile DECISION lives in reconcile.ts and is never touched here; this
// module only gathers the three states for a path and applies the chosen action
// (the data-safety invariants — conflicted copies, resurrection-over-loss,
// atomic writes — all live in applyAction/adoptWinner below).
// ---------------------------------------------------------------------------

const IGNORE = [
  /(^|\/)\.treehouse(\/|$)/,
  /\.swp$/,
  /~$/,
  /(^|\/)\.#/,
  /\.tmp$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)4913$/,
  // Dependency trees, VCS internals and build output. The product strategy names these
  // as an explicit non-goal ("no syncing dependency folders, build caches"),
  // and a workspace file limit makes the omission expensive rather than merely
  // untidy: a node_modules is tens of thousands of tiny files, so syncing one
  // exhausts a file allowance while barely touching the byte quota.
  //
  // Anchored on path separators so a folder merely NAMED like one of these
  // ("my-node_modules-notes") still syncs.
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.hg(\/|$)/,
  /(^|\/)\.svn(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)venv(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.nuxt(\/|$)/,
  /(^|\/)\.output(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)vendor(\/|$)/,
  /(^|\/)\.gradle(\/|$)/,
  /(^|\/)Pods(\/|$)/,
  // Obsidian rewrites these every time someone moves between notes: they record
  // one person's open tabs, so they're per-device by nature. Shared, two people
  // with a vault open produce a stream of conflicted copies of a file nobody
  // edits. The rest of `.obsidian` is settings a team wants in common.
  /(^|\/)\.obsidian\/workspace(-mobile)?\.json$/,
];

/**
 * What a folder would cost to sync, and which ignored directories dominate it.
 *
 * A file limit turns "point the CLI at a project folder" from untidy into a
 * wall of rejections, so the CLI reports this BEFORE uploading anything rather
 * than letting the server refuse the 1,001st file with no explanation.
 */
export interface PreflightSummary {
  /** Files that would actually sync. */
  syncable: number;
  /** Files skipped by the ignore rules. */
  ignored: number;
  /** Largest ignored directories, biggest first — the ones worth naming. */
  topIgnored: { dir: string; files: number }[];
}

export function preflight(root: string): PreflightSummary {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true }) as Dirent[];
  } catch (e) {
    throw new ScanIncompleteError(e);
  }
  let syncable = 0;
  let ignoredCount = 0;
  const byDir = new Map<string, number>();
  for (const e of entries) {
    if (!e.isFile()) continue;
    const rel = relative(root, join(e.parentPath, e.name)).split(sep).join("/");
    if (!ignored(rel)) {
      syncable++;
      continue;
    }
    ignoredCount++;
    // Attribute the file to the first path segment that matched a rule, so the
    // report reads "node_modules: 31,402" rather than listing every leaf.
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (ignored(prefix)) {
        byDir.set(prefix, (byDir.get(prefix) ?? 0) + 1);
        break;
      }
    }
  }
  const topIgnored = [...byDir.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 5);
  return { syncable, ignored: ignoredCount, topIgnored };
}

/**
 * Ignored means sync has no opinion, in either direction. A path can still reach
 * the workspace (the web app, an agent, a client from before it was ignored), so
 * skipping the local scan isn't enough: reconcile would read "not on disk" as a
 * delete and remove it for everyone. Both ways in, the full pass and
 * reconcilePath, must leave these paths out of reconcile altogether.
 */
export function ignored(rel: string): boolean {
  return IGNORE.some((re) => re.test(rel));
}

// ---------------------------------------------------------------------------
// Root-liveness guard (R12). A synced root that is moved, renamed, trashed, or
// becomes unreadable makes scanLocal/scanLocalPath report every baselined file
// as locally-deleted — which without this guard propagates as a team-wide
// delete. The liveness marker is `.treehouse/config.json`: a file the daemon
// NEVER recreates (it is written once at login by write-config). The daemon's
// state.json/index.json/cursor.json DO get recreated on write, so directory
// existence is not a safe signal — an empty dir left at the path (or a stale
// mkdir) must not read as "reappeared". Re-attach therefore requires the marker
// file, not the directory.
export type Liveness = "alive" | "missing" | "unreadable";

/**
 * Classify a sync root by its liveness marker. `alive` only when
 * `.treehouse/config.json` is present and readable. A permission error (EPERM/
 * EACCES — e.g. macOS TCC denying access) is reported as `unreadable`, distinct
 * from a `missing` (moved/trashed) root, so the two get different reason strings;
 * both suppress delete-propagation identically.
 */
export function checkRootLiveness(root: string): Liveness {
  try {
    return statSync(join(root, ".treehouse", "config.json")).isFile() ? "alive" : "missing";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES" ? "unreadable" : "missing";
  }
}

export function rootAlive(root: string): boolean {
  return checkRootLiveness(root) === "alive";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ScanEntry {
  hash: string;
  mtime: number;
  size: number;
  /**
   * The file is on disk but could not be read this pass (permissions, I/O, a
   * lock). `hash`/`mtime`/`size` are then NOT a description of it — they are
   * whatever the baseline last said — so callers must skip the path entirely
   * rather than reconcile it. See scanOne.
   */
  unreadable?: true;
}

/**
 * A local change the server refused, and what was done about it:
 *  - `reverted`: an edit, replaced by the server's version. The edit itself is
 *    kept at `savedTo`, inside `.treehouse/`, which is never synced.
 *  - `restored`: a delete, undone by downloading the file again.
 *  - `kept`: a new file, left where it is and not uploaded.
 */
export interface SyncNotice {
  path: string;
  outcome: "reverted" | "restored" | "kept";
  /** The server's reason: `role`, `grant` (this item), `key` or `key_folder`. */
  reason: string;
  /** Root-relative location of the saved edit, for `reverted`. */
  savedTo?: string;
}

export interface SyncSummary {
  pulled: string[];
  pushed: string[];
  deleted: string[];
  conflicts: string[];
  /** Local files a destructive mass-delete would have removed, kept & re-uploaded instead. */
  refusedDeletes: string[];
  /** Local files skipped because they exceed the upload size cap (warned once each). */
  oversize: string[];
  /** Local changes the server refused because the access here is view-only. */
  readOnly: SyncNotice[];
  /**
   * Paths whose action threw (a failed transfer, an unreadable file). The pass
   * carries on past them and keeps their old baseline, so the next pass retries
   * exactly those paths instead of the whole workspace.
   */
  failed: Array<{ path: string; reason: string }>;
  /**
   * Set when the scan was refused because the root failed its liveness check
   * (moved/trashed/unreadable). The pass did nothing — no scan, no propagation —
   * so a moved folder can never delete the team's files. Callers surface this as
   * a folder-error state instead of acting on the (empty) summary.
   */
  rootLost?: Exclude<Liveness, "alive">;
}

// Client-side upload cap: a local file at or above this is skipped rather than
// pushed, so the rest of the folder still syncs and the server never has to 413.
// Mirrors the API's default MAX_FILE_BYTES (100 MB); TREEHOUSE_MAX_FILE_BYTES
// overrides it for instances configured with a different server limit.
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export function maxFileBytes(): number {
  const raw = process.env.TREEHOUSE_MAX_FILE_BYTES;
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  // Strict digits only: `parseInt("100MB")` is 100, which would silently make
  // the CLI skip every file over 100 bytes. Any non-digit falls back to default.
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_MAX_FILE_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

/** Map a scanned local entry to the minimal state the reconcile core needs. */
export function localStateOf(local: ScanEntry | undefined): { hash: string } | undefined {
  return local ? { hash: local.hash } : undefined;
}

/** The mutable per-run state threaded through the reconcile/apply functions. */
export interface SyncContext {
  root: string;
  api: ApiClient;
  index: IndexMap;
  summary: SyncSummary;
  /**
   * Paths already warned about as oversized, so a skipped file is reported once
   * — not on every poll cycle. Owned by the caller (the engine keeps one for the
   * process lifetime; a one-shot runSync uses a fresh set).
   */
  oversizeWarned?: Set<string>;
  /**
   * New local files the server has refused, as path → the file's mtime:size at
   * the time, so an unchanged file isn't offered again on every pass. Owned by
   * the caller like `oversizeWarned`, and in memory on purpose: a daemon restart
   * offers each file once more, which is how they upload by themselves after the
   * member is given write access. A changed file is offered immediately.
   */
  refusedCreates?: Map<string, string>;
}

function absOf(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

/**
 * The tree walk failed, so the scan describes NOTHING — not "no files". Thrown
 * rather than returned as an empty map, because an empty map reads as "every
 * baselined file was deleted locally" and reconciles to a remote delete of the
 * whole workspace. The caller refuses the pass instead.
 */
export class ScanIncompleteError extends Error {
  constructor(cause: unknown) {
    super(`could not walk the folder: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ScanIncompleteError";
  }
}

/**
 * The on-disk state for one file, or undefined when it is genuinely absent.
 *
 * Both filesystem calls here can fail on a live folder — a file deleted between
 * the directory read and the stat, a permission change, an I/O error — and the
 * two failure kinds must NOT be treated alike:
 *
 *   ENOENT/ENOTDIR: the file really is gone. Reporting it absent is correct and
 *   propagates the delete like any other.
 *
 *   anything else (EACCES/EPERM/EIO/EBUSY): the file is still there, we just
 *   can't read it this instant — so we know NOTHING about its contents. It is
 *   flagged `unreadable` and callers skip the path outright.
 *
 * That flag exists because neither available description is safe. "Absent"
 * reconciles to `pushDelete` and deletes the team's copy of a file that exists.
 * "Unchanged" is just as bad in the other direction: if the file holds an
 * unpushed edit and the remote has also moved on, unchanged+remoteChanged is a
 * `pull`, which overwrites that edit with no conflicted copy — the one thing
 * this sync promises never to do. Not deciding is the only correct answer; the
 * next pass, or the watcher, retries once the file can be read.
 */
function scanOne(abs: string, rel: string, index: IndexMap): ScanEntry | undefined {
  const prev = index[rel];
  // Placeholder values: `unreadable` tells every caller not to read them.
  const unknown = (): ScanEntry => ({
    hash: prev?.hash ?? "",
    mtime: prev?.mtime ?? 0,
    size: prev?.size ?? 0,
    unreadable: true,
  });
  const gone = (e: unknown): boolean => {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  };

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch (e) {
    return gone(e) ? undefined : unknown();
  }
  if (!st.isFile()) return undefined;
  if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
    return { hash: prev.hash, mtime: st.mtimeMs, size: st.size };
  }
  // Hashed a chunk at a time and NOT kept: a scan used to hold the bytes of
  // every changed file at once, which on a first sync meant the whole folder in
  // memory. A push reads the file again (see applyAction).
  try {
    return { hash: sha256OfFile(abs), mtime: st.mtimeMs, size: st.size };
  } catch (e) {
    return gone(e) ? undefined : unknown();
  }
}

// Walk the root -> relative POSIX path -> content hash. Files whose mtime+size
// match the index are NOT re-read or re-hashed (the index hash is reused), so an
// idle cycle does no file I/O beyond stat(). Editor temp files and .treehouse
// are skipped. Per-file failures are absorbed by scanOne; only a failed walk of
// the tree itself is fatal (see ScanIncompleteError).
export function scanLocal(root: string, index: IndexMap): Map<string, ScanEntry> {
  const out = new Map<string, ScanEntry>();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true }) as Dirent[];
  } catch (e) {
    throw new ScanIncompleteError(e);
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (ignored(rel)) continue;
    const entry = scanOne(abs, rel, index);
    if (entry) out.set(rel, entry);
  }
  return out;
}

/**
 * Single-path equivalent of scanLocal: the on-disk state for one workspace-
 * relative path, reusing the mtime+size fast-path against the index. Returns
 * undefined when the path is absent or ignored. Used by the engine to reconcile
 * one path without walking the whole tree.
 */
export function scanLocalPath(root: string, rel: string, index: IndexMap): ScanEntry | undefined {
  if (ignored(rel)) return undefined;
  return scanOne(absOf(root, rel), rel, index);
}

function writeAtomic(root: string, rel: string, bytes: Uint8Array): void {
  const abs = absOf(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.treehouse-tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, abs);
}

/**
 * `writeAtomic` for a stream: written to the temp name as it arrives, hashed on
 * the way, then renamed into place, so a large download is never held whole
 * and a failed one leaves the real path untouched.
 */
async function writeAtomicStream(
  root: string,
  rel: string,
  body: ByteStream,
  /**
   * Checked at the last moment, just before the rename replaces the file. When
   * it says no, nothing is replaced and the result is null: the caller is
   * protecting a local file that may have changed while the download ran.
   */
  stillOk?: () => boolean,
): Promise<{ hash: string; size: number } | null> {
  const abs = absOf(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.treehouse-tmp-${process.pid}`;
  const hash = createHash("sha256");
  let size = 0;
  async function* hashed(): ByteStream {
    for await (const piece of body) {
      hash.update(piece);
      size += piece.byteLength;
      yield piece;
    }
  }
  try {
    await pipeline(Readable.from(hashed()), createWriteStream(tmp));
    if (stillOk && !stillOk()) {
      rmSync(tmp, { force: true });
      return null;
    }
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { hash: hash.digest("hex"), size };
}

function removeLocal(root: string, rel: string): void {
  rmSync(absOf(root, rel), { force: true });
}

/**
 * Baseline a path we just WROTE to disk ourselves (a pull, or a conflicted copy).
 * The stat is taken after the rename, so `hash` and the stat describe the same
 * bytes unless a local writer raced us in that window — which the size check
 * catches. On a mismatch the entry is written WITHOUT mtime/size, which no scan
 * can fast-path against, so the next one re-reads instead of trusting a hash
 * that no longer describes the file. See `baselineForPush` for why that
 * direction matters.
 */
function baselineFromDisk(
  root: string,
  rel: string,
  version: number,
  written: { hash: string; size: number },
): IndexEntry {
  const { hash } = written;
  const st = statSync(absOf(root, rel));
  // A local writer that beat us to the path between the rename and this stat
  // would leave `hash` describing OUR bytes and the stat describing THEIRS —
  // the same invisible pairing baselineForPush exists to avoid. Sizes differing
  // is the cheap tell; drop the fast-path metadata so the next scan re-reads.
  if (st.size !== written.size) return { version, hash };
  return { version, hash, mtime: st.mtimeMs, size: st.size };
}

/**
 * Baseline a path we just PUSHED, from the stat taken BEFORE its bytes were
 * read — never a fresh one.
 *
 * A push is `read bytes -> network round trip -> record baseline`, and the file
 * can be rewritten during that round trip (an agent copying a note and then
 * rebasing its links does exactly this, milliseconds apart). Stat'ing after the
 * response pairs the OLD content's hash with the NEW content's mtime+size — and
 * that pairing is invisible to `scanOne`, whose fast path takes matching
 * mtime+size as proof the file is unchanged and reuses the index hash. The edit
 * is then never detected, never uploaded, and the folder reports itself synced
 * while local and cloud silently disagree.
 *
 * Pairing the hash with the pre-read stat cannot fail that way. If the file
 * changed during the round trip the recorded stat is simply older than the
 * file's, so the next scan re-reads it and sees the change — one wasted hash in
 * the worst case, instead of a lost edit.
 */
function baselineForPush(version: number, hash: string, read: ReadStat): IndexEntry {
  return { version, hash, mtime: read.mtime, size: read.size };
}

/** The stat taken immediately before a push read the file's bytes. */
interface ReadStat {
  mtime: number;
  size: number;
}

/**
 * Files up to this size are read whole and pushed from memory, as they always
 * were; larger ones are streamed. Reading whole means a file rewritten while its
 * upload is in flight still uploads one consistent version — the norm for the
 * small documents agents edit rapidly. A streamed file is read DURING the
 * upload, so an in-place rewrite then can send a mix of old and new; the
 * baseline still records the hash of exactly what was sent against the
 * pre-read stat, so the next pass sees the change and uploads the new version.
 */
const STREAM_PUSH_BYTES = 8 * 1024 * 1024;

/** Whether the file at `abs` still hashes to `hash` (false if it has gone). */
function stillHolds(abs: string, hash: string): boolean {
  try {
    return sha256OfFile(abs) === hash;
  } catch {
    return false;
  }
}

/** Write a pulled body to disk and baseline it at the version it came with. */
async function pullInto(
  ctx: SyncContext,
  path: string,
  got: { body: ByteStream; version: number },
  stillOk?: () => boolean,
): Promise<boolean> {
  const written = await writeAtomicStream(ctx.root, path, got.body, stillOk);
  if (!written) return false;
  ctx.index[path] = baselineFromDisk(ctx.root, path, got.version, written);
  return true;
}

// Overwrite local with the server's current winner and re-baseline. If the
// winner vanished in a race and `keepLocal` is set, leave the user's local file
// where it is (re-created on the server next cycle) instead of deleting it.
// `stillOk`, when given, is re-checked just before the local file is replaced;
// if it fails nothing is touched and this returns false.
async function adoptWinner(
  ctx: SyncContext,
  path: string,
  keepLocal = false,
  stillOk?: () => boolean,
): Promise<boolean> {
  const { root, api, index } = ctx;
  const got = await api.get(path);
  if (!got) {
    if (!keepLocal) removeLocal(root, path);
    delete index[path];
    return true;
  }
  return pullInto(ctx, path, got, stillOk);
}

// Record a synced path in a summary list — unless it's a `.keep` placeholder,
// which still syncs to disk (so empty folders materialize locally) but is hidden
// from the user-facing sync counts as noise.
function note(list: string[], path: string): void {
  if (!isKeepFile(path)) list.push(path);
}

/** Drop every index entry at or under `path` (a file, or a whole folder). */
function forgetSubtree(index: IndexMap, path: string): void {
  const prefix = `${path}/`;
  for (const key of Object.keys(index)) {
    if (key === path || key.startsWith(prefix)) delete index[key];
  }
}

/**
 * Skip a file over the upload cap rather than pushing it (the server would 413
 * anyway). Leave the index untouched so it uploads if it later shrinks; warn once
 * per path so a poll loop doesn't repeat the message.
 */
function skipOversize(ctx: SyncContext, path: string, read: ReadStat): boolean {
  if (read.size <= maxFileBytes()) return false;
  if (!ctx.oversizeWarned?.has(path)) {
    ctx.oversizeWarned?.add(path);
    ctx.summary.oversize.push(path);
  }
  return true;
}

/**
 * A push not worth attempting: too big to upload, or a new file the server has
 * already refused. The latter only while the path really is ours alone: if
 * someone has since created it on the server, staying quiet here would block
 * their file from ever arriving.
 */
function skipPush(ctx: SyncContext, path: string, read: ReadStat, localOnly: boolean): boolean {
  if (localOnly && ctx.refusedCreates?.get(path) === fingerprint(read)) return true;
  return skipOversize(ctx, path, read);
}

/** Upload one local file (a create or a push) and record what happened. */
async function pushPath(
  ctx: SyncContext,
  path: string,
  opts: { create: true } | { baseVersion: number },
  onRemote = false,
): Promise<void> {
  const { root, api, index, summary } = ctx;
  // Stat first, then read, so the baseline written after the upload can
  // never claim newer file metadata than the bytes it describes. See
  // baselineForPush.
  const abs = absOf(root, path);
  const st = statSync(abs);
  const read: ReadStat = { mtime: st.mtimeMs, size: st.size };
  const localOnly = "create" in opts && !onRemote;
  if (skipPush(ctx, path, read, localOnly)) return;
  // Small files go from memory (one consistent read); large ones stream,
  // hashed as they are sent so the baseline names exactly what was uploaded.
  const bytes = read.size <= STREAM_PUSH_BYTES ? new Uint8Array(readFileSync(abs)) : null;
  const sent = createHash("sha256");
  const res = await api.put(path, bytes ?? hashedFile(abs, sent), opts, contentTypeFor(path));
  const sentHash = bytes ? sha256(bytes) : sent.digest("hex");
  if (res.ok) {
    index[path] = baselineForPush(res.version, sentHash, read);
    note(summary.pushed, path);
  } else if ("refused" in res) {
    await refuseChange(ctx, path, localOnly, read, res.refused);
  } else {
    await settleLostPush(ctx, path, res, bytes, sentHash);
  }
}

/** A push that lost: the path was hidden from us, or someone else's write won. */
async function settleLostPush(
  ctx: SyncContext,
  path: string,
  res: PutConflict | PutForbidden,
  bytes: Uint8Array | null,
  sentHash: string,
): Promise<void> {
  const { root, index, summary } = ctx;
  if ("forbidden" in res) {
    // The path became private to another member while we were offline (the
    // full pass and the mass-delete guard are access-blind, so they can
    // route a now-hidden file to create/push). The write is forbidden — drop
    // the local copy as access-lost rather than crash-looping on the 404.
    removeLocal(root, path);
    delete index[path];
    note(summary.deleted, path);
  } else {
    await keepBothVersions(ctx, path, res.conflictCopyPath, bytes, sentHash);
  }
}

const fingerprint = (read: ReadStat): string => `${read.mtime}:${read.size}`;

/**
 * Copy a refused local edit into `.treehouse/`, which never syncs, and say where.
 * Named by its content, keeping the extension so it still opens: each edit is the
 * only copy of that work, so a later one must not replace it, and the same bytes
 * refused twice stay one file.
 */
function saveRefusedEdit(root: string, path: string): string {
  const abs = absOf(root, path);
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  const savedTo = `.treehouse/reverted/${stem}.${sha256OfFile(abs).slice(0, 12)}${ext}`;
  const dest = absOf(root, savedTo);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
  return savedTo;
}

/**
 * The server refused a local change because access here is view-only. Settle it
 * so nothing retries: unlike a conflict the server stored nothing, so there is
 * no conflicted copy to mirror. Anything the server also has gives way to the
 * server's version, its bytes saved first, and the new baseline makes the
 * watcher's echo and every later pass a no-op. That includes a file with no
 * baseline that exists on both sides, as when a populated folder is linked:
 * left alone it would never get a baseline, and so never another update. A file
 * only we have has no server version to go back to, and deleting someone's work
 * over a permission would be the wrong way round, so it stays and just isn't
 * offered again until it changes.
 *
 * "Unchanged" is judged by stat, not by the hash of what was sent: the server
 * refuses before reading the body, so a streamed upload is cut off part way and
 * its hash describes only a prefix of the file.
 */
async function refuseChange(
  ctx: SyncContext,
  path: string,
  localOnly: boolean,
  read: ReadStat,
  reason: string,
): Promise<void> {
  const { root, summary, index } = ctx;
  const notice = (n: Omit<SyncNotice, "path" | "reason">) => {
    if (!isKeepFile(path)) summary.readOnly.push({ path, reason, ...n });
  };
  if (localOnly) {
    ctx.refusedCreates?.set(path, fingerprint(read));
    notice({ outcome: "kept" });
    return;
  }
  const abs = absOf(root, path);
  const unchanged = () => {
    try {
      const now = statSync(abs);
      return now.mtimeMs === read.mtime && now.size === read.size;
    } catch {
      return false;
    }
  };
  const retryLater = () =>
    summary.failed.push({ path, reason: "changed while being reverted — will retry" });
  if (!unchanged()) return void retryLater();
  const localHash = sha256OfFile(abs);
  const savedTo = saveRefusedEdit(root, path);
  if (!(await adoptWinner(ctx, path, true, unchanged))) return void retryLater();
  // The file was deleted on the server in the meantime: nothing to go back to,
  // so it is now simply a new local file, and the next pass treats it as one.
  if (!index[path]) return;
  // A first sync of bytes the server already holds: nothing was refused really.
  if (index[path].hash === localHash) return rmSync(absOf(root, savedTo));
  notice({ outcome: "reverted", savedTo });
}

/** A push lost to a newer remote: keep our version as the conflicted copy, adopt theirs. */
async function keepBothVersions(
  ctx: SyncContext,
  path: string,
  conflictCopyPath: string,
  bytes: Uint8Array | null,
  sentHash: string,
): Promise<void> {
  const { root, api, index, summary } = ctx;
  // Conflict resolution ends by replacing the local file with the winner, and
  // the only thing that makes that safe is that the local file still holds
  // exactly what the server kept as the conflicted copy. Anything else — an
  // edit during the upload (a streamed file is read while it is sent), during
  // the copy's download, or during the winner's — would be overwritten with no
  // copy anywhere. So it is checked before each step and again at the last
  // moment before the rename. If it fails, the path and its baseline are left
  // as they are and the next pass resolves the conflict with the new content.
  const unchanged = () => stillHolds(absOf(root, path), sentHash);
  const retryLater = () =>
    summary.failed.push({ path, reason: "changed during conflict resolution — will retry" });
  if (!unchanged()) return void retryLater();
  // Mirror the server's conflicted copy locally so the work is never
  // local-only. From memory when we have the bytes. A streamed file is
  // downloaded from the server instead, so the local copy matches the server's
  // exactly. If that copy has gone (another client removed it), our version
  // exists only in the local file, so it must not be replaced.
  if (bytes) {
    writeAtomic(root, conflictCopyPath, bytes);
    index[conflictCopyPath] = baselineFromDisk(root, conflictCopyPath, 1, {
      hash: sentHash,
      size: bytes.byteLength,
    });
  } else {
    const copy = await api.get(conflictCopyPath);
    if (!copy || !(await pullInto(ctx, conflictCopyPath, copy))) return void retryLater();
    // Someone may have edited or replaced the copy between our 412 and this
    // fetch. Then it is no longer our losing version, and the original file
    // is the only place that version still exists — so keep it.
    if (index[conflictCopyPath]?.hash !== sentHash) return void retryLater();
  }
  if (!(await adoptWinner(ctx, path, true, unchanged))) return void retryLater();
  // Suppress a .keep's conflicted-copy noise (gate on the original path, since
  // the copy name differs).
  if (!isKeepFile(path)) summary.conflicts.push(conflictCopyPath);
}

/** Propagate a local delete and record what happened. */
async function pushDeletion(ctx: SyncContext, path: string, baseVersion: number): Promise<void> {
  const { root, api, index, summary } = ctx;
  const r = await api.delete(path, baseVersion);
  if (typeof r === "object") {
    // Refused: bring the file back rather than leave a hole the next pass
    // would try to delete again. Only into a hole: if the path has come back
    // since, it's new work, and the next pass reconciles it as an edit.
    const stillAbsent = () => !existsSync(absOf(root, path));
    const restored = await adoptWinner(ctx, path, true, stillAbsent);
    if (restored && index[path] && !isKeepFile(path)) {
      summary.readOnly.push({ path, outcome: "restored", reason: r.refused });
    }
  } else if (r === "ok" || r === "not_found") {
    delete index[path];
    note(summary.deleted, path);
  } else {
    // Remote changed under us -> the edit wins, resurrect locally.
    await adoptWinner(ctx, path);
    note(summary.pulled, path);
  }
}

/**
 * Apply a reconcile Action for one path. `local` is the (optional) already-
 * scanned on-disk entry; when absent, bytes for a push are read from disk.
 */
export async function applyAction(
  ctx: SyncContext,
  path: string,
  action: Action,
  local?: ScanEntry,
): Promise<void> {
  const { root, api, index, summary } = ctx;

  switch (action.type) {
    case "noop":
      break;
    case "dropIndex":
      delete index[path];
      break;
    case "deleteLocal":
      removeLocal(root, path);
      delete index[path];
      note(summary.deleted, path);
      break;
    case "accessLost": {
      // The server revoked our access (the owner made this node private). The
      // revoked `path` is the ACL root — a single file OR a folder, since the
      // server emits ONE access_revoked event at the folder root, not per child.
      // Remove the whole subtree from disk (recursive — a plain rmSync throws on
      // a directory) and drop every index entry at or under it. Unconditional:
      // no resurrection, no re-push (a local edit can't be pushed anymore), and
      // the canonical copy lives server-side under the owner. Removal-from-view,
      // not a deletion of the file.
      rmSync(absOf(root, path), { force: true, recursive: true });
      forgetSubtree(index, path);
      note(summary.deleted, path);
      break;
    }
    case "pull": {
      const got = await api.get(path);
      if (got) {
        await pullInto(ctx, path, got);
        note(summary.pulled, path);
      } else {
        // Remote was deleted between decision and get — re-decide with remote
        // absent (so a locally-edited file resurrects instead of being deleted).
        await applyAction(ctx, path, reconcile(localState(local), undefined, index[path]), local);
      }
      break;
    }
    case "create":
    case "push":
      await pushPath(
        ctx,
        path,
        action.type === "create" ? { create: true } : { baseVersion: action.baseVersion },
        action.type === "create" && action.onRemote,
      );
      break;
    case "pushDelete":
      await pushDeletion(ctx, path, action.baseVersion);
      break;
  }
}

const localState = localStateOf;

/**
 * Reconcile a single path: gather its local (disk), remote (caller-supplied —
 * from the change-feed `version` hint or the full-list map), and index states,
 * then apply the action reconcile() chooses. When `localEntry` is omitted it is
 * scanned on demand (the engine path); the full pass passes the scanned entry to
 * reuse already-read bytes.
 */
export async function reconcilePath(
  ctx: SyncContext,
  path: string,
  remote: RemoteState | undefined,
  localEntry?: ScanEntry,
): Promise<void> {
  if (ignored(path)) return;
  const local = localEntry ?? scanLocalPath(ctx.root, path, ctx.index);
  // Unreadable = unknown, and there is no safe action on an unknown local state
  // (see scanOne). Leave the path exactly as it is; the next event or full pass
  // picks it up once it can be read.
  if (local?.unreadable) {
    ctx.summary.failed.push({ path, reason: "could not be read — left untouched, will retry" });
    return;
  }
  await applyAction(ctx, path, reconcile(localState(local), remote, ctx.index[path]), local);
}