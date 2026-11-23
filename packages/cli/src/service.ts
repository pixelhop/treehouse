import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isSea } from "node:sea";
import { withDaemonInstallLock } from "./daemon-lock";
import { logFilePath, stableDaemonPath } from "./paths";
import { currentVersion, isNewer } from "./update";

// Install the daemon as a per-user OS service so it autostarts on login and is
// restarted if it crashes. macOS → launchd LaunchAgent; Linux → systemd --user
// (XDG-autostart fallback); Windows → a Task Scheduler logon task. The template
// generators are pure (and tested); install/uninstall shell out to the OS.

const LABEL = "io.treehouse.daemon";

// The service paths (LaunchAgents plist, systemd unit) are machine-global and
// are NOT isolated by TREEHOUSE_HOME — so install/uninstall must never run under
// the test runner, or a test would clobber the developer's real autostart agent.
const underTestRunner = (): boolean => !!process.env.VITEST || process.env.NODE_ENV === "test";

export interface ServiceResult {
  installed: boolean;
  /**
   * Whether installing also started the daemon. launchd (RunAtLoad) and systemd
   * (`enable --now`) do; an XDG autostart entry and a Windows logon task only run
   * at the NEXT login, so the caller has to start this session's daemon itself —
   * otherwise `login` says "syncing now" over a folder that never fills.
   */
  startedNow?: boolean;
  /** Human-readable note (e.g. a platform caveat). */
  note?: string;
}

/** How to launch the daemon: the shared stable-path binary when one is installed,
 * else the packaged binary, or node + the bin shim in dev. argv[1] is resolved to
 * an absolute path so the service (which runs with cwd /) can find the entry.
 *
 * Converging on `stableDaemonPath()` is the U10 ownership rule: when the app (or a
 * prior install) has placed a daemon at the stable path, the CLI points launchd at
 * that SAME executable instead of baking its own `process.execPath`. Both installers
 * then target one binary, so neither fights the other and there is a single daemon. */
export function daemonInvocation(): { exec: string; args: string[] } {
  const stable = stableDaemonPath();
  if (existsSync(stable)) return { exec: stable, args: ["daemon"] };
  const args = isSea() ? ["daemon"] : [resolve(process.argv[1] ?? ""), "daemon"];
  return { exec: process.execPath, args };
}

/** Read a daemon binary's reported version (`<bin> version`), or null if unreadable. */
function binaryVersion(path: string): string | null {
  try {
    return execFileSync(path, ["version"], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * `binaryVersion` with one retry. A single failure is ambiguous: the binary may be
 * genuinely broken, or the 5s exec timeout may just have been unlucky on a loaded
 * machine. That distinction matters because "unreadable" triggers a REPAIR swap —
 * treating a transient timeout as a broken binary would let an older CLI overwrite
 * a perfectly good newer daemon, the exact downgrade the lock exists to prevent.
 * Two consecutive failures is strong evidence the binary can't run at all.
 */
function binaryVersionConfirmed(path: string): string | null {
  return binaryVersion(path) ?? binaryVersion(path);
}

/**
 * The other half of U10's newest-wins rule (the app owns the app half): if a stable
 * shared daemon already exists and THIS CLI's daemon is strictly newer, copy this
 * binary over the stable path so `treehouse update` actually advances the running
 * daemon instead of silently re-pinning launchd to an older app-installed binary.
 * Only meaningful for the packaged (SEA) CLI; a run-from-source build has no daemon
 * binary to contribute. Never runs under tests.
 *
 * `sourceVersion` is the version of the binary at `process.execPath`. It defaults to
 * this process's compiled-in version, but a caller that has just replaced its own
 * executable (`treehouse update`) MUST pass the downloaded version — the running
 * process still reports the old one, so the comparison would say "same version",
 * skip the copy, and leave the daemon pinned to the pre-update binary.
 *
 * The outcome is deliberately more than a boolean: "we didn't swap" covers both
 * "the stable binary is already current" (safe to restart onto) and "another
 * installer holds the lock, so we have NO IDEA what's at that path" (restarting
 * could relaunch an older daemon while reporting the new version). Callers that
 * restart must tell those apart — see `cmdUpdate`.
 */
export type ConvergeOutcome =
  /** We copied our binary over the stable path. */
  | "swapped"
  /** The stable binary is already at least as new as ours — nothing to do. */
  | "current"
  /** No stable binary to converge on, or this isn't a packaged CLI. */
  | "unavailable"
  /** Another installer held the lock past our timeout; the stable path is unknown. */
  | "locked"
  /** We tried to write the stable path and the filesystem refused (ENOSPC, EACCES,
   * read-only volume). The existing stable binary is untouched — the rename is
   * atomic, so a failed swap leaves the old one intact — but it is NOT ours. */
  | "failed";

export function convergeStableDaemon(
  sourceVersion: string = currentVersion(),
  opts: { timeoutMs?: number } = {},
): ConvergeOutcome {
  if (underTestRunner() || !isSea()) return "unavailable";
  const stable = stableDaemonPath();
  if (!existsSync(stable)) return "unavailable"; // nothing there yet — invocation falls back
  const outcome = withDaemonInstallLock(() => {
    // Re-read the installed version INSIDE the lock. The app's installer may have
    // advanced the stable binary while we waited, and acting on the reading we took
    // before the lock is exactly how an older build overwrites a newer one.
    const theirs = binaryVersionConfirmed(stable);
    if (theirs && !isNewer(sourceVersion, theirs)) return "current" as const;
    // `theirs === null` falls through to a REPAIR swap rather than being reported as
    // "current". A binary that can't even print its version can't run as a daemon
    // either, so leaving it in place meant a corrupted stable install could never be
    // fixed by convergence — it would be called "current" forever.
    //
    // Atomic swap (temp + rename); a running daemon keeps its old inode until restart.
    const tmp = `${stable}.new-${process.pid}`;
    try {
      copyFileSync(process.execPath, tmp);
      chmodSync(tmp, 0o755);
      renameSync(tmp, stable);
      return "swapped" as const;
    } catch {
      // Disk full, read-only volume, permissions. The rename either happened or it
      // didn't, so the stable binary is never left half-written — but don't let a
      // filesystem hiccup crash `treehouse update`; report it and let the caller
      // decide (it must not then claim the daemon is on the new version).
      rmSync(tmp, { force: true });
      return "failed" as const;
    }
  }, opts);
  // Couldn't take the lock ⇒ another installer owns the path right now. Leaving it
  // to them is correct; writing anyway is the downgrade this lock exists to prevent.
  return outcome.acquired ? outcome.value : "locked";
}

// ───────────────────────────── template generators ─────────────────────────────

export function launchdPlist(exec: string, args: string[], log: string): string {
  const program = [exec, ...args].map((a) => `      <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${program}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict><key>Crashed</key><true/><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${log}</string>
    <key>StandardErrorPath</key><string>${log}</string>
  </dict>
</plist>
`;
}

export function systemdUnit(exec: string, args: string[]): string {
  return `[Unit]
Description=Treehouse sync daemon
After=network-online.target

[Service]
ExecStart=${[exec, ...args].join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function xdgDesktop(exec: string, args: string[]): string {
  return `[Desktop Entry]
Type=Application
Name=Treehouse
Exec=${[exec, ...args].join(" ")}
X-GNOME-Autostart-enabled=true
NoDisplay=true
`;
}

export function windowsTaskCommand(exec: string, args: string[]): string {
  const tr = [exec, ...args].map((a) => (a.includes(" ") ? `\\"${a}\\"` : a)).join(" ");
  return `schtasks /Create /SC ONLOGON /TN Treehouse /TR "${tr}" /RL LIMITED /F`;
}

/** Extract the ProgramArguments exec (the first <string> in the array) from a
 * launchd plist. Pure so U10's plist-drift detection is unit-testable. Returns
 * null if the plist doesn't parse or has no ProgramArguments. */
export function parsePlistExec(xml: string): string | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!array) return null;
  const first = /<string>([\s\S]*?)<\/string>/.exec(array[1] ?? "");
  return first ? (first[1] ?? "").trim() : null;
}

/** The exec the installed launchd service currently points at, or null if there
 * is no service. U10's shell reads this to detect drift (an old CLI's `start`
 * rewrites the plist to its own execPath) and re-assert the stable path. */
export function installedServiceExec(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return parsePlistExec(readFileSync(launchdPath(), "utf8"));
  } catch {
    return null; // no plist installed
  }
}

// ───────────────────────────── install / uninstall ─────────────────────────────

export const launchdPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const systemdPath = () =>
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "systemd",
    "user",
    "treehouse.service",
  );
const xdgPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "treehouse.desktop");

function gui(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function hasSystemd(): boolean {
  try {
    execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function serviceInstalled(): boolean {
  if (process.platform === "darwin") return existsSync(launchdPath());
  if (process.platform === "linux") return existsSync(systemdPath()) || existsSync(xdgPath());
  return false;
}

/**
 * Block until launchd reports the job gone, or the budget runs out.
 *
 * `launchctl print` exits non-zero once the service is no longer loaded, which is
 * the signal that a `bootstrap` will be accepted. Polled synchronously because
 * every caller here is synchronous; the budget is short and the common case exits
 * on the first probe.
 *
 * Returning after a timeout rather than throwing is deliberate: a `bootstrap`
 * that fails loudly is a better outcome than refusing to try.
 */
function waitForServiceUnloaded(timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execFileSync("launchctl", ["print", `${gui()}/${LABEL}`], { stdio: "ignore" });
    } catch {
      return; // print failed ⇒ not loaded ⇒ safe to bootstrap
    }
    // Synchronous 100ms sleep: no async available on this path, and spinning
    // would starve the very launchd work being waited on.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/**
 * Whether the caller must start this session's daemon itself after
 * `installService()`: when there's no service at all, or the service only
 * runs at the next login (XDG autostart, the Windows logon task).
 */
export function needsDaemonSpawn(svc: ServiceResult): boolean {
  return !svc.installed || !svc.startedNow;
}

/** Install + start the autostart service. Returns installed:false if unsupported. */
export function installService(): ServiceResult {
  if (underTestRunner()) return { installed: false, note: "skipped under test runner" };
  const { exec, args } = daemonInvocation();

  if (process.platform === "darwin") {
    const path = launchdPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, launchdPlist(exec, args, logFilePath()));
    try {
      execFileSync("launchctl", ["bootout", gui(), path], { stdio: "ignore" }); // clear a prior load
    } catch {
      // not loaded yet — fine
    }
    // Wait for the bootout to actually land before bootstrapping.
    //
    // `bootout` returns before the job is gone: launchd sends SIGTERM and unloads
    // asynchronously, so an immediate `bootstrap` races it and fails with
    // "Operation now in progress" (EINPROGRESS). That throw used to escape into
    // reconcileDaemon's catch, which logged it and moved on — leaving the service
    // booted out with NOTHING running, and KeepAlive unable to recover it because
    // the SIGTERM path exits 0. Sync then stayed stopped until the user noticed
    // the menubar. This is most likely straight after an app update, when the
    // daemon is swapped and restarted.
    waitForServiceUnloaded();
    execFileSync("launchctl", ["bootstrap", gui(), path], { stdio: "ignore" }); // RunAtLoad starts it now
    return { installed: true, startedNow: true };
  }

  if (process.platform === "linux") {
    if (hasSystemd()) {
      mkdirSync(join(systemdPath(), ".."), { recursive: true });
      writeFileSync(systemdPath(), systemdUnit(exec, args));
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", "treehouse.service"], {
        stdio: "ignore",
      });
      return {
        installed: true,
        startedNow: true,
        note: "run `loginctl enable-linger` to keep syncing before login",
      };
    }
    mkdirSync(join(xdgPath(), ".."), { recursive: true });
    writeFileSync(xdgPath(), xdgDesktop(exec, args));
    return { installed: true, startedNow: false, note: "XDG autostart (no systemd --user)" };
  }

  if (process.platform === "win32") {
    // /F overwrites an existing task, so this is idempotent.
    execFileSync("cmd", ["/c", windowsTaskCommand(exec, args)], { stdio: "ignore" });
    return { installed: true, startedNow: false };
  }

  return { installed: false, note: "autostart isn't supported on this platform" };
}

/** Stop + remove the autostart service. Returns true if one was present. */
export function uninstallService(): boolean {
  if (underTestRunner()) return false;
  if (process.platform === "darwin") {
    const path = launchdPath();
    if (!existsSync(path)) return false;
    try {
      execFileSync("launchctl", ["bootout", gui(), path], { stdio: "ignore" });
    } catch {
      // already unloaded
    }
    rmSync(path, { force: true });
    return true;
  }
  if (process.platform === "linux") {
    let found = false;
    if (existsSync(systemdPath())) {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", "treehouse.service"], {
          stdio: "ignore",
        });
      } catch {
        // not active
      }
      rmSync(systemdPath(), { force: true });
      found = true;
    }
    if (existsSync(xdgPath())) {
      rmSync(xdgPath(), { force: true });
      found = true;
    }
    return found;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", ["/Delete", "/TN", "Treehouse", "/F"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}