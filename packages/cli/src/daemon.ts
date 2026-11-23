import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthError } from "./api-client";
import { configFingerprint, loadConfig } from "./config";
import { createEngine, type Engine } from "./engine";
import { serveIpc } from "./ipc";
import { type Link, loadLinks } from "./links-store";
import { ensureAppDir, ensureLogDir, logFilePath, pidPath } from "./paths";
import { rootAlive, type SyncNotice } from "./sync-core";
import { fetchLatest, writeLatestSeen } from "./update";

// The background daemon: supervises one sync engine per linked directory (from
// links.json), isolating per-directory failures so one bad folder can't take the
// rest down, and serves status/stop/reload over the IPC socket. A single-instance
// pid guard prevents two daemons; SIGTERM drains every engine and exits cleanly.

export interface DirStatus {
  root: string;
  workspaceId: string;
  // `syncing` = starting/running; `synced` = caught up & idle; `transferring` =
  // actively moving bytes; `error` = transient/root-lost (see `error` reason);
  // `auth-lost` = key revoked/expired (terminal until re-auth); `paused`.
  // Old on-disk state.json files only ever carry syncing/error/paused — readers
  // must tolerate the narrower set.
  state: "syncing" | "synced" | "transferring" | "error" | "auth-lost" | "paused";
  degraded: boolean;
  error?: string;
  since: string;
  /** Recent local changes the server refused (newest first). Absent from older daemons. */
  notices?: DirNotice[];
}

export type DirNotice = SyncNotice & { at: string };

// A few are enough to say what happened. The sync log keeps the full record.
const NOTICE_LIMIT = 20;

const RETRY_MS = 30_000;
const UPDATE_CHECK_MS = 24 * 60 * 60_000;

export function readPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(), "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True if a daemon process is recorded and still alive. */
export function isDaemonAlive(): boolean {
  const pid = readPid();
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe
    return true;
  } catch {
    return false; // stale pid (process gone) or not ours
  }
}

function logLine(scope: string, msg: string): void {
  try {
    appendFileSync(logFilePath(), `${new Date().toISOString()} [${scope}] ${msg}\n`);
  } catch {
    // logging is best-effort
  }
}

export async function runDaemon(): Promise<void> {
  if (isDaemonAlive()) {
    console.error("treehouse daemon is already running");
    process.exit(1);
  }
  ensureAppDir();
  ensureLogDir();
  writeFileSync(pidPath(), String(process.pid));

  const engines = new Map<string, Engine>();
  const statuses = new Map<string, DirStatus>();
  const notices = new Map<string, DirNotice[]>();
  // Credential each running engine was built with, so `reload` can spot a folder
  // that has been re-keyed underneath it.
  const fingerprints = new Map<string, string>();
  let stopping = false;

  /** True when the folder's on-disk credential differs from the running engine's. */
  function credentialChanged(root: string): boolean {
    const running = fingerprints.get(root);
    if (running === undefined) return false;
    try {
      return configFingerprint(loadConfig(root)) !== running;
    } catch {
      // Unreadable/absent config: nothing trustworthy to compare against, so
      // leave the engine alone rather than tearing down a working sync.
      return false;
    }
  }

  function record(link: Link, state: DirStatus["state"], engine?: Engine, error?: string): void {
    const status: DirStatus = {
      root: link.root,
      workspaceId: link.workspaceId,
      state,
      degraded: engine?.degraded() ?? false,
      error,
      since: new Date().toISOString(),
      notices: notices.get(link.root),
    };
    statuses.set(link.root, status);
    // Never mkdir/write into a root that failed its liveness check (R12):
    // recreating `.treehouse/` under a moved/trashed folder would leave a stray
    // empty dir and could fake a "reappeared" signal. The in-memory status above
    // still carries the error for IPC/`status`; only the on-disk mirror is
    // skipped while lost.
    if (!rootAlive(link.root)) return;
    try {
      mkdirSync(join(link.root, ".treehouse"), { recursive: true });
      writeFileSync(join(link.root, ".treehouse", "state.json"), JSON.stringify(status, null, 2));
    } catch {
      // a missing/unwritable dir is surfaced via the error state instead
    }
  }

  async function startDir(link: Link): Promise<void> {
    if (link.paused) {
      record(link, "paused");
      return;
    }
    // Claim the root BEFORE any await. `engine.start()` runs a full bootstrap —
    // minutes on a large folder over a flaky link — and registering only after
    // it resolved left a window where `reload()` (the desktop shell sends one on
    // sign-in, folder changes, "Start sync") saw no engine for this root and
    // started a SECOND one. The map keeps the last, so every earlier duplicate
    // kept running unreferenced — same folder, same credential, its own
    // in-memory baseline. Each duplicate then answers the same filesystem event with its
    // own `create`, and one snapshot-then-rebase becomes a pile of byte-
    // identical conflicted copies stamped milliseconds apart.
    if (engines.has(link.root)) return;
    let engine: Engine | undefined;
    try {
      const cfg = loadConfig(link.root);
      engine = createEngine(link.root, cfg, {
        log: (m) => logLine(link.root, m),
        // Surface the engine's live folder-state transitions (synced /
        // transferring / error / auth-lost) so `status` reflects them in real
        // time. `record` skips the on-disk mirror while the root is lost; the
        // in-memory status still carries the reason for IPC.
        onNotice: (ns) => {
          const at = new Date().toISOString();
          const next = [...ns.map((n) => ({ ...n, at })), ...(notices.get(link.root) ?? [])].slice(
            0,
            NOTICE_LIMIT,
          );
          notices.set(link.root, next);
          const current = statuses.get(link.root);
          if (current) current.notices = next;
        },
        onState: (s) => {
          const e = engines.get(link.root);
          if (s.state === "error") record(link, "error", e, s.reason);
          else if (s.state === "auth-lost") record(link, "auth-lost", e, s.reason);
          else record(link, s.state, e);
        },
      });
      engines.set(link.root, engine);
      fingerprints.set(link.root, configFingerprint(cfg));
      await engine.start();
      // A `reload` during startup may have unlinked or re-keyed this folder and
      // already stopped us. Don't report a stopped engine as syncing.
      if (engines.get(link.root) !== engine) return;
      record(link, "syncing", engine);
      logLine(link.root, "syncing");
    } catch (e) {
      // Release the claim so the retry below — or a later reload — can try
      // again, and make sure a half-started engine isn't left watching.
      if (engines.get(link.root) === engine) {
        engines.delete(link.root);
        fingerprints.delete(link.root);
      }
      await engine?.stop().catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      // Classify by TYPE, exactly as the running engine does for the same
      // failure mid-poll. An auth loss during bootstrap is still an auth loss:
      // reported as a generic folder error it surfaces as whichever file
      // happened to be in flight ("put <path> failed: 401") and the tray offers
      // no way out, when the actionable state is auth-lost + "Re-authenticate…".
      if (e instanceof AuthError) {
        record(
          link,
          "auth-lost",
          undefined,
          "sign-in required — the workspace key was revoked or expired",
        );
        logLine(link.root, `auth lost: ${msg} — retrying in ${RETRY_MS / 1000}s`);
      } else {
        record(link, "error", undefined, msg);
        logLine(link.root, `error: ${msg} — retrying in ${RETRY_MS / 1000}s`);
      }
      setTimeout(() => {
        // Don't resurrect a dir the user has since unlinked or paused.
        const stillActive = loadLinks().some((l) => l.root === link.root && !l.paused);
        if (!stopping && stillActive && !engines.has(link.root)) void startDir(link);
      }, RETRY_MS).unref();
    }
  }

  // Re-read links.json and reconcile running engines with the desired set.
  async function reload(): Promise<void> {
    const links = loadLinks();
    const wanted = new Set(links.filter((l) => !l.paused).map((l) => l.root));
    for (const [root, engine] of engines) {
      // A folder that was re-keyed under a running engine (the menubar's
      // "Re-authenticate…" mints a fresh key into .treehouse/config.json and
      // revokes the old one) must be restarted, not left alone: the engine
      // captured its credential at construction and would keep 401-ing with the
      // revoked key while every other client works with the new one. Reconciling
      // by root alone silently made re-auth a no-op for exactly the folders that
      // needed it.
      if (wanted.has(root) && credentialChanged(root)) {
        logLine(root, "credentials changed — restarting sync");
        await engine.stop().catch(() => {});
        engines.delete(root);
        fingerprints.delete(root);
        continue;
      }
      if (!wanted.has(root)) {
        await engine.stop().catch(() => {});
        engines.delete(root);
        statuses.delete(root);
        fingerprints.delete(root);
      }
    }
    for (const link of links) {
      if (!engines.has(link.root)) await startDir(link);
    }
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    logLine("daemon", "shutting down");
    for (const engine of engines.values()) await engine.stop().catch(() => {});
    await ipc.close();
    rmSync(pidPath(), { force: true });
    process.exit(0);
  }

  const ipc = serveIpc(async (req) => {
    if (req.cmd === "status") return { ok: true, dirs: [...statuses.values()] };
    if (req.cmd === "reload") {
      await reload();
      return { ok: true };
    }
    if (req.cmd === "stop") {
      setTimeout(() => void shutdown(), 50).unref();
      return { ok: true };
    }
    // Structured error (with a machine-readable code) so a newer client probing
    // an unknown verb fails cleanly instead of hanging on no response.
    return { ok: false, code: "unknown_command", error: `unknown command: ${req.cmd}` };
  });

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Passive update awareness: record the latest published version on start and
  // daily, so `treehouse status` can surface "update available" with no network.
  const checkUpdate = async (): Promise<void> => {
    try {
      writeLatestSeen((await fetchLatest()).version);
    } catch {
      // offline / transient — try again next interval
    }
  };
  void checkUpdate();
  const updateTimer = setInterval(() => void checkUpdate(), UPDATE_CHECK_MS);
  updateTimer.unref();

  for (const link of loadLinks()) await startDir(link);
  logLine("daemon", `supervising ${engines.size} director(ies)`);

  await new Promise<void>(() => {}); // run until a signal/stop
}