import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Per-user locations for the background daemon's state. The daemon supervises a
// registry of linked directories (links.json); each linked directory keeps its
// own workspace-scoped key + sync state under its own .treehouse/ (so secrets
// aren't centralized and stay next to the folder they belong to). TREEHOUSE_HOME
// overrides everything — used by tests and self-contained installs.

const APP = "Treehouse";

export function appDir(): string {
  if (process.env.TREEHOUSE_HOME) return process.env.TREEHOUSE_HOME;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", APP);
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), APP);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "treehouse");
}

export function logDir(): string {
  if (process.env.TREEHOUSE_HOME) return join(process.env.TREEHOUSE_HOME, "logs");
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Logs", APP);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), APP, "Logs");
  }
  return join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "treehouse");
}

/** Create the app dir (owner-only) and return it. */
export function ensureAppDir(): string {
  const dir = appDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Create the log dir (owner-only) and return it. */
export function ensureLogDir(): string {
  const dir = logDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const linksPath = (): string => join(appDir(), "links.json");
export const pidPath = (): string => join(appDir(), "daemon.pid");
export const logFilePath = (): string => join(logDir(), "daemon.log");

/** Every log that lives in `logDir()`, by the name `treehouse logs <name>` takes.
 * `daemon` is the sync daemon (launchd points its stdout/stderr here too); `app` is
 * the desktop app's main process; `updater` is the desktop app's self-updater. */
export const LOG_FILES = {
  daemon: "daemon.log",
  app: "app.log",
  updater: "updater.log",
} as const;
export type LogName = keyof typeof LOG_FILES;
export const logPath = (name: LogName): string => join(logDir(), LOG_FILES[name]);

/**
 * The stable, per-user path the shared sync daemon is installed at and the
 * launchd service points to (U10). It lives under the app dir — NOT inside the
 * .app bundle (so trashing the app leaves a working daemon rather than a launchd
 * crash-loop) and NOT the CLI's own binary (so `treehouse update` and the app
 * updater don't fight over one executable). Both the app installer and the CLI
 * converge here: whichever has the newer daemon writes it, and the plist targets
 * this path so there is exactly one launchd-managed daemon.
 */
export const stableDaemonPath = (): string =>
  join(appDir(), "bin", process.platform === "win32" ? "treehouse-daemon.exe" : "treehouse-daemon");

/** Daemon control channel: a Unix socket on POSIX, a named pipe on Windows. */
export function sockPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\treehouse-daemon";
  return join(appDir(), "daemon.sock");
}