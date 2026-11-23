import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDaemonRunning } from "cli/src/commands";
import type { DirStatus } from "cli/src/daemon";
import { withDaemonInstallLock } from "cli/src/daemon-lock";
import { IPC_PROTOCOL_VERSION, sendIpc } from "cli/src/ipc";
import { addLink, type Link, loadLinks } from "cli/src/links-store";
import { stableDaemonPath } from "cli/src/paths";
import { readFolderConfig } from "./folder-config";
import { installedServiceExec, installService } from "cli/src/service";
import { isNewer } from "cli/src/update";

// The shell drives the EXISTING CLI daemon — it never grows a second sync engine
// and never shells out to the CLI binary. It imports the raw-TS cli modules and
// calls them directly. The daemon itself stays an independently launchd-managed
// process (sync survives the app quitting); this module only registers links and
// nudges the daemon. OS-touching calls underneath (installService / spawnDaemon)
// are already VITEST-guarded inside the cli package, so this is safe under tests.

/**
 * Register a freshly-granted folder as an APP-owned link (origin "app", key id +
 * account recorded for sign-out revocation and ownership tracking), then ensure
 * the daemon is running and supervising it. Called by onboarding's "starting" step
 * once the grant has written the folder's config. A keyless link is impossible:
 * the caller only reaches here after the grant wrote the key.
 */
export async function startSyncFolder(args: {
  root: string;
  workspaceId: string;
  keyId?: string;
  account?: string;
  /** The app origin this folder was connected through — see `Link.appOrigin`. */
  appOrigin?: string;
}): Promise<void> {
  // Belt-and-braces: the key id is the sign-out revocation handle. If the caller
  // didn't carry it (a crash-resume that re-entered past the grant), read it from
  // the folder's config before registering — an app link without a keyId is
  // excluded from sign-out's pause+revoke, leaving a live key syncing after sign-out.
  const keyId = args.keyId ?? readFolderConfig(args.root)?.keyId;
  addLink(args.root, args.workspaceId, {
    origin: "app",
    account: args.account,
    keyId,
    appOrigin: args.appOrigin,
  });
  await ensureDaemonRunning(); // alive → reload to pick up the new link; else start it
}

export interface StatusSnapshot {
  /** True when the daemon answered over IPC (live status); false = last-known. */
  running: boolean;
  dirs: DirStatus[];
}

/** Last-known state from a folder's own state.json (the cli's own down-fallback). */
export function readLastKnown(link: Link): DirStatus {
  try {
    return JSON.parse(
      readFileSync(join(link.root, ".treehouse", "state.json"), "utf8"),
    ) as DirStatus;
  } catch {
    return {
      root: link.root,
      workspaceId: link.workspaceId,
      state: link.paused ? "paused" : "error",
      degraded: false,
      since: "",
    };
  }
}

/**
 * Poll the daemon for live per-folder status over IPC, sending the U2 protocol
 * version in the handshake. If the daemon is down (or answers malformed), fall
 * back to each link's last-known state.json — the tray still shows something and
 * offers "Start sync".
 */
export async function pollDaemonStatus(): Promise<StatusSnapshot> {
  const res = (await sendIpc({ cmd: "status", protocol: IPC_PROTOCOL_VERSION })) as {
    ok?: boolean;
    dirs?: DirStatus[];
  } | null;
  if (res?.ok && Array.isArray(res.dirs)) return { running: true, dirs: res.dirs };
  return { running: false, dirs: loadLinks().map(readLastKnown) };
}

/** Start (or reload) the daemon to supervise the current links — the tray's
 * "Start sync" action when the daemon is found down. */
export async function startDaemon(): Promise<void> {
  await ensureDaemonRunning();
}

// ─────────────────────────── U10: shared-binary ownership ───────────────────────────
//
// The app ships the SEA daemon in its resources and OWNS the shared binary at a
// stable per-user path (cli's `stableDaemonPath()`), pointing the launchd service
// there. This is deliberately NOT inside the .app bundle (trashing the app must not
// crash-loop launchd) and NOT the CLI's own binary (`treehouse update` must not fight
// the app updater). The rules:
//   • newest daemon wins the shared path (compare versions, never downgrade);
//   • a client refuses to MANAGE a daemon that speaks a newer IPC protocol than it
//     understands (an older app must not stomp a newer daemon a newer CLI installed);
//   • before any swap, the incoming binary's code signature + Team ID are verified —
//     a tampered/foreign artifact never reaches the always-running path;
//   • plist drift is detected and repaired: already-shipped CLIs predate all of this
//     and their `start`/`stop` rewrite or delete the plist, so the shell re-asserts
//     the stable path on launch and periodically.
//
// The pure decision functions below are unit-tested; the OS-touching orchestration is
// injectable (real ops default) so tests drive it with fakes — no real launchd/codesign.

/** The Apple Developer Team ID the bundled daemon must be signed with before the
 * shell will install it at the always-running path. Baked at build/release time
 * (same value as the notarization APPLE_TEAM_ID); overridable for CI/self-signing.
 * The placeholder is intentionally non-matching so an unconfigured build refuses
 * every swap rather than trusting an unknown signer. */
// `||` (not `??`) so an empty baked value still resolves to the placeholder: the
// build's esbuild `define` folds this at bundle time — a real Team ID eliminates the
// "UNSET_TEAM_ID" literal from the bundle entirely (asserted by build-team-id.test.ts),
// while an unconfigured build keeps it (fail-closed AND grep-detectable).
export const EXPECTED_TEAM_ID = process.env.TREEHOUSE_TEAM_ID || "UNSET_TEAM_ID";

// Whether a REAL Team ID was baked, i.e. this is a signed release. Derived from the
// raw env var rather than by comparing EXPECTED_TEAM_ID to the placeholder, so the
// "UNSET_TEAM_ID" literal appears exactly once in this file and esbuild can still
// fold it out of a signed bundle entirely (asserted by build-team-id.test.ts).
export const TEAM_ID_CONFIGURED = Boolean(process.env.TREEHOUSE_TEAM_ID);

// ALPHA ESCAPE HATCH. Unsigned builds cannot pass the Team-ID gate — an ad-hoc
// signature carries no TeamIdentifier — so the shell refuses to install its own
// bundled daemon and onboarding dead-ends at "sync engine isn't installed yet",
// permanently. This flag lets an UNSIGNED build accept an ad-hoc daemon so the app
// works end to end while signing certs are unavailable.
//
// Deliberately narrow: it is default-OFF, it is IGNORED once a real Team ID is baked
// (a signed release can never be downgraded by it), and it still requires `codesign
// --verify --strict --deep` to pass, so a tampered or corrupt binary is rejected
// either way. What it gives up is proof of WHO signed the daemon.
export const ALLOW_ADHOC_DAEMON = process.env.TREEHOUSE_ALLOW_ADHOC_DAEMON === "1";

export interface DaemonManagementState {
  /** Version of the daemon shipped in the app's resources (null when unpackaged/dev). */
  shippedVersion: string | null;
  /** Version of the binary currently at the stable shared path (null if none installed). */
  installedVersion: string | null;
  /** IPC protocol the currently-running daemon reports (null when the daemon is down). */
  runningProtocol: number | null;
  /** The IPC protocol this client understands (`IPC_PROTOCOL_VERSION`). */
  knownProtocol: number;
  /** Exec path the launchd plist currently points at (null if no service installed). */
  plistExec: string | null;
  /** The stable shared path the plist SHOULD target. */
  stablePath: string;
}

export interface DaemonManagementDecision {
  /** Copy the shipped binary onto the stable path (a signature check gates the real swap). */
  installBinary: boolean;
  /** Rewrite the launchd plist to point at the stable path (fresh install or drift repair). */
  repairPlist: boolean;
  /** (Re)assert the launchd service so the change takes effect. */
  restart: boolean;
  reason: string;
}

/**
 * Pure ownership decision. Given what's shipped, what's installed, what's running,
 * and where the plist points, decide whether to swap the binary, repair the plist,
 * and restart. No I/O — the orchestrator performs the signature check and the swap.
 */
export function decideDaemonManagement(s: DaemonManagementState): DaemonManagementDecision {
  // Refuse to manage a daemon speaking a protocol newer than we know: a newer CLI
  // may have installed it, and an older app must not downgrade or restart it.
  if (s.runningProtocol !== null && s.runningProtocol > s.knownProtocol) {
    return {
      installBinary: false,
      repairPlist: false,
      restart: false,
      reason: `running daemon protocol ${s.runningProtocol} is newer than this client knows (${s.knownProtocol}) — leaving it alone`,
    };
  }

  // Newest-wins: install when nothing is at the stable path, or the shipped daemon
  // is strictly newer than the installed one. Never downgrade a healthy binary.
  const installBinary =
    s.shippedVersion !== null &&
    (s.installedVersion === null || isNewer(s.shippedVersion, s.installedVersion));

  // The plist must point at the stable path. `null` = fresh install; a mismatch =
  // an old CLI rewrote it to its own execPath (drift) — both need a rewrite.
  const repairPlist = s.plistExec !== s.stablePath;

  // A daemon that should be running but isn't. `installService` does `launchctl
  // bootout` then `bootstrap` back to back, and bootout is asynchronous — so the
  // bootstrap can fail with "Operation now in progress", leaving the service
  // booted out and nothing running. reconcileDaemon contains that error, and
  // launchd will NOT recover it either: KeepAlive is {Crashed, SuccessfulExit:
  // false} and the SIGTERM path exits 0.
  //
  // Without this clause the next tick computes installBinary=false (the binary is
  // already current) and repairPlist=false (the plist is already right), concludes
  // "daemon healthy at the stable path", and does nothing — every five minutes,
  // forever, while nothing syncs. The gap is widest right after an app update,
  // which is exactly when a restart is attempted.
  //
  // Gated on the plist existing: with no service installed there is nothing to
  // kickstart, and that case is already covered by repairPlist.
  const daemonMissing = s.plistExec !== null && s.runningProtocol === null;

  const restart = installBinary || repairPlist || daemonMissing;

  const reason = installBinary
    ? s.installedVersion === null
      ? `installing daemon ${s.shippedVersion} at the stable path`
      : `upgrading daemon ${s.installedVersion} → ${s.shippedVersion}`
    : daemonMissing && !repairPlist
      ? "service is installed but no daemon is running — restarting it"
      : repairPlist
        ? `plist drift (points at ${s.plistExec ?? "nothing"}) — re-asserting the stable path`
        : "daemon healthy at the stable path";

  return { installBinary, repairPlist, restart, reason };
}

/** Parse the `TeamIdentifier=` line out of `codesign -dvvv` output. Pure so the
 * team-id gate is unit-testable without a signed binary. Returns null if absent. */
export function parseTeamId(codesignOutput: string): string | null {
  const m = /TeamIdentifier=(.+)/.exec(codesignOutput);
  const id = m?.[1]?.trim();
  // An unsigned/adhoc binary reports `TeamIdentifier=not set` — treat as no team.
  return id && id !== "not set" ? id : null;
}

/**
 * Whether a daemon binary's signature is acceptable. Pure so both the strict
 * (signed-release) and permissive (unsigned-alpha) paths are testable without a
 * real certificate.
 *
 * A signed release ignores `allowAdhoc` outright: once a Team ID is baked, only a
 * binary signed by that team is accepted, exactly as before. The escape hatch can
 * therefore never weaken a production build, only an explicitly unsigned one.
 */
export function acceptsDaemonSignature(s: {
  /** `codesign --verify --strict --deep` succeeded. */
  codesignValid: boolean;
  /** Team ID parsed from the binary, or null for an ad-hoc/unsigned one. */
  teamId: string | null;
  expectedTeamId: string;
  /** True when a real Team ID was baked into this build (signed release). */
  teamIdConfigured: boolean;
  allowAdhoc: boolean;
}): boolean {
  // A broken or tampered signature is rejected on every path, flag or not.
  if (!s.codesignValid) return false;
  if (s.teamIdConfigured) return s.teamId !== null && s.teamId === s.expectedTeamId;
  return s.allowAdhoc && s.teamId === null;
}

// ─── Injectable OS operations (real implementations; tests pass fakes) ───

export interface DaemonOps {
  /** Path to the daemon shipped in app resources, or null when unpackaged/dev. */
  shippedDaemonPath(): string | null;
  stablePath(): string;
  /** Read a binary's reported version (`<bin> version`), or null if unreadable. */
  readBinaryVersion(path: string): string | null;
  /** Protocol the running daemon reports over IPC, or null if it's down. */
  readRunningProtocol(): Promise<number | null>;
  /** Exec the installed launchd plist points at, or null. */
  readPlistExec(): string | null;
  /** Verify the binary's code signature is valid AND matches the expected Team ID. */
  verifySignature(path: string, expectedTeamId: string): boolean;
  /** Atomically place `shipped` at `stable` (temp + rename), executable. */
  installBinaryAtStablePath(shipped: string, stable: string): void;
  /** Write the plist at the stable path and (re)bootstrap the service (cli installService). */
  assertService(): void;
  log(msg: string): void;
}

function realShippedDaemonPath(): string | null {
  // electron-builder `extraResources` places the daemon at Contents/Resources/daemon;
  // `process.resourcesPath` is that dir in a packaged app and undefined under Node/tests.
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!res) return null;
  const p = join(res, "daemon");
  return existsSync(p) ? p : null;
}

function realReadBinaryVersion(path: string): string | null {
  try {
    return execFileSync(path, ["version"], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

async function realReadRunningProtocol(): Promise<number | null> {
  const res = (await sendIpc({ cmd: "status", protocol: IPC_PROTOCOL_VERSION })) as {
    protocol?: number;
  } | null;
  return typeof res?.protocol === "number" ? res.protocol : null;
}

function realVerifySignature(path: string, expectedTeamId: string): boolean {
  let codesignValid = true;
  try {
    // Rejects a tampered/corrupt signature. NOTE: this PASSES for an ad-hoc
    // signature — it is the Team-ID comparison below that distinguishes signers.
    execFileSync("codesign", ["--verify", "--strict", "--deep", path], { stdio: "ignore" });
  } catch {
    codesignValid = false;
  }
  // codesign prints the metadata (incl. TeamIdentifier=) to stderr.
  const info = spawnSync("codesign", ["-dvvv", path], { encoding: "utf8" });
  const teamId = parseTeamId(`${info.stdout ?? ""}${info.stderr ?? ""}`);
  const ok = acceptsDaemonSignature({
    codesignValid,
    teamId,
    expectedTeamId,
    teamIdConfigured: TEAM_ID_CONFIGURED,
    allowAdhoc: ALLOW_ADHOC_DAEMON,
  });
  if (ok && !TEAM_ID_CONFIGURED) {
    console.error(
      `[daemon-ownership] WARNING: accepting an ad-hoc-signed daemon (${path}) — this build is UNSIGNED and the Team-ID gate is disabled.`,
    );
  }
  return ok;
}

function realInstallBinaryAtStablePath(shipped: string, stable: string): void {
  mkdirSync(dirname(stable), { recursive: true });
  // Serialize against the CLI's `convergeStableDaemon`, which writes the same path.
  // Atomic rename only protects readers: without this lock both installers can read
  // the same old installed version, both decide to write, and whichever renames LAST
  // wins — so an older build can overwrite a newer daemon.
  const outcome = withDaemonInstallLock(() => {
    // Re-apply the newest-wins rule against a reading taken INSIDE the lock: the
    // other installer may have advanced the stable binary while we waited.
    const shippedVersion = realReadBinaryVersion(shipped);
    const installedVersion = realReadBinaryVersion(stable);
    if (shippedVersion === null) return false;
    if (installedVersion !== null && !isNewer(shippedVersion, installedVersion)) return false;
    const tmp = `${stable}.new-${process.pid}`;
    copyFileSync(shipped, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, stable); // atomic on POSIX; a running daemon keeps its old inode
    return true;
  });
  if (!outcome.acquired) {
    // Another installer holds the path right now; it is doing this same work.
    console.error("[daemon-ownership] install skipped: another installer holds the lock");
  }
}

/** Default ops wired to the real OS. Guarded call sites (`app.isPackaged`) ensure
 * these only run in a packaged app, never under the vitest runner. */
export const realDaemonOps: DaemonOps = {
  shippedDaemonPath: realShippedDaemonPath,
  stablePath: stableDaemonPath,
  readBinaryVersion: realReadBinaryVersion,
  readRunningProtocol: realReadRunningProtocol,
  readPlistExec: installedServiceExec,
  verifySignature: realVerifySignature,
  installBinaryAtStablePath: realInstallBinaryAtStablePath,
  assertService: () => {
    // installService writes the plist via daemonInvocation() — which now prefers the
    // stable path — and bootout/bootstraps launchd. It is VITEST-guarded internally.
    installService();
  },
  log: (m) => console.error(`[daemon-ownership] ${m}`),
};

/**
 * Reconcile ownership of the shared daemon: gather state, decide, verify+swap the
 * binary if newer, and re-assert the launchd service. Idempotent and safe to run on
 * launch and periodically. Returns the decision actually applied (a failed signature
 * check downgrades an intended install to a no-op, keeping the running daemon).
 */
export async function reconcileDaemon(
  expectedTeamId: string = EXPECTED_TEAM_ID,
  ops: DaemonOps = realDaemonOps,
): Promise<DaemonManagementDecision> {
  const shipped = ops.shippedDaemonPath();
  const stablePath = ops.stablePath();
  const state: DaemonManagementState = {
    shippedVersion: shipped ? ops.readBinaryVersion(shipped) : null,
    installedVersion: ops.readBinaryVersion(stablePath),
    runningProtocol: await ops.readRunningProtocol(),
    knownProtocol: IPC_PROTOCOL_VERSION,
    plistExec: ops.readPlistExec(),
    stablePath,
  };
  const decision = decideDaemonManagement(state);

  // The OS-touching calls below (mkdir/copy/chmod/rename + launchctl bootstrap) can
  // throw — ENOSPC/EACCES, a launchd conflict on a locked-down Mac. Contain it: log
  // and return a no-op decision instead of letting the exception escape into the
  // fire-and-forget monitor as a recurring unhandled rejection with no diagnostic.
  try {
    if (decision.installBinary && shipped) {
      if (!ops.verifySignature(shipped, expectedTeamId)) {
        ops.log(`refusing daemon swap: signature/Team-ID check failed for ${shipped}`);
        // Keep the currently-running daemon; do NOT restart onto an unverified binary.
        return {
          installBinary: false,
          repairPlist: false,
          restart: false,
          reason: "signature verification failed — keeping the running daemon",
        };
      }
      ops.installBinaryAtStablePath(shipped, stablePath);
    }

    if (decision.restart) ops.assertService();
    ops.log(decision.reason);
    return decision;
  } catch (e) {
    ops.log(`daemon reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    return {
      installBinary: false,
      repairPlist: false,
      restart: false,
      reason: "reconcile failed — left the running daemon in place",
    };
  }
}

/** Run one reconcile now, then re-assert ownership periodically to repair drift an
 * old CLI's `start`/`stop` introduces. Returns a stop function. */
export function startDaemonOwnershipMonitor(
  intervalMs = 5 * 60_000,
  expectedTeamId: string = EXPECTED_TEAM_ID,
  ops: DaemonOps = realDaemonOps,
): () => void {
  // reconcileDaemon contains its own errors, but guard the call sites too so a
  // rejection (or a throw before the try) can never become a bare unhandled
  // rejection repeating every interval for the life of the process.
  const tick = (): void => {
    reconcileDaemon(expectedTeamId, ops).catch((e: unknown) =>
      ops.log(`daemon reconcile tick failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}