import { homedir } from "node:os";
import { basename } from "node:path";
import type { DirNotice, DirStatus } from "cli/src/daemon";

// Pure mapping from daemon folder states to what the menubar renders. Kept out of
// tray.ts so the icon/label logic is exhaustively unit-testable (the Electron
// menu construction itself is covered by the U12 checklist). Tolerant of an
// unknown `state` from a newer daemon (degrades to the error rendering), matching
// the cli's own forward-compatibility rule.

export type AggregateState = "synced" | "transferring" | "error" | "auth-lost" | "paused" | "idle";

/**
 * The single state the tray icon reflects across all folders. Priority is
 * attention-first: an auth-loss or error outranks in-progress transfer, which
 * outranks steady states — so a problem is never hidden behind a green icon.
 */
export function aggregateState(dirs: DirStatus[]): AggregateState {
  if (dirs.length === 0) return "idle";
  if (dirs.some((d) => d.state === "auth-lost")) return "auth-lost";
  if (dirs.some((d) => d.state === "error")) return "error";
  if (dirs.some((d) => d.state === "transferring" || d.state === "syncing")) return "transferring";
  if (dirs.every((d) => d.state === "paused")) return "paused";
  if (dirs.some((d) => d.state === "synced")) return "synced";
  return "idle";
}

/** A short tooltip summarising the aggregate state. */
export function trayTooltip(state: AggregateState): string {
  switch (state) {
    case "synced":
      return "Treehouse — up to date";
    case "transferring":
      return "Treehouse — syncing…";
    case "error":
      return "Treehouse — a folder needs attention";
    case "auth-lost":
      return "Treehouse — sign in needed";
    case "paused":
      return "Treehouse — paused";
    default:
      return "Treehouse";
  }
}

/**
 * Icon variant name the tray should show for an aggregate state. Mapped to a
 * template image in tray.ts; kept as a string here so the mapping is testable.
 */
export function trayIconKind(state: AggregateState): "ok" | "sync" | "warn" | "idle" {
  switch (state) {
    case "synced":
      return "ok";
    case "transferring":
      return "sync";
    case "error":
    case "auth-lost":
      return "warn";
    default:
      return "idle";
  }
}

/**
 * A short text glyph shown as the tray TITLE so the menubar item is VISIBLE even
 * before template icon assets exist (an empty NativeImage renders zero-width). One
 * glyph per icon kind; swap for `setImage` once the template art lands.
 */
export function trayGlyph(kind: ReturnType<typeof trayIconKind>): string {
  switch (kind) {
    case "ok":
      return "🌳";
    case "sync":
      return "🔄";
    case "warn":
      return "⚠️";
    default:
      return "🌱";
  }
}

/** A human-readable per-folder status line, including the error reason. */
export function humanState(dir: DirStatus): string {
  switch (dir.state) {
    case "synced":
      return "Up to date";
    case "transferring":
      return "Syncing…";
    case "syncing":
      return dir.degraded ? "Reconnecting…" : "Starting…";
    case "paused":
      return "Paused";
    case "auth-lost":
      return "Sign in needed";
    case "error":
      return dir.error ? `Error — ${dir.error}` : "Error";
    default:
      return dir.error ? `Error — ${dir.error}` : "Error";
  }
}

/** The menu title for a folder: its basename + its state. */
export function folderTitle(dir: DirStatus): string {
  return `${basename(dir.root)} — ${humanState(dir)}`;
}

// How long a refused change stays on the menu. Long enough to be seen by someone
// who only opens the menu once a day; the sync log keeps the record after that.
const NOTICE_WINDOW_MS = 24 * 60 * 60_000;
const NOTICES_SHOWN = 5;

/** A folder's refused changes from the last day. Tolerates an older daemon's status. */
export function recentNotices(dir: DirStatus, now = Date.now()): DirNotice[] {
  return (dir.notices ?? []).filter((n) => now - Date.parse(n.at) < NOTICE_WINDOW_MS);
}

/** The one-line headline for a folder's refused changes, or null when there are none. */
export function noticeHeadline(dir: DirStatus, now = Date.now()): string | null {
  const count = recentNotices(dir, now).length;
  if (count === 0) return null;
  const changes = count === 1 ? "1 change" : `${count} changes`;
  const why =
    dir.notices?.[0]?.reason === "key_folder" ? "outside this key's folder" : "view-only access";
  return `${changes} not synced, ${why}`;
}

/** One refused change, as a menu line: what happened to the user's work. */
export function noticeLine(notice: DirNotice): string {
  if (notice.outcome === "reverted") return `${notice.path}: reverted, your edit is saved`;
  if (notice.outcome === "restored") return `${notice.path}: restored after delete`;
  return `${notice.path}: not uploaded`;
}

/** Whether any folder is in the auth-lost state (drives the re-authenticate action). */
export function hasAuthLoss(dirs: DirStatus[]): boolean {
  return dirs.some((d) => d.state === "auth-lost");
}

/** The actions a folder's submenu can offer. tray.ts maps each id to a click. */
export type FolderActionId =
  | "open-folder"
  | "open-workspace"
  | "reauthenticate"
  | "pause"
  | "resume"
  | "relocate"
  | "unlink";

export interface FolderAction {
  id: FolderActionId;
  label: string;
}

export interface FolderMenu {
  /** Non-interactive line showing where the folder actually lives (R8). */
  path: string;
  /** Refused local changes, informational: a headline, then the latest few. */
  notices: string[];
  actions: FolderAction[];
}

/** A path with the home directory collapsed to `~`, for display only. */
export function displayPath(path: string, home: string = homedir()): string {
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === h) return "~";
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/**
 * What a folder's submenu shows. Which actions apply is a DECISION, so it lives
 * here rather than in the Electron menu builder (the convention doc names
 * per-folder action selection in tray.ts as exactly the smell to avoid).
 *
 * Pause/resume/re-authenticate are state-dependent; "Change Location…" and
 * "Unlink…" are always offered. Relocation deliberately stays available even for
 * an errored or auth-lost folder: a folder that has gone missing is one of the
 * cases the user most wants to fix from here, and `planRelocation` refuses with
 * its own explanation if the move can't be made safely — hiding the item would
 * only replace that explanation with silence.
 */
export function folderMenu(dir: DirStatus, home?: string, now = Date.now()): FolderMenu {
  const stateAction: FolderAction =
    dir.state === "auth-lost"
      ? { id: "reauthenticate", label: "Re-authenticate…" }
      : dir.state === "paused"
        ? { id: "resume", label: "Resume Syncing" }
        : { id: "pause", label: "Pause Syncing" };

  return {
    path: displayPath(dir.root, home),
    notices: [
      ...(noticeHeadline(dir, now) ? [noticeHeadline(dir, now) as string] : []),
      ...recentNotices(dir, now).slice(0, NOTICES_SHOWN).map(noticeLine),
    ],
    actions: [
      { id: "open-folder", label: "Open in Finder" },
      { id: "open-workspace", label: "Open Workspace" },
      stateAction,
      { id: "relocate", label: "Change Location…" },
      { id: "unlink", label: "Stop Syncing This Folder…" },
    ],
  };
}