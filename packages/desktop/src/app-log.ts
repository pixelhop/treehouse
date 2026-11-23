import { appendFileSync, renameSync, statSync } from "node:fs";
import { format } from "node:util";
import { ensureLogDir, logPath } from "cli/src/paths";

// The main process's own log. A packaged app launched from Finder has no terminal,
// so every console.error in this codebase (tray failures, onboarding, the daemon
// ownership monitor, sign-out) went nowhere and a bug report had nothing to attach.
// Teeing the console into `app.log` beside the daemon's `daemon.log` puts both in
// the one folder the tray's "Show Logs in Finder" opens and `treehouse logs app`
// prints. Dev runs still see everything in the terminal — the originals are kept.

/** Past this, the log is rotated to `app.log.1` on launch (one generation kept). */
const MAX_BYTES = 2 * 1024 * 1024;

const LEVELS = ["log", "info", "warn", "error"] as const;

/** One timestamped log line: `2026-09-23T09:41:17.283Z [error] …`. */
export function formatLine(level: string, args: unknown[], now = new Date()): string {
  return `${now.toISOString()} [${level}] ${format(...args)}\n`;
}

/** Rotate an oversized log aside so it can't grow without bound. The app is the
 * only writer, so renaming on launch — before anything is written — is safe. */
export function rotateIfLarge(file: string, maxBytes = MAX_BYTES): void {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // missing file (first run) or unreadable — nothing to rotate
  }
}

let installed = false;

/** Tee `console.*` into the app log. Idempotent; call once, as early as possible. */
export function installAppLog(): void {
  if (installed) return;
  installed = true;
  let file: string;
  try {
    ensureLogDir();
    file = logPath("app");
    rotateIfLarge(file);
  } catch {
    return; // no writable log dir — keep the plain console rather than fail launch
  }
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        appendFileSync(file, formatLine(level, args));
      } catch {
        // best-effort: a full disk must not take the app down with it
      }
    };
  }
}