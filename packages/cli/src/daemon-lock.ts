import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { stableDaemonPath } from "./paths";

// Cross-process mutual exclusion for installs to the STABLE daemon path (U10's
// newest-wins rule). Two independent installers converge here — the CLI
// (`convergeStableDaemon`) and the desktop app's ownership monitor — and each one
// reads the installed version, decides, then copies+renames. An atomic rename only
// protects READERS: it guarantees nobody sees a half-written binary, but it does
// nothing about two writers who both read the same old version and then race to be
// last. The later (possibly OLDER) writer wins, silently downgrading the shared
// daemon. Holding this lock across read-decide-write closes that window.
//
// Recovery is by HOLDER LIVENESS, not by age. An age-based rule ("older than N
// seconds ⇒ break it") cannot tell a crashed holder from a slow one, so two waiters
// could both judge the same lock stale, and the second would delete the lock the
// first had just acquired — putting both inside the critical section and restoring
// exactly the older-writer-wins race this exists to prevent. Recording the holder's
// pid makes "is it abandoned?" a definitive question: a live holder is never broken,
// no matter how long it takes.

/** A lock whose holder is unparseable is only breakable once it is this old. */
const UNREADABLE_LOCK_GRACE_MS = 60_000;
/** How long to wait for a live holder before giving up. */
const DEFAULT_TIMEOUT_MS = 10_000;

export const daemonInstallLockPath = (): string => `${stableDaemonPath()}.lock`;

/** Block the current thread briefly — the lock is held across synchronous fs work,
 * so there is no event loop to yield to here. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is a pid still running? EPERM means it exists but isn't ours — still alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid recorded in a lock file, or null if it's missing/unparseable. */
function lockHolder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Try to remove an abandoned lock. `renameSync` is the atomic claim: if two waiters
 * both decide to break the same lock, exactly one rename finds the source and the
 * other fails with ENOENT. Breaking does NOT grant ownership — the winner still has
 * to win the O_EXCL create afterwards, which is the real arbiter.
 *
 * Re-checks liveness through the renamed handle and puts the file back if it turns
 * out to belong to a live holder that acquired between our decision and our rename.
 *
 * Returns true only if an abandoned lock was actually removed — the caller uses that
 * to decide whether retrying the acquire immediately could possibly help.
 */
function breakAbandonedLock(lock: string): boolean {
  const parked = `${lock}.abandoned-${process.pid}`;
  try {
    renameSync(lock, parked);
  } catch {
    return false; // someone else claimed the break, or it's already gone
  }
  const holder = lockHolder(parked);
  if (holder !== null && pidAlive(holder)) {
    // A live holder slipped in between our liveness check and the rename. Put it
    // back rather than stealing it; we'll go back to waiting.
    //
    // linkSync, NOT renameSync: rename would silently CLOBBER whatever is at `lock`
    // now. If a third process acquired in this gap, overwriting its lock would
    // displace a live holder and let two run concurrently — the very thing this
    // module exists to prevent. link fails with EEXIST instead, leaving the newer
    // lock untouched.
    try {
      linkSync(parked, lock); // restores the original inode at the lock path
    } catch {
      // A newer lock already owns the path — leave it alone.
    }
    rmSync(parked, { force: true });
    return false; // nothing abandoned was reclaimed
  }
  rmSync(parked, { force: true });
  return true;
}

/** Whether `path` still refers to the exact file we created (same inode). */
function stillOurs(path: string, ino: bigint): boolean {
  try {
    return statSync(path, { bigint: true }).ino === ino;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the daemon-install lock, then release it. Returns
 * `{ acquired: false }` if the lock could not be taken within `timeoutMs` — callers
 * treat that as "another installer is handling it", never as a reason to write
 * anyway. A lock whose holder process is gone is reclaimed, so a crashed installer
 * can't wedge every future update.
 */
export function withDaemonInstallLock<T>(
  fn: () => T,
  opts: { timeoutMs?: number } = {},
): { acquired: true; value: T } | { acquired: false; value?: undefined } {
  const lock = daemonInstallLockPath();
  try {
    mkdirSync(dirname(lock), { recursive: true });
  } catch {
    return { acquired: false }; // can't even make the directory — never acquire
  }
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let fd: number | undefined;
  for (;;) {
    // Bound EVERY path, including the ones that retry without sleeping. A `continue`
    // that skipped this check turned a persistent create failure into a 100%-CPU
    // spin that never returned, whatever timeoutMs said.
    if (Date.now() >= deadline) return { acquired: false };
    try {
      fd = openSync(lock, "wx"); // O_EXCL create — the atomic acquire
      break;
    } catch (e) {
      // Only EEXIST means "someone else holds it". Anything else (EACCES on the
      // directory, EROFS, ENOSPC) means we can never create the lock here, so
      // retrying is pointless — and we couldn't write the binary either.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { acquired: false };

      const holder = lockHolder(lock);
      if (holder !== null && !pidAlive(holder)) {
        // Retry at once only if we actually reclaimed it; otherwise fall through to
        // the sleep so a break that keeps failing can't spin.
        if (breakAbandonedLock(lock)) continue;
      } else if (holder === null) {
        // No readable pid: either mid-write by a live holder (retry shortly) or a
        // corrupt leftover. Only reclaim it once it's old enough to be neither.
        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          continue; // vanished — the deadline check above still bounds us
        }
        if (age > UNREADABLE_LOCK_GRACE_MS && breakAbandonedLock(lock)) continue;
      }
      sleepSync(50);
    }
  }

  const ino = fstatSync(fd, { bigint: true }).ino;
  try {
    writeSync(fd, String(process.pid));
    return { acquired: true, value: fn() };
  } finally {
    closeSync(fd);
    // Only remove the lock if the path STILL points at the file we created —
    // never delete a successor's lock if ours was reclaimed while we worked.
    if (stillOurs(lock, ino)) rmSync(lock, { force: true });
  }
}