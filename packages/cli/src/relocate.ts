import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, normalize, sep } from "node:path";
import { applyPause } from "./commands";
import { isDaemonAlive, type DirStatus } from "./daemon";
import { sendIpc } from "./ipc";
import { loadLinks, relocateLink } from "./links-store";
import { rootAlive } from "./sync-core";

// Changing where a workspace syncs (plan U8, R8/R9). Moving the folder — INCLUDING
// its `.treehouse/` — is what makes this cheap and safe:
//
//   * `checkRootLiveness` keys solely on `<root>/.treehouse/config.json` being a
//     readable file, and a root that fails that check SUPPRESSES delete
//     propagation (sync.ts refuses the whole pass; engine.ts suppresses every
//     mutation). So while the tree is in flight the old path simply reads as
//     missing — the team's files are never deleted on our behalf.
//   * The new path arrives with the key AND the local index intact, so there is
//     no re-grant and no full re-upload. (Re-syncing from remote instead was
//     rejected: slower, and it would discard local-only edits.)
//
// The ordering is load-bearing: pause -> move -> rewrite links.json -> resume.
// The links.json rewrite is the COMMIT POINT. Until it lands the old root is
// still the authoritative one, so an interrupted move degrades to "nothing
// happened" rather than to a split state.
//
// `planRelocation` is the pure half (all the refusals live there, with injected
// probes); everything below it is fs/daemon glue.

/** Why a relocation was refused. One reason per distinct thing to explain. */
export type RelocationRefusal =
  | "not-absolute"
  | "same-location"
  | "destination-inside-source"
  | "source-not-linked"
  | "source-not-alive"
  | "destination-not-empty"
  | "destination-is-linked"
  | "destination-nested-in-link";

export type RelocationStep =
  | { kind: "pause"; root: string }
  | { kind: "move"; from: string; to: string }
  /** Rewrite links.json. THE COMMIT POINT — before it, the old root is authoritative. */
  | { kind: "commit"; from: string; to: string }
  | {
      kind: "resume";
      root: string;
      /** The folder's pause state before the move, restored rather than cleared:
       * relocating a deliberately-paused folder must not silently start it syncing. */
      restorePaused: boolean;
    };

export type RelocationPlan =
  | { ok: true; steps: RelocationStep[] }
  | { ok: false; reason: RelocationRefusal; message: string };

/**
 * What the decision needs to know about the world. Probes are injected so the
 * planner never touches disk (tests pass fakes; `relocateFolder` passes the real
 * fs + registry).
 */
export interface RelocationFacts {
  /** The source is a registered link — the single entry the commit step rewrites. */
  isLinked: boolean;
  /** The source link is currently paused (restored after the move, not cleared). */
  paused: boolean;
  /** Root liveness: `.treehouse/config.json` present and readable (`rootAlive`). */
  isAlive: (root: string) => boolean;
  exists: (path: string) => boolean;
  /** Only consulted when `exists` is true. */
  isEmpty: (path: string) => boolean;
  /** Every OTHER registered root. Two separate traps live here:
   *  - moving onto a path that is already some link's root, which `relocateLink`
   *    only refuses AFTER the bytes have moved;
   *  - moving inside another synced folder, after which the outer workspace's
   *    recursive scan uploads this folder's entire contents into it. */
  otherRoots: string[];
}

/** Strip trailing separators so `/a/b` and `/a/b/` compare equal. */
function trimRoot(path: string): string {
  const n = normalize(path);
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/**
 * Whether `child` sits under `parent`. Compared case-INSENSITIVELY: the default
 * macOS filesystem is case-insensitive, so `~/Foo` and `~/foo/sub` are the same
 * recursion trap, and over-refusing here is the safe direction.
 */
function isInside(parent: string, child: string): boolean {
  return trimRoot(child)
    .toLowerCase()
    .startsWith(`${trimRoot(parent).toLowerCase()}${sep}`);
}

/**
 * Decide whether a folder may be moved from `from` to `to`, and in what order.
 *
 * Refuses rather than improvises — a refusal carries a reason code AND a
 * sentence, because the menubar has to explain itself, and every refusal here is
 * a case where a "helpful" recovery would risk the user's files:
 *
 *   - a destination nested inside the source would recurse into itself;
 *   - an existing NON-EMPTY destination would mean adopting (and therefore
 *     uploading) whatever already lives there — the same never-adopt rule the
 *     onboarding folder step enforces. An existing EMPTY destination is fine:
 *     a folder picker can only ever hand back a directory that exists;
 *   - a source that is not alive has already been moved or deleted behind our
 *     back, so we have no idea what we would be moving.
 */
export function planRelocation(from: string, to: string, facts: RelocationFacts): RelocationPlan {
  if (!isAbsolute(from) || !isAbsolute(to)) {
    return {
      ok: false,
      reason: "not-absolute",
      message: "Choose a full path for the folder's new location.",
    };
  }
  if (trimRoot(from) === trimRoot(to)) {
    return {
      ok: false,
      reason: "same-location",
      message: "That's already where this folder syncs.",
    };
  }
  if (isInside(from, to)) {
    return {
      ok: false,
      reason: "destination-inside-source",
      message: "A folder can't be moved inside itself — pick a location outside it.",
    };
  }
  if (!facts.isLinked) {
    return {
      ok: false,
      reason: "source-not-linked",
      message: `Treehouse isn't syncing ${from}, so there's nothing to move.`,
    };
  }
  if (!facts.isAlive(from)) {
    return {
      ok: false,
      reason: "source-not-alive",
      message: `Treehouse can't find ${from} — it looks like it was already moved, renamed or deleted. Reconnect it before changing its location.`,
    };
  }
  // Checked BEFORE the move, not after. relocateLink refuses a destination that is
  // already a registered root, but it runs at the commit step — by which point a
  // same-volume renameSync has already destroyed the source atomically, leaving
  // nothing to roll back to and no way to retry (the source now fails its own
  // liveness check, and the picker refuses the non-empty destination).
  const clash = facts.otherRoots.find(
    (r) => trimRoot(r).toLowerCase() === trimRoot(to).toLowerCase(),
  );
  if (clash) {
    return {
      ok: false,
      reason: "destination-is-linked",
      message: `Treehouse already syncs a folder at ${to}. Pick a different location.`,
    };
  }
  const nestUnder = facts.otherRoots.find((r) => isInside(r, to));
  if (nestUnder) {
    return {
      ok: false,
      reason: "destination-nested-in-link",
      message: `That location is inside ${nestUnder}, which Treehouse already syncs — this folder's files would be uploaded into that workspace too. Pick a location outside it.`,
    };
  }
  if (facts.exists(to) && !facts.isEmpty(to)) {
    return {
      ok: false,
      reason: "destination-not-empty",
      message: `${to} already has files in it. Choose an empty folder or a new one — Treehouse never merges into a folder that isn't empty.`,
    };
  }

  return {
    ok: true,
    steps: [
      // Stop the watcher FIRST: the daemon's `reload` awaits engine.stop(), so by
      // the time this resolves nothing is scanning the tree we are about to move.
      { kind: "pause", root: from },
      { kind: "move", from, to },
      { kind: "commit", from, to },
      { kind: "resume", root: to, restorePaused: facts.paused },
    ],
  };
}

// ---------------------------------------------------------------------------
// Wired half: the fs + daemon glue that executes a plan. No decisions here.

export type RelocationResult =
  | { ok: true; root: string }
  | { ok: false; reason: RelocationRefusal; message: string };

/** True only for a directory we can read and that has no entries at all. */
function dirIsEmpty(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false; // unreadable — treat as occupied and refuse
  }
}

/**
 * Move the tree, `.treehouse/` and all. A same-volume rename is atomic (and
 * succeeds onto an existing EMPTY directory). Across volumes we copy first and
 * only remove the source once the copy returned: a failure mid-copy then leaves
 * the original tree — still the one links.json points at — completely intact.
 */
/**
 * Walk `from` and return the first relative path that is absent (or a different
 * kind of thing) under `to`, or null when every entry arrived.
 *
 * Existence and kind only — not contents. A byte-for-byte comparison would double
 * the I/O of the copy for a case that is already rare, and the failure this guards
 * against is a TRUNCATED walk, not silent corruption. Bounded by the tree we just
 * copied, so it costs one extra stat per file.
 */
function firstMissingEntry(from: string, to: string, rel = ""): string | null {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const src = `${from}${sep}${entry.name}`;
    const dst = `${to}${sep}${entry.name}`;
    // lstatSync, not existsSync: existsSync follows symlinks, so a DANGLING symlink
    // at the destination reads as absent (fine) but a symlink pointing anywhere
    // real reads as present even when the thing it should be — a file, a directory —
    // never arrived. lstat asks about the entry itself, which is what "did this
    // entry copy?" actually means.
    let dstStat: ReturnType<typeof lstatSync> | null = null;
    try {
      dstStat = lstatSync(dst);
    } catch {
      return childRel; // missing entirely
    }
    // Same name, different kind, is not a successful copy.
    if (entry.isDirectory() !== dstStat.isDirectory()) return childRel;
    if (entry.isDirectory()) {
      const deeper = firstMissingEntry(src, dst, childRel);
      if (deeper !== null) return deeper;
    }
  }
  return null;
}

function moveTree(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true });
  // Verify BEFORE deleting the source — it is the only remaining copy until this
  // passes, and removing it first would turn a short copy into real data loss with
  // an error message claiming nothing was deleted.
  //
  // The marker check alone is not enough: `.treehouse/config.json` is one file near
  // the top of the walk, so a copy that died three quarters of the way through the
  // tree still has it. Compare the whole tree, so "the copy completed" means the
  // files are there rather than just the thing we happen to look for.
  if (!rootAlive(to)) {
    throw new Error(
      `The copy to ${to} didn't complete, so nothing was removed — your folder is still at ${from}. Clear ${to} before trying again.`,
    );
  }
  const missing = firstMissingEntry(from, to);
  if (missing !== null) {
    throw new Error(
      `The copy to ${to} is incomplete (${missing} didn't arrive), so nothing was removed — your folder is still at ${from}. Clear ${to} before trying again.`,
    );
  }
  rmSync(from, { recursive: true, force: true });
}

/**
 * Wait until the daemon confirms it is no longer supervising `root`, or that it
 * isn't running at all. Throws if neither becomes true in time.
 *
 * This exists because `applyPause` cannot tell us: it discards sendIpc's result,
 * and sendIpc resolves `null` on timeout, so "paused" and "the daemon never
 * answered" are indistinguishable to its caller. Relocation is the one caller
 * that cannot treat those the same — the whole safety argument for moving rather
 * than re-syncing assumes nothing is writing into the tree.
 */
async function confirmPaused(root: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isDaemonAlive()) return; // nothing is scanning anything
    const res = (await sendIpc({ cmd: "status" })) as { dirs?: DirStatus[] } | null;
    const dir = res?.dirs?.find((d) => d.root === root);
    // Gone from the daemon's list, or reported paused → the engine has stopped.
    if (res && (!dir || dir.state === "paused")) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Treehouse couldn't confirm that syncing stopped for ${root}, so nothing was moved. Try again in a moment — moving while it is still syncing could corrupt the folder.`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Change where a linked folder syncs. Returns the planner's refusal (with a
 * sentence to show) when the move isn't permissible; throws only when a step
 * fails midway, with a message that says where the files ended up.
 */
export async function relocateFolder(from: string, to: string): Promise<RelocationResult> {
  const link = loadLinks().find((l) => l.root === from);
  const plan = planRelocation(from, to, {
    isLinked: link !== undefined,
    paused: link?.paused === true,
    isAlive: rootAlive,
    exists: existsSync,
    isEmpty: dirIsEmpty,
    otherRoots: loadLinks()
      .map((l) => l.root)
      .filter((r) => r !== from),
  });
  if (!plan.ok) return plan;

  // Pausing writes `paused: true` into links.json — DURABLE state, not a runtime
  // flag. So every failure path after the pause has to put it back, or a folder
  // that merely failed to move silently stops syncing and nothing ever resumes it,
  // across restarts. The compensating action targets whichever root is currently
  // authoritative: before the commit that is still the old one.
  let committed = false;
  let moved = false;
  const wasPaused = link?.paused === true;
  try {
    for (const step of plan.steps) {
      switch (step.kind) {
        case "pause":
          await applyPause(step.root, true);
          // applyPause is FIRE-AND-FORGET: it sends `reload` and discards the
          // result, and sendIpc gives up after 2.5s while the daemon's reload
          // awaits engine.stop() — which waits out a whole in-flight transfer. On
          // a large folder that returns long before the watcher has stopped, and
          // then we would copy a tree the engine is still writing into.
          //
          // So confirm it actually stopped before touching any bytes. A daemon
          // that never confirms is a refusal, not a warning: moving anyway is the
          // one thing that turns a failed relocation into a corrupted one.
          await confirmPaused(step.root);
          break;
        case "move":
          moveTree(step.from, step.to);
          moved = true;
          // Re-check at the destination before committing: if the move didn't land
          // the key and index there, the old root stays authoritative and the
          // daemon reports a lost folder — it never propagates a delete.
          if (!rootAlive(step.to)) {
            throw new Error(
              `The folder didn't arrive intact at ${step.to}, so Treehouse left its records pointing at ${step.from}. Check both paths before trying again.`,
            );
          }
          break;
        case "commit":
          if (!relocateLink(step.from, step.to)) {
            throw new Error(
              `The folder was moved to ${step.to}, but Treehouse couldn't update its records. Your files are safe at that path; syncing stays stopped until you connect it again.`,
            );
          }
          committed = true;
          break;
        case "resume":
          await applyPause(step.root, step.restorePaused);
          break;
      }
    }
  } catch (e) {
    // Restore the folder's original pause state at whichever path still owns it.
    // Best-effort: a failure here must not replace the real error with its own.
    //
    // EXCEPT when the tree has moved but the link has not been updated. There the
    // link still names `from`, which no longer exists, so restoring `wasPaused`
    // (false, for the common case of an active folder) would resume the daemon on a
    // dead root — and the error the user just read says syncing stays stopped.
    // Delete propagation is suppressed either way, so nothing is lost, but the
    // folder would report as lost and the message would be a lie. Stay paused: that
    // is both the safer state and the one we promised.
    const strandedMidMove = moved && !committed;
    try {
      await applyPause(committed ? to : from, strandedMidMove ? true : wasPaused);
    } catch {
      // nothing further to offer — the original error below is the useful one
    }
    throw e;
  }
  return { ok: true, root: to };
}