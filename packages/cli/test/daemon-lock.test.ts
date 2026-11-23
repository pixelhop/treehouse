import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { daemonInstallLockPath, withDaemonInstallLock } from "../src/daemon-lock";

// The lock exists because an atomic rename only protects READERS. Two installers
// (the CLI's convergeStableDaemon and the desktop app's ownership monitor) each
// read the installed version, decide, then rename — so without mutual exclusion the
// LAST writer wins and an older build can overwrite a newer daemon.

let home: string;
const saved = process.env.TREEHOUSE_HOME;

/** A pid that is definitely not running, for the "crashed holder" cases. Walks up
 * from an implausible value until it finds one the OS reports as gone. */
function deadPid(): number {
  for (let pid = 999_000; pid < 999_999; pid++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a dead pid for the test");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "th-lock-"));
  process.env.TREEHOUSE_HOME = home;
  mkdirSync(dirname(daemonInstallLockPath()), { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env.TREEHOUSE_HOME;
  else process.env.TREEHOUSE_HOME = saved;
});

describe("withDaemonInstallLock", () => {
  it("runs the critical section and returns its value", () => {
    const out = withDaemonInstallLock(() => "swapped");
    expect(out.acquired).toBe(true);
    expect(out.value).toBe("swapped");
  });

  it("releases the lock afterwards so the next installer can take it", () => {
    withDaemonInstallLock(() => 1);
    expect(existsSync(daemonInstallLockPath())).toBe(false);
    expect(withDaemonInstallLock(() => 2).acquired).toBe(true);
  });

  it("releases the lock even when the critical section throws", () => {
    expect(() =>
      withDaemonInstallLock(() => {
        throw new Error("ENOSPC");
      }),
    ).toThrow("ENOSPC");
    // A crashed swap must not wedge every future update behind a held lock.
    expect(existsSync(daemonInstallLockPath())).toBe(false);
  });

  it("refuses to enter while a LIVE holder has the lock", () => {
    // Our own pid is definitively alive.
    writeFileSync(daemonInstallLockPath(), String(process.pid));
    let ran = false;
    const out = withDaemonInstallLock(
      () => {
        ran = true;
        return true;
      },
      { timeoutMs: 100 },
    );
    // Not acquired ⇒ the caller must leave the path alone, NOT write anyway.
    expect(out.acquired).toBe(false);
    expect(ran).toBe(false);
  });

  it("will NOT break a live holder's lock however old it looks", () => {
    // The whole point of keying on liveness rather than age: a slow installer is
    // not an abandoned one. An age rule would hand the lock to a second writer
    // here and put both inside the critical section.
    const lock = daemonInstallLockPath();
    writeFileSync(lock, String(process.pid));
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, longAgo, longAgo);

    const out = withDaemonInstallLock(() => true, { timeoutMs: 100 });
    expect(out.acquired).toBe(false);
    expect(existsSync(lock)).toBe(true); // left intact for its live owner
  });

  it("reclaims a lock whose holder process is gone (crashed installer)", () => {
    const lock = daemonInstallLockPath();
    writeFileSync(lock, String(deadPid()));

    let ran = false;
    const out = withDaemonInstallLock(
      () => {
        ran = true;
        return true;
      },
      { timeoutMs: 500 },
    );
    expect(out.acquired).toBe(true);
    expect(ran).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("reclaims a dead holder's lock immediately, without waiting out a timeout", () => {
    writeFileSync(daemonInstallLockPath(), String(deadPid()));
    const started = Date.now();
    // timeoutMs is the budget for waiting on a LIVE holder; a dead one shouldn't
    // consume any of it.
    expect(withDaemonInstallLock(() => true, { timeoutMs: 5000 }).acquired).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("leaves a successor's lock alone if ours was reclaimed mid-critical-section", () => {
    // Simulates the dangerous interleaving: while we hold the lock, another process
    // reclaims the path and installs its own. Our release must not delete THEIR
    // lock — that would drop a live holder out of mutual exclusion.
    const lock = daemonInstallLockPath();
    const out = withDaemonInstallLock(() => {
      rmSync(lock, { force: true }); // our lock is reclaimed…
      writeFileSync(lock, String(process.pid)); // …and a successor takes the path
      return "done";
    });
    expect(out.acquired).toBe(true);
    expect(existsSync(lock)).toBe(true); // successor's lock survived our release
    rmSync(lock, { force: true });
  });

  it("does not reclaim an unreadable lock until it is well past the grace period", () => {
    const lock = daemonInstallLockPath();
    writeFileSync(lock, ""); // a holder mid-write has no readable pid yet
    const out = withDaemonInstallLock(() => true, { timeoutMs: 100 });
    expect(out.acquired).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it("gives up (bounded) when the lock can never be created at all", () => {
    // A non-EEXIST failure — read-only/undeletable lock directory, ENOSPC — means
    // the lock file never appears, so there is no holder to read and nothing to
    // stat. Every retry path must still respect the deadline: the loop used to
    // `continue` straight past the deadline check and spin at 100% CPU forever,
    // never returning, regardless of timeoutMs.
    const lock = daemonInstallLockPath();
    mkdirSync(dirname(lock), { recursive: true });
    chmodSync(dirname(lock), 0o500); // r-x: can't create entries here
    try {
      const started = Date.now();
      const out = withDaemonInstallLock(() => true, { timeoutMs: 200 });
      expect(out.acquired).toBe(false);
      expect(Date.now() - started).toBeLessThan(5000); // returned, didn't spin
    } finally {
      chmodSync(dirname(lock), 0o700);
    }
  });

  it("nests under the stable daemon path so both installers derive the same lock", () => {
    expect(daemonInstallLockPath().startsWith(home)).toBe(true);
    expect(daemonInstallLockPath().endsWith(".lock")).toBe(true);
  });
});