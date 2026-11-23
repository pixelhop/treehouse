import { ApiClient, AuthError } from "./api-client";
import type { Config } from "./config";
import { loadIndex, saveIndex } from "./index-store";
import { type Action, reconcile, type RemoteState } from "./reconcile";
import {
  applyAction,
  checkRootLiveness,
  localStateOf,
  type ScanEntry,
  ScanIncompleteError,
  ignored,
  scanLocal,
  type SyncContext,
  type SyncSummary,
} from "./sync-core";

export type { SyncSummary } from "./sync-core";

// A full pass that would delete at least this many local files is treated as a
// destructive accident (remote reset, or a baseline from another workspace),
// not a real batch of user deletions — so the files are kept and re-uploaded.
const MASS_DELETE_LIMIT = 25;

// Flush the baseline to disk every N applied paths. A full pass over a large
// workspace takes minutes; without an intermediate flush, a quit/crash/kill
// midway loses EVERY baseline the pass earned, and the next pass sees a tree
// full of files with no index — which reconciles to `create`, i.e. re-uploading
// the whole workspace. Flushing bounds that loss to the last batch. saveIndex is
// atomic (tmp + rename), so a partial baseline is always a valid one.
const INDEX_FLUSH_EVERY = 100;

// Full reconcile pass: scan the whole tree, list the whole remote, reconcile the
// union of paths. Used for the one-shot `treehouse sync`, for the engine's
// initial bootstrap, and as the engine's periodic safety net. The per-path
// decision/apply logic lives in sync-core.ts.
// `oversizeWarned` lets a long-running caller (the watch engine) share one set
// across passes, so a file that stays over the limit is reported once for the
// process lifetime instead of on every full reconcile.
export async function runSync(
  root: string,
  cfg: Config,
  api: ApiClient = new ApiClient(cfg),
  oversizeWarned: Set<string> = new Set(),
  refusedCreates: Map<string, string> = new Map(),
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    pulled: [],
    pushed: [],
    deleted: [],
    conflicts: [],
    refusedDeletes: [],
    oversize: [],
    readOnly: [],
    failed: [],
  };

  // Root-liveness gate (R12): if the marker file is gone/unreadable, the tree
  // scan below would come back empty and every baselined file would reconcile to
  // a remote delete. Refuse the whole pass instead — leave the index untouched
  // and report the lost state — so a moved/trashed folder never wipes the team's
  // files. The full pass is one of the two propagation paths this guards; the
  // engine's watcher drain is the other.
  const liveness = checkRootLiveness(root);
  if (liveness !== "alive") {
    summary.rootLost = liveness;
    return summary;
  }

  const index = loadIndex(root, cfg.workspaceId);
  // `oversizeWarned` is the CALLER's set, not a fresh one: the watch engine shares
  // one across passes so a persistently-oversized file is reported once per
  // process rather than on every full reconcile.
  const ctx: SyncContext = { root, api, index, summary, oversizeWarned, refusedCreates };

  // A failed tree walk yields no entries, not "no files" — acting on it would
  // reconcile every baselined path to a remote delete. Refuse the pass the same
  // way a lost root does: nothing scanned, nothing propagated, index untouched.
  let local: Map<string, ScanEntry>;
  try {
    local = scanLocal(root, index);
  } catch (e) {
    if (e instanceof ScanIncompleteError) {
      summary.rootLost = "unreadable";
      return summary;
    }
    throw e;
  }
  const remoteList = await api.list();
  const remote = new Map<string, RemoteState>(
    remoteList.map((e) => [e.path, { version: e.version }]),
  );

  const paths = new Set<string>(
    [...local.keys(), ...remote.keys(), ...Object.keys(index)].filter((path) => !ignored(path)),
  );

  // Decide every action first, so a destructive mass-delete can be detected
  // before any file is touched. A local delete only fires when a baselined file
  // is missing from the remote; if the remote came back empty (reset/wrong
  // workspace) or a large batch would be deleted at once, that's almost never a
  // real intent to wipe the folder — keep the local files and re-upload them.
  const decisions = [...paths].map((path) => {
    const localEntry = local.get(path);
    // A file we couldn't read is a file we know nothing about, and BOTH ways of
    // guessing lose data: "absent" deletes the team's copy, "unchanged" lets a
    // remote change pull over an unpushed local edit with no conflicted copy.
    // Decide nothing, report it, retry next pass (see scanOne).
    if (localEntry?.unreadable) {
      summary.failed.push({ path, reason: "could not be read — left untouched, will retry" });
      return { path, localEntry, action: { type: "noop" } as Action };
    }
    const action = reconcile(localStateOf(localEntry), remote.get(path), index[path]);
    return { path, localEntry, action };
  });

  const deletions = decisions.filter((d) => d.action.type === "deleteLocal");
  const suspicious =
    deletions.length > 0 && (remote.size === 0 || deletions.length >= MASS_DELETE_LIMIT);
  if (suspicious) {
    for (const d of deletions) {
      d.action = { type: "create" } as Action; // keep local as the source of truth
      summary.refusedDeletes.push(d.path);
    }
  }

  // Apply per path, isolating failures. One unlucky path (a flaky upload, a
  // transient 5xx, an unreadable local file) must NOT abort the pass: an
  // exception escaping here would skip the saveIndex below, throwing away every
  // baseline the pass earned. The next attempt would then re-decide `create` for
  // everything already pulled and re-upload the whole workspace — and hit the
  // same bad path again, so a folder could never finish its first sync. Failed
  // paths keep their old baseline and are retried by the next pass.
  let applied = 0;
  let authFailure: AuthError | undefined;
  for (const d of decisions) {
    try {
      await applyAction(ctx, d.path, d.action, d.localEntry);
    } catch (e) {
      // A revoked/expired key is terminal, not per-path: every remaining request
      // would fail the same way. Stop the pass here and let the caller surface
      // the auth loss — but only after the baseline below is persisted.
      if (e instanceof AuthError) {
        authFailure = e;
        break;
      }
      summary.failed.push({ path: d.path, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (++applied % INDEX_FLUSH_EVERY === 0) saveIndex(root, index, cfg.workspaceId);
  }

  saveIndex(root, index, cfg.workspaceId);
  if (authFailure) throw authFailure;
  return summary;
}