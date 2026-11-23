import { ApiClient, AuthError, type RemoteChange } from "./api-client";
import type { Config } from "./config";
import { loadCursor, saveCursor } from "./cursor-store";
import { type IndexMap, loadIndex, saveIndex } from "./index-store";
import type { RemoteState } from "./reconcile";
import {
  applyAction,
  checkRootLiveness,
  type Liveness,
  maxFileBytes,
  reconcilePath,
  type SyncContext,
  type SyncNotice,
  type SyncSummary,
} from "./sync-core";
import { runSync } from "./sync";
import { startWatcher, type Watcher, type WatcherOptions } from "./watcher";

// ---------------------------------------------------------------------------
// Incremental near-real-time engine. Replaces the 5s full-scan poll loop with:
//   • a bootstrap (full reconcile once), then
//   • a change-feed poller (cloud->local deltas via ?sinceSeq), and
//   • a filesystem watcher (local->cloud, instant), feeding
//   • a coalescing queue whose work is SERIALIZED so index.json and cursor.json
//     never have racing writers, with a periodic full reconcile as the safety net.
// The pure reconcile decision (reconcile.ts) and per-path apply (sync-core.ts)
// are reused unchanged; this module only schedules them.
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;
const DEFAULT_RECONCILE_MS = 5 * 60_000;
const PAGE_LIMIT = 500;
// How many paths to reconcile at once when draining a burst (e.g. a deleted
// folder with hundreds of children). Bounded so we don't flood the API.
const CONCURRENCY = 8;

// What a queued path needs reconciling against:
//   { remote }      — a poller event hint (the remote version, or undefined=deleted)
//   { local }       — a watcher event (remote derived from the index at process time)
//   { accessLost }  — an access_revoked event: drop the local copy unconditionally
export type Hint = { remote: RemoteState | undefined } | { local: true } | { accessLost: true };

/** Coalesce a new hint onto any pending one for the same path. */
export function coalesceHint(existing: Hint | undefined, incoming: Hint): Hint {
  // Losing access supersedes any other pending work for the path — the local
  // copy is going away regardless of a concurrent edit or remote version.
  if ("accessLost" in incoming) return incoming;
  if (existing && "accessLost" in existing) return existing;
  // A poller hint carries real remote state and always wins; a watcher hint must
  // not clobber a pending poller hint (local change is re-detected from disk
  // anyway when the path is reconciled).
  if ("local" in incoming) return existing && "remote" in existing ? existing : incoming;
  return incoming;
}

/**
 * Skip a change-feed event we already reflect: a non-delete event whose version
 * equals our index baseline for that path. Covers self-echo (our own push) and
 * already-applied pulls. Deletes never skip — they must drive deleteLocal /
 * resurrection through reconcile.
 */
export function shouldSkipChange(
  index: IndexMap,
  c: RemoteChange,
  // Paths an earlier event in the same page already queued. The index predates
  // the page, so for them it can't say whether this event is an echo: a file at
  // v1 that is deleted and then restored from the trash comes back as v1, and
  // skipping that restore would leave the delete to win until the next full
  // reconcile. Hints coalesce last-wins, so the later event must be queued.
  queuedThisPage?: ReadonlySet<string>,
): boolean {
  // Deletes and access-revocations never skip — both drive a local removal that
  // an index-version match must not suppress. (access_revoked carries a null
  // version today, but guard on the op so a future non-null version can't make
  // it skip and silently leave a private file on disk.)
  if (c.op === "delete" || c.op === "access_revoked") return false;
  if (queuedThisPage?.has(c.path)) return false;
  return c.version !== null && index[c.path]?.version === c.version;
}

const ACCESS_WORDS: Record<string, string> = {
  role: "you have view-only access to this workspace",
  grant: "you have view-only access to this item",
  key: "this folder's key is read-only",
  key_folder: "that's outside what this folder's key can reach",
};

/** One refused change, in words for the sync log and `treehouse sync`. */
export function readOnlyLine(n: SyncNotice): string {
  const why = ACCESS_WORDS[n.reason] ?? "you don't have write access";
  if (n.outcome === "reverted") {
    return `reverted ${n.path} — ${why}. Your edit is saved at ${n.savedTo}`;
  }
  if (n.outcome === "restored") return `restored ${n.path} — ${why}, so it can't be deleted`;
  return `not uploaded: ${n.path} — ${why}`;
}

const emptySummary = (): SyncSummary => ({
  pulled: [],
  pushed: [],
  deleted: [],
  conflicts: [],
  refusedDeletes: [],
  oversize: [],
  readOnly: [],
  failed: [],
});

// A live folder-state transition reported to the supervising daemon so `status`
// reflects real progress instead of a single write-at-start.
//   synced       — caught up and idle
//   transferring — actively pushing/pulling this cycle
//   error        — root lost, or a transient network failure (reason attached)
//   auth-lost    — 401/403: key revoked/expired, terminal until re-auth
export type EngineState =
  | { state: "synced" }
  | { state: "transferring" }
  | { state: "error"; reason: string }
  | { state: "auth-lost"; reason: string };

export interface EngineOptions {
  pollIntervalMs?: number;
  reconcileIntervalMs?: number;
  log?: (msg: string) => void;
  /** Injected client (tests); defaults to a real ApiClient(cfg). */
  api?: ApiClient;
  /** Injected filesystem-watcher backend (tests); defaults to chokidar. */
  watchFactory?: WatcherOptions["watchFactory"];
  /** Notified of local changes the server refused, once per change. */
  onNotice?: (notices: SyncNotice[]) => void;
  /** Notified when the folder's live state changes (root lost / recovered). */
  onState?: (s: EngineState) => void;
}

export interface Engine {
  bootstrap(): Promise<void>;
  /** Run one poll cycle; returns whether the page was full (more to drain). */
  pollOnce(): Promise<{ applied: number; head: number; full: boolean }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  degraded(): boolean;
}

export function createEngine(root: string, cfg: Config, opts: EngineOptions = {}): Engine {
  const api = opts.api ?? new ApiClient(cfg);
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const reconcileMs = opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;
  const log = opts.log ?? (() => {});
  const onState = opts.onState ?? (() => {});

  let index: IndexMap = loadIndex(root, cfg.workspaceId);
  let cursor = 0;
  let indexDirty = false;
  // Oversized-file warnings are emitted once per path for the process lifetime,
  // not on every poll — this set survives across drains for that dedup.
  const oversizeWarned = new Set<string>();
  // Likewise new files the server refused, so they aren't re-offered every pass.
  const refusedCreates = new Map<string, string>();

  const pending = new Map<string, Hint>();
  let watcher: Watcher | undefined;
  let running = false;
  // Set by stop(). `start()` is a long await (a full bootstrap) that the
  // supervisor can stop midway — on shutdown, or on a reload that unlinks or
  // re-keys the folder. Without this flag the rest of start() would carry on
  // afterwards and bring up a watcher and poll loop nobody holds a handle to.
  let stopped = false;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let wake: (() => void) | undefined; // resolves the poll-loop sleep early on stop

  // Root-liveness state (R12). While the root's marker file is absent/unreadable
  // the engine suppresses ALL mutation — no delete propagation (the whole point:
  // a moved folder must never wipe the team's files) and no pulls/writes (which
  // would recreate directories under a dead root). `recovered` fires one full
  // reconcile when the marker reappears so we catch up on remote changes made
  // while lost, without re-uploading unchanged files (the on-disk index matches).
  let liveness: Liveness = "alive";
  let recovered = false;

  // Reported folder state, deduped: onState fires only on an actual transition,
  // so an idle caught-up engine doesn't re-emit `synced` every poll.
  let reportedState: EngineState | undefined;
  function report(s: EngineState): void {
    if (reportedState && JSON.stringify(reportedState) === JSON.stringify(s)) return;
    reportedState = s;
    onState(s);
  }

  function ensureAlive(): boolean {
    const next = checkRootLiveness(root);
    if (next !== liveness) {
      liveness = next;
      if (next === "alive") {
        recovered = true;
        log("folder reappeared — resuming sync");
        report({ state: "synced" });
      } else {
        const reason =
          next === "unreadable"
            ? "folder unreadable (permission denied?)"
            : "folder moved or deleted?";
        log(`sync suspended: ${reason}`);
        report({ state: "error", reason });
      }
    }
    return liveness === "alive";
  }

  // Single-threaded executor: every index/cursor mutation runs here, in order,
  // so there is never more than one writer and "flush index before cursor" holds.
  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  function enqueue(path: string, hint: Hint): void {
    pending.set(path, coalesceHint(pending.get(path), hint));
  }

  // Drain the coalescing queue to empty, then persist the index once. Newly
  // enqueued paths (e.g. from the watcher firing mid-drain) are picked up by the
  // while-loop, so a burst collapses to one apply per path. Returns the number
  // of paths whose reconcile threw — the poller uses this to avoid advancing the
  // cursor past an event it failed to apply (which would otherwise skip it until
  // the periodic reconcile).
  async function drainPending(): Promise<number> {
    if (pending.size === 0) return 0;
    // Root-liveness gate for the watcher path (R12): a Finder move/rename of the
    // root fires an `unlink` per file, each queued as a `{ local: true }` hint
    // that would reconcile to a `pushDelete`. If the marker is gone, drop the
    // whole burst unapplied — this is the delete flood that fires within seconds
    // of a drag and has no mass-delete guard of its own.
    if (!ensureAlive()) {
      pending.clear();
      return 0;
    }
    report({ state: "transferring" });
    const ctx: SyncContext = {
      root,
      api,
      index,
      summary: emptySummary(),
      oversizeWarned,
      refusedCreates,
    };
    let failures = 0;
    // A revoked key surfaces on the transfer path too (get/put/delete), not only
    // on `changes()`. Left as a plain per-path failure it would be logged and
    // then buried under this drain's closing `synced` report — the daemon would
    // read as healthy while every write 401s. Hold the first one and finish the
    // drain (so successful paths still flush), then report + rethrow below.
    let authFailure: AuthError | undefined;

    const reconcileOne = async (path: string, hint: Hint): Promise<void> => {
      try {
        if ("accessLost" in hint) {
          // Forced removal — bypass reconcile() so an unpushed local edit can't
          // resurrect a node we no longer have access to.
          await applyAction(ctx, path, { type: "accessLost" });
        } else {
          const remote: RemoteState | undefined =
            "remote" in hint
              ? hint.remote
              : index[path]
                ? { version: index[path].version }
                : undefined;
          await reconcilePath(ctx, path, remote);
        }
        indexDirty = true;
      } catch (e) {
        failures += 1;
        if (e instanceof AuthError) authFailure ??= e;
        log(`reconcile ${path} failed: ${errMsg(e)}`);
      }
    };

    // Apply paths in bounded-parallel batches so a bulk change (deleting a
    // folder with hundreds of children, an unzip, a big pull) doesn't become a
    // long line of one-at-a-time round trips. Paths are independent (distinct
    // index keys); the whole drain runs inside one `exclusive` turn and the
    // index is persisted once below, so the single-writer invariant holds. Paths
    // enqueued mid-drain (e.g. the watcher firing) are picked up by the loop.
    while (pending.size > 0) {
      const batch: Array<[string, Hint]> = [];
      for (const path of pending.keys()) {
        batch.push([path, pending.get(path) as Hint]);
        if (batch.length >= CONCURRENCY) break;
      }
      for (const [path] of batch) pending.delete(path);
      await Promise.all(batch.map(([path, hint]) => reconcileOne(path, hint)));
    }

    if (indexDirty) {
      saveIndex(root, index, cfg.workspaceId);
      indexDirty = false;
    }
    logSummary(ctx.summary);
    // A typed auth failure is terminal, so it must not be papered over by the
    // `synced` report below. Report it here (covering the watcher drain, which
    // has no poll-loop wrapper) and rethrow so the poll path leaves the cursor
    // put and backs off instead of advancing over events it never applied.
    if (authFailure) {
      report({
        state: "auth-lost",
        reason: "sign-in required — the workspace key was revoked or expired",
      });
      throw authFailure;
    }
    // Transfer done: settle back to idle. A non-auth failure leaves the drain to
    // be retried, but the folder is still "synced" from the user's view (the
    // poller's own error reporting owns the transient unhappy paths).
    report({ state: "synced" });
    return failures;
  }

  function logSummary(s: SyncSummary): void {
    const parts: string[] = [];
    if (s.pulled.length) parts.push(`↓ ${s.pulled.length}`);
    if (s.pushed.length) parts.push(`↑ ${s.pushed.length}`);
    if (s.deleted.length) parts.push(`✗ ${s.deleted.length}`);
    if (parts.length) log(`synced  ${parts.join("  ")}`);
    for (const c of s.conflicts) log(`⚠ conflict — both kept: ${c}`);
    logOversize(s);
    reportReadOnly(s);
  }

  // A change the server refused is the user's own work coming back, so it gets
  // said twice: the sync log for the record, and `onNotice` for the desktop app,
  // which has no other way to learn of it (the folder itself is still healthy).
  function reportReadOnly(s: SyncSummary): void {
    for (const n of s.readOnly) log(`⚠ ${readOnlyLine(n)}`);
    if (s.readOnly.length > 0) opts.onNotice?.(s.readOnly);
  }

  function logOversize(s: SyncSummary): void {
    for (const o of s.oversize) {
      log(`⚠ skipped ${o} — exceeds the ${maxFileBytes()}-byte upload limit`);
    }
  }

  // Paths a full pass couldn't apply. They kept their old baseline, so the next
  // pass (or a watcher event) retries them; the rest of the workspace is synced
  // and baselined either way. Logged rather than raised as a folder error: a
  // handful of flaky transfers is a transient condition the retry loop owns.
  function logFailures(s: SyncSummary): void {
    for (const f of s.failed) log(`⚠ ${f.path} — ${f.reason} (will retry)`);
  }

  // The full pass, shared by bootstrap / the periodic safety net / an access
  // regain. Threads the engine-owned `oversizeWarned` set through so an
  // over-limit file is reported once per process instead of being skipped
  // silently here (runSync's own summary is otherwise discarded) or re-warned on
  // every reconcile. Also adopts the baseline runSync persisted.
  async function fullSync(): Promise<SyncSummary> {
    const summary = await runSync(root, cfg, api, oversizeWarned, refusedCreates);
    index = loadIndex(root, cfg.workspaceId); // runSync persisted its own baseline; adopt it
    logOversize(summary);
    reportReadOnly(summary);
    logFailures(summary);
    // Retry the paths that failed on the next poll rather than waiting for the
    // 5-minute safety net. A `local` hint makes the drain re-derive both sides
    // (disk scan + the now-persisted baseline) rather than trusting a stale
    // remote version from this pass.
    for (const f of summary.failed) enqueue(f.path, { local: true });
    return summary;
  }

  async function bootstrap(): Promise<void> {
    // Read head BEFORE the full list so a write landing during runSync is not
    // lost: it gets seq > cursor and is replayed by the poller.
    const headBefore = (await api.changes(0, 0)).head;
    const summary = await fullSync();
    cursor = headBefore;
    saveCursor(root, cursor);
    log(
      `bootstrap: ${summary.pulled.length}↓ ${summary.pushed.length}↑ ${summary.deleted.length}✗`,
    );
    if (summary.refusedDeletes.length) {
      log(
        `⚠ kept ${summary.refusedDeletes.length} local file(s) the remote was missing (looks like a reset or wrong workspace) — re-uploaded instead of deleting`,
      );
    }
  }

  async function pollOnce(): Promise<{ applied: number; head: number; full: boolean }> {
    return exclusive(async () => {
      // Root-liveness gate for the poll path (R12): while lost, skip the whole
      // cycle — no network, no apply (a pull would writeAtomic into a dead root).
      // The next cycle re-checks the marker and re-attaches when it reappears.
      if (!ensureAlive()) return { applied: 0, head: 0, full: false };
      try {
        return await pollBody();
      } catch (e) {
        // Classify a network/API failure by TYPE, never by message string: a
        // 401/403 is a terminal auth loss (key revoked/expired), anything else is
        // transient. Report the state, then rethrow so the poll loop backs off and
        // retries — a transient error recovers to `synced` on the next good poll.
        if (e instanceof AuthError) {
          report({
            state: "auth-lost",
            reason: "sign-in required — the workspace key was revoked or expired",
          });
        } else {
          report({ state: "error", reason: "waiting to reconnect" });
        }
        throw e;
      }
    });
  }

  async function pollBody(): Promise<{ applied: number; head: number; full: boolean }> {
    if (recovered) {
      // Marker reappeared: catch up on remote changes made while we were lost.
      // runSync reads the on-disk index (which came back with the folder), so
      // unchanged files reconcile to no-ops and are not re-uploaded. Clear the
      // flag only AFTER a successful catch-up — if runSync throws (a transient
      // network blip), the next poll must retry the catch-up, not skip it.
      const headBefore = (await api.changes(0, 0)).head;
      await runSync(root, cfg, api);
      index = loadIndex(root, cfg.workspaceId);
      cursor = Math.max(cursor, headBefore);
      saveCursor(root, cursor);
      recovered = false;
    }
    const { changes, head, nextSeq } = await api.changes(cursor, PAGE_LIMIT);
    let applied = 0;
    let regainedAccess = false;
    const queued = new Set<string>();
    for (const c of changes) {
      // Regaining access to a subtree: the files aren't local yet, so a
      // single-path hint can't enumerate them (the event sits on the folder
      // root). Defer to a full reconcile after the drain, which re-lists.
      if (c.op === "access_granted") {
        regainedAccess = true;
        applied++;
        continue;
      }
      if (shouldSkipChange(index, c, queued)) continue;
      const hint: Hint =
        c.op === "access_revoked"
          ? { accessLost: true }
          : c.op === "delete" || c.version === null
            ? { remote: undefined }
            : { remote: { version: c.version } };
      enqueue(c.path, hint);
      queued.add(c.path);
      applied++;
    }
    const failures = await drainPending(); // applies + flushes index BEFORE the cursor advances
    if (regainedAccess) {
      // Pull the now-visible files. runSync re-lists the whole workspace, so it
      // picks up everything the access grant exposed regardless of subtree size.
      // Via fullSync (not a bare runSync) so this path keeps sharing the engine's
      // `oversizeWarned` set and still reports oversize files.
      await fullSync();
    }
    // Only advance the cursor when every event in this window applied. If any
    // failed, leave the cursor put so the next poll re-fetches and retries the
    // window (succeeded paths re-apply as no-ops). Don't drain-immediately on a
    // failed full page, or we'd busy-loop the same failing window — fall through
    // to the poll-interval sleep as backoff.
    //
    // Advance on `nextSeq` (the last *scanned* seq, ACL-blind) not the last
    // visible event, so a page filtered entirely to `[]` for this caller still
    // moves the cursor forward instead of livelocking on the same window. Fall
    // back to the last visible event for a server that predates nextSeq.
    const advanceTo = nextSeq ?? (changes.length > 0 ? changes[changes.length - 1].seq : cursor);
    if (failures === 0 && advanceTo > cursor) {
      cursor = advanceTo;
      saveCursor(root, cursor);
    }
    // More to drain immediately when the scan stopped short of head (a page
    // truncated by the limit, whether or not its rows were visible to us).
    const full =
      failures === 0 && (nextSeq !== undefined ? nextSeq < head : changes.length >= PAGE_LIMIT);
    // Caught up (no more to drain) → settle to idle. When `full`, more pages
    // remain — stay in whatever transferring state the drain reported.
    if (!full) report({ state: "synced" });
    return { applied, head, full };
  }

  async function periodicReconcile(): Promise<void> {
    // Swallow transient network/API errors — a failed reconcile must not crash
    // the long-running daemon; the next interval retries.
    try {
      await exclusive(async () => {
        // A lost root would make runSync short-circuit and loadIndex read an
        // empty baseline off the dead path, clobbering our in-memory index — so
        // skip the whole reconcile while lost (and never advance the cursor).
        if (!ensureAlive()) return;
        const headBefore = (await api.changes(0, 0)).head;
        await fullSync();
        cursor = Math.max(cursor, headBefore);
        saveCursor(root, cursor);
        log("periodic reconcile complete");
      });
    } catch (e) {
      log(`periodic reconcile failed: ${errMsg(e)}`);
    }
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        const { full } = await pollOnce();
        if (full) continue; // page was full — drain the backlog immediately
      } catch (e) {
        log(`poll error: ${errMsg(e)}`);
      }
      await sleep(pollMs);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  async function start(): Promise<void> {
    const existing = loadCursor(root);
    if (existing !== undefined) cursor = existing;
    // If the root is already lost at start, skip bootstrap (a full reconcile that
    // would misread the empty scan and, worse, recreate dirs under the dead
    // path). The poll loop re-checks liveness and the recovery path runs the
    // catch-up reconcile once the marker reappears.
    if (ensureAlive() && existing === undefined) await bootstrap();
    if (stopped) return;

    watcher = startWatcher({
      root,
      onEvent: (e) => {
        enqueue(e.path, { local: true });
        void exclusive(drainPending).catch((err) => {
          log(`watcher drain failed: ${errMsg(err)}`);
        });
      },
      onDegrade: (reason) => log(`watcher degraded to polling (${reason})`),
      watchFactory: opts.watchFactory,
    });
    await watcher.ready;
    if (stopped) {
      await watcher.close();
      return;
    }

    running = true;
    void pollLoop();
    reconcileTimer = setInterval(() => void periodicReconcile(), reconcileMs);

    // On restart, bootstrap is skipped (the cursor already exists) and the
    // watcher ignores files that exist at startup — so local files added while
    // the daemon was down, or left unsynced by an interrupted run, would wait a
    // whole reconcile interval to upload. Run one reconcile now so they sync
    // promptly instead of up to `reconcileMs` later.
    if (existing !== undefined) void periodicReconcile();

    log(`watching ${root} (poll ${pollMs}ms, cursor ${cursor})`);
  }

  async function stop(): Promise<void> {
    stopped = true;
    running = false;
    wake?.();
    if (reconcileTimer) clearInterval(reconcileTimer);
    await watcher?.close();
    await chain; // let the in-flight exclusive turn finish
  }

  return {
    bootstrap,
    pollOnce,
    start,
    stop,
    degraded: () => watcher?.degraded() ?? false,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}