import { basename } from "node:path";
import { applyPause, cmdUnlink } from "cli/src/commands";
import type { DirStatus } from "cli/src/daemon";
import { loadLinks } from "cli/src/links-store";
import { ensureLogDir } from "cli/src/paths";
import { relocateFolder } from "cli/src/relocate";
import {
  app,
  dialog,
  type MenuItemConstructorOptions,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { pollDaemonStatus, startDaemon, type StatusSnapshot } from "./daemon";
import { promptForNewLocation } from "./relocate-prompt";
import { revokeFolderKey, signOut } from "./signout";
import {
  aggregateState,
  type FolderActionId,
  folderMenu,
  folderTitle,
  noticeHeadline,
  trayGlyph,
  trayIconKind,
  trayTooltip,
} from "./status";
import { checkForUpdates, updateMenuEnabled, updateMenuLabel, updateState } from "./updater";

// The menubar presence (origin R6, F3). The tray icon reflects the aggregate sync
// state; the menu lists every folder with its live state + reason and the actions
// the origin promises. Status is polled over IPC (U2 handshake) at a gentle
// interval; when the daemon is down the menu shows last-known state + "Start sync".
// Icon/label logic is pure in status.ts (tested); this file is Electron wiring
// (U12 checklist).

const POLL_MS = 5000;

export interface TrayActions {
  /** Open (or focus) the workspace window — on a specific workspace when given.
   * The per-folder item passes its folder's workspace: opening "whichever one
   * was last viewed" put a different workspace on screen than the folder the
   * user clicked, which read as that folder syncing somewhere else. */
  openWorkspace(workspaceId?: string, appOrigin?: string): void;
  /** Re-enter the grant for an auth-lost folder (menubar "Re-authenticate"). */
  reAuthenticate(dir: DirStatus): void;
  /** Re-enter onboarding to connect another folder (menubar "Add a Folder…"). */
  addFolder(): void;
}

let tray: Tray | null = null;
let actions: TrayActions | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function createTray(a: TrayActions): Tray {
  actions = a;
  if (!tray || tray.isDestroyed()) tray = new Tray(nativeImage.createEmpty());
  void refresh();
  if (!pollTimer) {
    pollTimer = setInterval(() => void refresh(), POLL_MS);
    pollTimer.unref?.();
  }
  return tray;
}

export function getTray(): Tray | null {
  return tray && !tray.isDestroyed() ? tray : null;
}

/** Poll the daemon and re-render the tray. Exported so the bridge can refresh it
 * after a relocation the page requested. */
export async function refresh(): Promise<void> {
  const snapshot = await pollDaemonStatus();
  render(snapshot);
}

/** A tray action failed: log it and re-render so the menu reflects reality rather
 * than silently leaving a stale item after the click did nothing. */
function onActionError(err: unknown): void {
  console.error("[tray] action failed:", err);
  void refresh();
}

/** Tell the user a sign-out only half-succeeded. The folders stopped syncing, but a
 * key we couldn't revoke is still valid on the server — on a shared Mac that is a
 * real gap, so it must not be reported as (or silently look like) a clean sign-out. */
function reportPartialSignOut(failedCount: number): void {
  void dialog.showMessageBox({
    type: "warning",
    title: "Treehouse",
    message: "Signed out, but some access keys are still active",
    detail:
      `${failedCount} key${failedCount === 1 ? "" : "s"} couldn't be revoked. ` +
      "Your folders have stopped syncing, but sign in and sign out again to fully " +
      "revoke access — especially on a shared computer.",
  });
}

function render(snapshot: StatusSnapshot): void {
  if (!tray || tray.isDestroyed()) return;
  const agg = aggregateState(snapshot.dirs);
  // Until template icon assets land (U11), give the menubar item a VISIBLE presence
  // via a text-glyph title keyed off the icon kind — an empty NativeImage alone
  // renders zero-width and unreachable. Swap to `tray.setImage(<template art>)` once
  // the assets exist; the kind → art mapping is `trayIconKind`.
  tray.setTitle(trayGlyph(trayIconKind(agg)));
  tray.setToolTip(trayTooltip(agg));
  tray.setContextMenu(Menu.buildFromTemplate(buildMenu(snapshot)));
}

/** Report a menubar action that couldn't be carried out. A tray click has no
 * window behind it, so a swallowed failure looks exactly like a dead menu item. */
function reportFailure(message: string, detail: string): void {
  void dialog.showMessageBox({ type: "warning", title: "Treehouse", message, detail });
}

/** Open the logs folder. `shell.openPath` resolves to an error string rather than
 * rejecting, so a failure has to be surfaced by hand or the click looks dead. */
async function showLogs(): Promise<void> {
  const error = await shell.openPath(ensureLogDir());
  if (error) reportFailure("Couldn't open the logs folder", error);
}

/** Ask where a folder should move to and move it. The asking is shared with the
 * bridge (`promptForNewLocation`); everything else is `relocateFolder`'s call —
 * it plans the move, refuses with a sentence we can show, and executes
 * pause → move → commit → resume. */
async function changeLocation(dir: DirStatus): Promise<void> {
  const name = basename(dir.root);
  const destination = await promptForNewLocation(dir.root);
  if (destination === null) return; // cancelling leaves the folder exactly as it was

  try {
    const result = await relocateFolder(dir.root, destination);
    if (!result.ok) reportFailure(`Couldn't move “${name}”`, result.message);
  } catch (err) {
    // A step failed midway. The thrown message says where the files ended up —
    // the one thing the user needs and the one thing a console.error won't tell
    // them, so it goes in front of them rather than into the log.
    reportFailure(
      `Couldn't finish moving “${name}”`,
      err instanceof Error ? err.message : String(err),
    );
  }
  await refresh();
}

/** Stop syncing a folder. The files stay put on both sides — say so, because
 * "unlink" reads like "delete" to anyone who hasn't read the docs. */
async function unlinkFolder(dir: DirStatus): Promise<void> {
  const name = basename(dir.root);
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Treehouse",
    message: `Stop syncing “${name}”?`,
    detail:
      "The folder and its files stay on this Mac, and the workspace keeps its copies — they just stop being kept in step. You can connect it again later.",
    buttons: ["Stop Syncing", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;

  // Revoke BEFORE removing the link, and abort the unlink if revocation fails.
  // Order is load-bearing: sign-out finds keys to revoke by walking links.json, so
  // once removeLink has run the key is invisible to every in-app revocation path —
  // left live on the server with its plaintext copy still in the folder's config,
  // and no way to kill it from the product. "Stop syncing" is exactly when a user
  // expects this machine's access to end, so failing closed is the right trade:
  // better a folder that is still linked than a key nobody can revoke.
  try {
    await revokeFolderKey(dir.root);
  } catch (err) {
    await dialog.showMessageBox({
      type: "error",
      title: "Treehouse",
      message: "Couldn't revoke this folder's access key",
      detail: `${
        err instanceof Error ? err.message : String(err)
      }\n\nThe folder is still connected. Try again when you're back online — stopping now would leave a key we can no longer revoke.`,
      buttons: ["OK"],
    });
    return;
  }
  await cmdUnlink(dir.root);
  await refresh();
}

/** Run a per-folder action chosen in status.ts. No decisions here — just glue. */
function runFolderAction(id: FolderActionId, dir: DirStatus): void {
  switch (id) {
    case "open-folder":
      void shell.openPath(dir.root);
      return;
    case "open-workspace":
      // With the server the folder was connected through: an id alone resolves
      // against whichever trusted server is listed first, which is the wrong one
      // for a Mac connected to more than one.
      actions?.openWorkspace(
        dir.workspaceId,
        loadLinks().find((l) => l.root === dir.root)?.appOrigin,
      );
      return;
    case "reauthenticate":
      actions?.reAuthenticate(dir);
      return;
    case "pause":
      void applyPause(dir.root, true).then(refresh).catch(onActionError);
      return;
    case "resume":
      void applyPause(dir.root, false).then(refresh).catch(onActionError);
      return;
    case "relocate":
      void changeLocation(dir).catch(onActionError);
      return;
    case "unlink":
      void unlinkFolder(dir).catch(onActionError);
      return;
  }
}

function folderSubmenu(dir: DirStatus): MenuItemConstructorOptions[] {
  const menu = folderMenu(dir);
  return [
    // Where the folder actually lives (R8) — informational, never clickable.
    { label: menu.path, enabled: false },
    ...menu.notices.map((label) => ({ label, enabled: false })),
    { type: "separator" },
    ...menu.actions.map((action) => ({
      label: action.label,
      click: () => runFolderAction(action.id, dir),
    })),
  ];
}

function buildMenu(snapshot: StatusSnapshot): MenuItemConstructorOptions[] {
  // Treehouse is in beta. The window loads the web app, which carries its own
  // beta tag; the menubar is the one surface the desktop app draws itself.
  const items: MenuItemConstructorOptions[] = [
    { label: "Treehouse Beta", enabled: false },
    { type: "separator" },
  ];

  if (snapshot.dirs.length === 0) {
    items.push({ label: "No folders synced yet", enabled: false });
  } else {
    for (const dir of snapshot.dirs) {
      items.push({ label: folderTitle(dir), submenu: folderSubmenu(dir) });
      // On the top level, not in the submenu: this is the user's own work coming
      // back, and the folder's state still reads as healthy.
      const headline = noticeHeadline(dir);
      if (headline) items.push({ label: `⚠ ${headline}`, enabled: false });
    }
  }

  items.push({ type: "separator" });
  items.push({ label: "Open Workspace", click: () => actions?.openWorkspace() });
  // Re-enter the onboarding spine for another folder. Always available: a
  // zero-folder menu needs it most, and it is the only way to add a second one.
  items.push({ label: "Add a Folder…", click: () => actions?.addFolder() });

  if (!snapshot.running) {
    // The daemon is down — offer to start it (sync otherwise stays stopped).
    items.push({
      label: "Start Sync",
      click: () => void startDaemon().then(refresh).catch(onActionError),
    });
  }

  items.push({ type: "separator" });
  const anyPaused = snapshot.dirs.some((d) => d.state === "paused");
  const anyActive = snapshot.dirs.some((d) => d.state !== "paused");
  if (anyActive) {
    items.push({
      label: "Pause Syncing",
      // Refresh only once every folder has settled. applyPause is async (setPaused
      // + an IPC reload), so refreshing immediately re-rendered the menu from state
      // the writes hadn't reached yet — leaving it stale until the next 5s poll.
      click: () => {
        const pending = snapshot.dirs
          .filter((d) => d.state !== "paused")
          .map((d) => applyPause(d.root, true).catch(onActionError));
        void Promise.allSettled(pending).then(refresh);
      },
    });
  }
  if (anyPaused) {
    // A global counterpart to Pause so a signed-in user can resume every folder at
    // once (per-folder Resume also stays available in each submenu).
    items.push({
      label: "Resume Syncing",
      click: () => {
        const pending = snapshot.dirs
          .filter((d) => d.state === "paused")
          .map((d) => applyPause(d.root, false).catch(onActionError));
        void Promise.allSettled(pending).then(refresh);
      },
    });
  }
  items.push({
    label: "Sign Out",
    // A partial sign-out (folders paused, but a key that couldn't be revoked is
    // still LIVE on the server) must be visible. signout.ts only console.errors it,
    // which nobody sees in a packaged app, and discarding the result here left the
    // menubar looking like a clean sign-out.
    click: () =>
      void signOut()
        .then((result) => {
          void refresh();
          if (result.failedKeyIds.length > 0) reportPartialSignOut(result.failedKeyIds.length);
        })
        .catch(onActionError),
  });
  items.push({ type: "separator" });
  // The updater's state, as a clickable item. This is the app's ONLY self-update
  // affordance: there is no custom app menu, and the previous build surfaced
  // updates solely through a macOS Notification for a permission it never asks
  // for — so a user had no way to trigger a check, and no way to tell a working
  // updater from a dead one. Unpackaged runs have no update feed at all, so the
  // item stays visible (the absence of it would be its own mystery) but says why.
  const update = updateState();
  items.push(
    app.isPackaged
      ? {
          label: updateMenuLabel(update, app.getVersion()),
          enabled: updateMenuEnabled(update),
          click: () => checkForUpdates(true),
        }
      : { label: "Updates disabled in dev builds", enabled: false },
  );

  // The daemon's, the app's and the updater's logs all live in one folder; opening
  // it is the one-click way to look at them (Console.app opens .log files) or to
  // drag them into a bug report. `treehouse logs` is the same thing for the CLI.
  items.push({
    label: "Show Logs in Finder",
    click: () => void showLogs().catch(onActionError),
  });

  items.push({ type: "separator" });
  // Quit closes the UI only — the launchd-managed daemon keeps syncing (KTD).
  items.push({ label: "Quit (sync continues)", role: "quit" });

  return items;
}