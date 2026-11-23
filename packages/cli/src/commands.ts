import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSea } from "node:sea";
import { type DirStatus, isDaemonAlive, readPid } from "./daemon";
import { sendIpc } from "./ipc";
import { type Link, loadLinks, removeLink, setPaused } from "./links-store";
import { ensureLogDir, logDir, logFilePath, type LogName, logPath } from "./paths";
import { relocateFolder } from "./relocate";
import {
  convergeStableDaemon,
  installService,
  needsDaemonSpawn,
  serviceInstalled,
  uninstallService,
} from "./service";
import { currentTarget, currentVersion, fetchLatest, isNewer, readLatestSeen } from "./update";

// Re-launch THIS executable as a detached `daemon` process. Works both as the
// packaged binary (isSea → argv is just the command) and from source via tsx
// (argv[1] is the bin shim, which re-registers the loader). Used as the fallback
// when no OS autostart service is available.
function spawnDaemon(): void {
  // Never fork a real detached daemon under the test runner.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  ensureLogDir();
  const out = openSync(logFilePath(), "a");
  const pre = isSea() ? [] : [process.argv[1] as string];
  spawn(process.execPath, [...pre, "daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
  }).unref();
}

async function waitPidGone(ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (isDaemonAlive() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 100));
  return !isDaemonAlive();
}

/** Stop a running daemon (IPC, then SIGTERM the pid). Returns true if it stopped. */
async function stopDaemon(): Promise<boolean> {
  if ((await sendIpc({ cmd: "stop" })) !== null) return waitPidGone();
  const pid = readPid();
  if (pid !== undefined && isDaemonAlive()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    return waitPidGone();
  }
  return false;
}

export async function cmdStart(): Promise<void> {
  const active = loadLinks().filter((l) => !l.paused);
  if (active.length === 0) {
    console.log("No linked folders yet — run `treehouse login <folder>` first.");
    return;
  }
  if (isDaemonAlive() && serviceInstalled()) {
    console.log("treehouse is already running.");
    return;
  }
  // Hand the daemon over to the OS service cleanly (avoid two supervisors).
  if (isDaemonAlive()) await stopDaemon();

  // Newest-wins (U10): if a stable shared daemon exists and ours is newer, own it
  // before pointing launchd at it — so the CLI never re-pins the service to an older
  // app-installed binary that lacks our daemon fixes.
  convergeStableDaemon();
  const svc = installService();
  if (needsDaemonSpawn(svc)) spawnDaemon();
  if (svc.installed) {
    console.log(`Started — syncing ${active.length} folder(s); it'll resume on login.`);
  } else {
    console.log(`Started — syncing ${active.length} folder(s).`);
    console.log("  (autostart-on-login isn't available on this platform)");
  }
  if (svc.note) console.log(`  ${svc.note}`);
  console.log(`Logs: ${logFilePath()}`);
}

// Ensure the background daemon is running and supervising the current link set.
// Used by `login` so sync begins the moment a folder is connected. If the daemon
// is already up, nudge it to re-read links.json (pick up the just-linked folder);
// otherwise start it, preferring OS autostart. Returns whether autostart is set.
export async function ensureDaemonRunning(): Promise<{ autostart: boolean }> {
  if (isDaemonAlive()) {
    await sendIpc({ cmd: "reload" }); // pick up the newly-linked folder
    return { autostart: serviceInstalled() };
  }
  convergeStableDaemon(); // own the stable path if ours is newer (U10)
  const svc = installService();
  if (needsDaemonSpawn(svc)) spawnDaemon();
  return { autostart: svc.installed };
}

export async function cmdStop(): Promise<void> {
  const hadService = uninstallService(); // stops the service-managed daemon + disables autostart
  const stopped = await stopDaemon(); // also stop a self-spawned daemon, if any
  if (hadService) console.log("Stopped and disabled autostart.");
  else if (stopped) console.log("Stopped.");
  else console.log("treehouse is not running.");
}

export async function cmdRestart(): Promise<void> {
  await cmdStop();
  await new Promise((r) => setTimeout(r, 600));
  await cmdStart();
}

// Render a one-glance badge for a folder's live state. `default` catches both
// `error` and any state written by a newer daemon (or an old state.json that
// only knew syncing/error/paused), so an unrecognized value degrades to the
// error badge instead of throwing.
export function statusBadge(d: Pick<DirStatus, "state" | "degraded">): string {
  switch (d.state) {
    case "synced":
      return "✓ synced   ";
    case "transferring":
      return "⇅ syncing  ";
    case "syncing":
      return d.degraded ? "◐ polling  " : "● starting ";
    case "paused":
      return "‖ paused   ";
    case "auth-lost":
      return "⚠ sign in  ";
    default:
      return "✗ error    ";
  }
}

function readDirState(link: Link): DirStatus {
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

export async function cmdStatus(): Promise<void> {
  const res = (await sendIpc({ cmd: "status" })) as { ok: boolean; dirs: DirStatus[] } | null;
  const running = !!res?.ok;
  const dirs = running ? res.dirs : loadLinks().map(readDirState);

  if (dirs.length === 0) {
    console.log("No linked folders. Run `treehouse login <folder>` to connect one.");
    return;
  }
  console.log(running ? "treehouse is running\n" : "treehouse is not running (last known state)\n");
  for (const d of dirs) {
    console.log(
      `  ${statusBadge(d)}  ${d.root}  →  ${d.workspaceId}${d.error ? `  (${d.error})` : ""}`,
    );
  }

  // Passive update awareness — the daemon records the latest seen release.
  const latest = readLatestSeen();
  if (latest && isNewer(latest, currentVersion())) {
    console.log(`\nUpdate available: ${currentVersion()} → ${latest}  (run \`treehouse update\`)`);
  }
}

// Download the new binary, verify its checksum, and atomically swap it in at
// this executable's own path. On POSIX a rename over a running binary is fine
// (the live process keeps the old inode); Windows can't replace a running exe,
// so move it aside first.
async function downloadAndSwap(url: string, sha256: string, execPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch — refusing to install`);

  const tmp = `${execPath}.new-${process.pid}`;
  writeFileSync(tmp, bytes);
  chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, execPath);
  } catch {
    const old = `${execPath}.old-${process.pid}`;
    renameSync(execPath, old);
    renameSync(tmp, execPath);
    try {
      rmSync(old, { force: true }); // may be in use (running daemon) — cleaned next time
    } catch {
      // ignore
    }
  }
}

export async function cmdUpdate(opts: { check?: boolean } = {}): Promise<void> {
  const current = currentVersion();
  let manifest: Awaited<ReturnType<typeof fetchLatest>>;
  try {
    manifest = await fetchLatest();
  } catch (e) {
    console.log(`Couldn't check for updates: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!isNewer(manifest.version, current)) {
    console.log(
      current === "dev"
        ? "Running a dev build — update with `git pull` / rebuild."
        : `treehouse ${current} is up to date.`,
    );
    return;
  }

  console.log(`Update available: ${current} → ${manifest.version}`);
  if (opts.check) {
    console.log("Run `treehouse update` to install.");
    return;
  }
  if (!isSea()) {
    console.log("Run-from-source build — `git pull` instead of self-updating.");
    return;
  }

  const asset = manifest.assets[currentTarget()];
  if (!asset) {
    console.log(`No published build for ${currentTarget()} — update manually.`);
    return;
  }

  console.log(`Downloading ${asset.name}…`);
  try {
    await downloadAndSwap(asset.url, asset.sha256, process.execPath);
  } catch (e) {
    console.log(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  console.log(`✓ Updated to ${manifest.version}.`);

  // Newest-wins (U10): now that our own binary is newer, push it to the stable
  // shared path too, so the launchd-supervised daemon actually advances instead of
  // staying pinned to the older app-installed binary at that path. Pass the
  // DOWNLOADED version explicitly — this process still reports the pre-update one
  // it was compiled with, which would compare equal and skip the copy entirely.
  let converged = convergeStableDaemon(manifest.version);
  if (converged === "locked") {
    // Another installer (the desktop app) is mid-swap. Give it one longer go
    // rather than immediately giving up — its critical section is a file copy.
    console.log("Waiting for another Treehouse installer to finish…");
    converged = convergeStableDaemon(manifest.version, { timeoutMs: 30_000 });
  }

  if (converged === "locked" || converged === "failed") {
    // Either we never got to look at the stable path (locked) or we couldn't write
    // it (failed). Both mean the shared daemon is NOT known to be on the new
    // binary, so restarting would relaunch an older one while printing that sync is
    // on manifest.version. Leave the running daemon alone and say so.
    const why =
      converged === "locked"
        ? "is being updated by another installer"
        : "couldn't be updated (the disk may be full or read-only)";
    console.log(
      `The shared sync engine ${why}, so it wasn't restarted.\n` +
        `  Your CLI is on ${manifest.version}. Run \`treehouse restart\` once that's resolved.`,
    );
    return;
  }

  if (isDaemonAlive()) {
    await cmdRestart(); // relaunch the daemon on the new binary
    console.log("Restarted — now syncing on the new version.");
  } else {
    console.log("Start syncing with:  treehouse start");
  }
}

/** The last `n` lines of a log's text (no trailing newline). */
export function lastLines(text: string, n: number): string {
  const trimmed = text.trimEnd();
  if (!trimmed || n <= 0) return "";
  return trimmed.split("\n").slice(-n).join("\n");
}

export interface LogsOptions {
  name: LogName;
  lines: number;
  follow: boolean;
  /** Print where the logs live instead of their contents. */
  path: boolean;
}

export async function cmdLogs(opts: LogsOptions): Promise<void> {
  const file = logPath(opts.name);
  if (opts.path) {
    // The folder, not the file: it's what a bug report wants attached, and what
    // `open "$(treehouse logs --path)"` should land on.
    console.log(logDir());
    return;
  }

  let offset = 0;
  try {
    const bytes = readFileSync(file);
    offset = bytes.length;
    const tail = lastLines(bytes.toString("utf8"), opts.lines);
    if (tail) console.log(tail);
  } catch {
    // Missing is the normal state before the first run — following still makes
    // sense (the file appears once the daemon/app writes to it).
  }
  if (!opts.follow) {
    if (offset === 0) console.log(`No ${opts.name} log yet (${file}).`);
    return;
  }

  // Follow: stream whatever is appended, like `tail -f`. Polling (not fs.watch)
  // because the daemon appends from another process and fs.watch on macOS can
  // miss those; a shrunken file means it was rotated/truncated, so start over.
  const onChange = (curr: Stats): void => {
    if (curr.size < offset) offset = 0;
    if (curr.size === offset) return;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(curr.size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = curr.size;
      process.stdout.write(buf);
    } finally {
      closeSync(fd);
    }
  };
  watchFile(file, { interval: 500 }, onChange);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      unwatchFile(file, onChange);
      resolve();
    });
  });
}

/**
 * Pause or resume a single linked folder and nudge the daemon to apply it. The
 * app calls this directly (no new public CLI verb): `setPaused` updates the
 * registry, and a live daemon reload stops/starts that folder's engine. A paused
 * folder resumes cleanly on the next resume+reload — the engine restarts from its
 * saved cursor.
 */
export async function applyPause(root: string, paused: boolean): Promise<void> {
  setPaused(root, paused);
  if (paused) {
    // Nothing to start; a live daemon just needs to drop the folder.
    if (isDaemonAlive()) await sendIpc({ cmd: "reload" });
    return;
  }
  // Resuming has to make sync actually resume. Reloading only works on a LIVE
  // daemon, so after `treehouse stop` (which uninstalls the service and kills the
  // process) `resume` reported "Resumed" while nothing synced. ensureDaemonRunning
  // reloads a live daemon and starts a dead one, so both paths end up syncing.
  await ensureDaemonRunning();
}

export async function cmdUnlink(root: string): Promise<void> {
  if (!removeLink(root)) {
    console.log(`${root} was not linked.`);
    return;
  }
  console.log(`Unlinked ${root}`);
  if (isDaemonAlive()) await sendIpc({ cmd: "reload" }); // stop supervising it now
}
/**
 * Change where a linked folder syncs. The single shared path for BOTH surfaces:
 * `treehouse relocate` and the app's "Change Location…" menu item call this, the
 * same way `applyPause` backs both `treehouse pause` and the tray's Pause item.
 *
 * Parity here is not cosmetic. Relocation exists because moving a folder carries
 * its key and local index with it — no re-grant, no full re-upload. Without a CLI
 * entry point, a terminal user or an agent could only unlink and re-login, paying
 * exactly the cost this function was written to avoid.
 */
export async function cmdRelocate(from: string, to: string): Promise<void> {
  const result = await relocateFolder(from, to);
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Moved ${from} → ${to}`);
}