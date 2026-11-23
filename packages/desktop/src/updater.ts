import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLogDir } from "cli/src/paths";
import { app, BrowserWindow, autoUpdater as nativeAutoUpdater, dialog } from "electron";
import electronUpdater from "electron-updater";
import { shutdownAnalytics } from "./analytics";

// App self-update: the electron-updater wiring, the state the menubar renders,
// and the restart prompt.
//
// The previous version of this was three lines in main.ts calling
// `checkForUpdatesAndNotify()` with `console.error` for errors, and it was
// indistinguishable from a working updater with nothing to offer. A packaged app
// has no console anyone reads, the only success signal was a macOS Notification
// (for a permission the app never requests), and the install waited for a quit
// that a menubar app never gets. So a completely broken updater — which is what
// shipped, see after-pack.cjs on the signing requirement — looked exactly like
// "you're up to date" for months.
//
// Everything here therefore exists to make the updater SAY what it is doing:
//   • every transition is appended to ~/Library/Logs/Treehouse/updater.log,
//     next to the daemon's own log, so a failure is diagnosable after the fact;
//   • the current state is a menubar item, so it is visible without any log;
//   • a manual check answers in a dialog either way, so "nothing happened" is
//     never the response to a click;
//   • a downloaded update asks to restart rather than waiting for a quit.
//
// The label logic is pure and unit-tested; the Electron wiring below is not.

/** What the updater is doing right now. Drives the menubar item's label. */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

/**
 * The menubar label for an updater state. Deliberately states the CURRENT
 * version when up to date: "Check for Updates…" alone leaves the user unable to
 * tell a working updater from a stuck one, which is the exact failure this
 * module exists to remove.
 */
export function updateMenuLabel(state: UpdateState, currentVersion: string): string {
  switch (state.kind) {
    case "idle":
      return "Check for Updates…";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return `Up to date (${currentVersion})`;
    case "downloading":
      return `Downloading update… ${state.percent}%`;
    case "ready":
      return `Restart to update to ${state.version}`;
    case "error":
      return "Update check failed — click to retry";
  }
}

/** Whether the menubar item accepts a click. In-flight work is not re-entrant. */
export function updateMenuEnabled(state: UpdateState): boolean {
  return state.kind !== "checking" && state.kind !== "downloading";
}

/**
 * What a check should do when an update is ALREADY downloaded and waiting.
 *
 * `promptRestart` remembers the versions it has offered so a declined restart
 * isn't re-asked, but re-opening deliberately clears that memory — so this has
 * to distinguish the two callers, or the 6h background tick re-opens a prompt
 * the user just dismissed, every 6h, forever.
 *
 *   • a menubar click means "apply it" — re-open the prompt;
 *   • a background tick has already asked once — do nothing. Falling through to
 *     a fresh check would be worse than pointless: the feed still advertises the
 *     same version, so it would re-download an update already on disk.
 */
export function readyStateAction(
  state: UpdateState,
  userInitiated: boolean,
): "reopen-prompt" | "do-nothing" | "check" {
  if (state.kind !== "ready") return "check";
  return userInitiated ? "reopen-prompt" : "do-nothing";
}

let state: UpdateState = { kind: "idle" };
let notifyChanged: () => void = () => {};
/** Set while a user-initiated check is in flight — it owes them an answer. */
let awaitingUserAnswer = false;
/** Versions already offered, so a declined restart isn't re-asked every 6h. */
const promptedVersions = new Set<string>();
/** Set once Electron starts the update restart; see `isQuittingForUpdate`. */
let quittingForUpdate = false;
let restartWatchdog: ReturnType<typeof setTimeout> | null = null;

/**
 * How long an update restart may take, from Electron closing the windows to the
 * process exiting, before the app forces its own exit. The real handover takes
 * well under a second.
 */
const RESTART_WATCHDOG_MS = 10_000;

/**
 * Whether the app is quitting to install an update. `will-quit` in main.ts must let
 * that quit straight through instead of deferring it to flush analytics.
 *
 * `quitAndInstall` closes every window BEFORE Squirrel asks the app to terminate, so
 * a quit that does not complete leaves the app running with no window, no install,
 * and nothing on screen to say so. That happened twice in a row on a real Mac: the
 * deferred quit never finished, the dock icon had nothing to reopen, and ShipIt sat
 * waiting for an exit that never came. The flush happens before the handover
 * instead (see `promptRestart`).
 */
export function isQuittingForUpdate(): boolean {
  return quittingForUpdate;
}

export function updateState(): UpdateState {
  return state;
}

function setState(next: UpdateState): void {
  state = next;
  notifyChanged();
}

/**
 * Append to the updater log. Best-effort: a log write that fails (full disk, a
 * locked-down Logs dir) must not take the updater down with it — losing the
 * diagnostic is bad, losing updates entirely is worse.
 */
function log(message: string): void {
  const line = `${new Date().toISOString()} [updater] ${message}`;
  try {
    appendFileSync(join(ensureLogDir(), "updater.log"), `${line}\n`);
  } catch {
    // best-effort
  }
  console.error(line);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Offer the restart. A menubar app is never quit deliberately, so the default
 * install-on-quit means a downloaded update can sit unapplied indefinitely —
 * asking is the only reliable way it ever lands.
 *
 * The detail line answers the question the button raises: restarting the app
 * does NOT stop syncing. The daemon is a separate launchd-managed process
 * (see daemon.ts), which is exactly why the app can be replaced under it.
 */
async function promptRestart(version: string): Promise<void> {
  if (promptedVersions.has(version)) return;
  promptedVersions.add(version);
  const { autoUpdater } = electronUpdater;
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Treehouse",
    message: `Treehouse ${version} is ready to install`,
    detail:
      "Restarting takes a few seconds. Your folders keep syncing throughout — " +
      "the sync engine runs separately from this app.",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    log(`user deferred the restart for ${version}`);
    return;
  }
  log(`installing ${version} and restarting`);
  // Flush now: once the restart begins, `will-quit` no longer waits for it.
  await shutdownAnalytics();
  autoUpdater.quitAndInstall();
}

/** Answer a manual check that found nothing (or failed). A click must never be
 * met with silence — that is indistinguishable from a dead menu item. */
function answerUserCheck(message: string, detail: string, type: "info" | "warning"): void {
  if (!awaitingUserAnswer) return;
  awaitingUserAnswer = false;
  void dialog.showMessageBox({ type, title: "Treehouse", message, detail, buttons: ["OK"] });
}

/**
 * Wire electron-updater: check on launch and every 6h, log every transition, and
 * surface the result. Packaged builds only — an unpackaged run has no
 * app-update.yml and `checkForUpdates` would throw.
 *
 * Errors are logged and shown, never thrown: a failed update check must not
 * crash or wedge the app.
 */
export function startAutoUpdate(onStateChange: () => void): void {
  notifyChanged = onStateChange;
  const { autoUpdater } = electronUpdater;

  // Route electron-updater's own (verbose) logging into the same file. Without
  // this its internals are silent, and the interesting part of a failure — the
  // feed URL it resolved, the signature error Squirrel reported — is exactly
  // what goes missing.
  autoUpdater.logger = {
    info: (m: unknown) => log(`info: ${String(m)}`),
    warn: (m: unknown) => log(`warn: ${String(m)}`),
    error: (m: unknown) => log(`error: ${String(m)}`),
    debug: (m: unknown) => log(`debug: ${String(m)}`),
  };

  autoUpdater.on("checking-for-update", () => {
    log("checking for updates");
    setState({ kind: "checking" });
  });
  autoUpdater.on("update-not-available", (info: { version?: string }) => {
    log(`no update available (latest: ${info?.version ?? "unknown"})`);
    setState({ kind: "up-to-date" });
    answerUserCheck(
      "Treehouse is up to date",
      `You're running version ${app.getVersion()}.`,
      "info",
    );
  });
  autoUpdater.on("update-available", (info: { version?: string }) => {
    log(`update available: ${info?.version ?? "unknown"} — downloading`);
    setState({ kind: "downloading", version: info?.version ?? "", percent: 0 });
    answerUserCheck(
      `Treehouse ${info?.version ?? ""} is available`,
      "It's downloading now. You'll be asked to restart when it's ready.",
      "info",
    );
  });
  autoUpdater.on("download-progress", (p: { percent?: number }) => {
    const version = state.kind === "downloading" ? state.version : "";
    setState({ kind: "downloading", version, percent: Math.round(p?.percent ?? 0) });
  });
  autoUpdater.on("update-downloaded", (info: { version?: string }) => {
    const version = info?.version ?? "";
    log(`update downloaded: ${version}`);
    setState({ kind: "ready", version });
    void promptRestart(version).catch((e: unknown) => log(`restart prompt failed: ${describe(e)}`));
  });
  // Electron emits this when the restart really starts: Squirrel has the update
  // staged and the windows are about to close. Mark the quit so `will-quit` lets it
  // through, and arm a watchdog: if the process is still alive once the handover
  // should long be over, it is the windowless state described on
  // `isQuittingForUpdate`, and exiting is what lets ShipIt install and relaunch.
  nativeAutoUpdater.on("before-quit-for-update", () => {
    log("restarting to install the update");
    quittingForUpdate = true;
    if (restartWatchdog) clearTimeout(restartWatchdog);
    restartWatchdog = setTimeout(() => {
      restartWatchdog = null;
      if (BrowserWindow.getAllWindows().length > 0) {
        // A page refused to unload (the editor guards unsaved work), so Electron
        // never got as far as the restart. The app is still usable; leave it be.
        log("restart cancelled: a window refused to close");
        quittingForUpdate = false;
        return;
      }
      log(`restart still pending after ${RESTART_WATCHDOG_MS}ms — forcing exit`);
      app.exit(0);
    }, RESTART_WATCHDOG_MS);
  });

  autoUpdater.on("error", (e: unknown) => {
    const message = describe(e);
    log(`FAILED: ${message}`);
    // A failed restart leaves the app running, so stand the watchdog down rather
    // than kill an app that has no update to relaunch into.
    if (restartWatchdog) clearTimeout(restartWatchdog);
    restartWatchdog = null;
    quittingForUpdate = false;
    setState({ kind: "error", message });
    answerUserCheck(
      "Couldn't check for updates",
      `${message}\n\nDetails are in ~/Library/Logs/Treehouse/updater.log.`,
      "warning",
    );
  });

  checkForUpdates(false);
  const timer = setInterval(() => checkForUpdates(false), 6 * 60 * 60_000);
  timer.unref?.();
}

/**
 * Run a check. `userInitiated` means a menubar click is waiting on an answer,
 * so the outcome is reported in a dialog rather than only in the label.
 *
 * When an update is already downloaded, a CLICK means "apply it" — re-checking
 * would find the same version and appear to do nothing. A background tick in
 * that state does nothing at all; see `readyStateAction`.
 */
export function checkForUpdates(userInitiated: boolean): void {
  const { autoUpdater } = electronUpdater;
  const action = readyStateAction(state, userInitiated);
  if (action === "do-nothing") return; // already downloaded and already offered
  if (action === "reopen-prompt" && state.kind === "ready") {
    const { version } = state;
    promptedVersions.delete(version); // an explicit click re-opens a declined prompt
    void promptRestart(version).catch((e: unknown) => log(`restart prompt failed: ${describe(e)}`));
    return;
  }
  awaitingUserAnswer = userInitiated;
  if (userInitiated) log("manual check requested from the menubar");
  autoUpdater.checkForUpdates().catch((e: unknown) => {
    // The `error` event covers most failures, but a synchronous rejection here
    // (a malformed feed URL, no app-update.yml) never reaches it.
    const message = describe(e);
    log(`FAILED: ${message}`);
    setState({ kind: "error", message });
    answerUserCheck(
      "Couldn't check for updates",
      `${message}\n\nDetails are in ~/Library/Logs/Treehouse/updater.log.`,
      "warning",
    );
  });
}