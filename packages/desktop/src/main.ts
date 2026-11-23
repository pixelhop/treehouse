import { join } from "node:path";
import { loadLinks } from "cli/src/links-store";
import { appDir } from "cli/src/paths";
import { app, dialog, nativeImage } from "electron";
import { installAppLog } from "./app-log";
import { installE2EDialogs } from "./e2e";
import { registerBridgeHandlers } from "./bridge-handlers";
import { startDaemonOwnershipMonitor } from "./daemon";
import { routeDeepLink } from "./deep-link";
import { fetchDescriptor } from "./descriptor";
import { DEFAULT_APP_ORIGIN, type TrustedOrigins } from "./origins";
import {
  awaitFinishingFlow,
  isOnboarding,
  reauthenticate,
  resumeOnboarding,
  startOnboarding,
} from "./onboarding/run";
import { loadOnboarding, trustedOrigins } from "./onboarding/state";
import { createTray, refresh as refreshTray } from "./tray";
import { SHELL_VERSION } from "./security";
import { isQuittingForUpdate, startAutoUpdate } from "./updater";
import { getWorkspaceWindow, loadInWorkspaceWindow, setWorkspaceSentinelHandler } from "./windows";
import { shutdownAnalytics } from "./analytics";

// First, so everything below — including a failed bootstrap — lands in app.log.
installAppLog();
console.log(
  `[main] Treehouse ${SHELL_VERSION} starting (${app.isPackaged ? "packaged" : "dev"}, ${process.platform} ${process.arch})`,
);

/** Guards the will-quit re-entry: app.quit() fires will-quit again. */
let analyticsFlushed = false;

// Electron app lifecycle + treehouse:// deep-link routing. Tray up first (the
// menubar presence IS the app), then pick an entry: a cold-start deep link, an
// interrupted onboarding, the workspace for a returning user, or fresh onboarding.
// Deep links are untrusted input — routed through the pure router (deep-link.ts),
// never fed to openExternal/navigation, and unknown origins still clear U7's TOFU.

// Insecure transport is a DEV affordance only — gate on `!app.isPackaged`, not
// NODE_ENV (a packaged Electron build doesn't set NODE_ENV=production, so keying
// off it would silently accept http origins/descriptors in the shipped app).
const allowInsecure = !app.isPackaged;

// Identity, asserted before `whenReady` — Electron builds the default macOS menu
// from `app.getName()` at ready, and `userData` is derived from it on first use.
//
// A packaged build gets "Treehouse" from the bundle's CFBundleName (electron-builder
// writes it from `productName`); an UNPACKAGED dev run has no bundle of ours, so it
// falls back to the literal "Electron" in the app menu. Setting it explicitly makes
// dev match the shipped app.
//
// The macOS DOCK TILE is not ours to name in dev: its title and tooltip come from
// the running .app bundle, which is Electron's own. That only reads "Treehouse" once
// the app is packaged — there is no API fix.
app.setName("Treehouse");

// Keep Chromium's profile OUT of the CLI's state directory, one level under it.
// `userData` would otherwise default to `<appData>/<app name>` — now exactly the dir
// `cli/src/paths.ts` owns (links.json, daemon.pid, daemon.sock, bin/) — dropping
// Cache/, Cookies and the persistent session partition on top of the daemon's state,
// where anything clearing app data would take the links registry and the installed
// daemon binary with it.
//
// Derived from the CLI's own `appDir()` rather than `app.getPath("appData")` so the
// two can't drift, and so TREEHOUSE_HOME isolates the WHOLE app: without this the
// env var redirects the daemon's state but not the browser profile, and a run meant
// to be self-contained would still read and write the real session cookies.
//
// Moving `userData` orphans the previous profile (a session partition lives inside
// it), so a change here signs everyone out. Free for now — never released.
app.setPath("userData", join(appDir(), "desktop"));

let appReady = false;
let pendingDeepLink: string | null = null;

/** Resolve the trusted origins for the returning-user app origin, or null. */
async function resolveOrigins(preferred?: string): Promise<TrustedOrigins | null> {
  // A link's own origin wins, but only one this Mac already trusts — a deep link is
  // untrusted input, and opening a window on an unvetted origin skips TOFU.
  const trusted = trustedOrigins();
  const appOrigin =
    (preferred && (trusted.includes(preferred) || preferred === DEFAULT_APP_ORIGIN)
      ? preferred
      : undefined) ??
    trusted[0] ??
    DEFAULT_APP_ORIGIN;
  const descriptor = await fetchDescriptor(appOrigin, { allowInsecure });
  return descriptor ? { app: appOrigin, api: descriptor.apiUrl } : null;
}

/**
 * Open (or focus) the workspace window, resolving origins first. With a
 * `workspaceId`, land on THAT workspace. Without one the page falls back to the
 * last-viewed workspace, which is right for a bare "Open Workspace" but wrong for
 * anything that names one: a "Open in Treehouse" link or a folder's own menu item
 * used to show whichever workspace happened to be open — a different one than the
 * folder in question, so the UI appeared to describe the wrong folder.
 */
async function openWorkspace(workspaceId?: string, appOrigin?: string): Promise<void> {
  const existing = getWorkspaceWindow();
  // Mid-setup the window IS the setup (a folder step, an approval page). Navigating
  // it to a workspace would strand that flow, so just bring it forward.
  if (existing && (!workspaceId || isOnboarding())) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const origins = await resolveOrigins(appOrigin);
  if (!origins) return;
  const url = workspaceId
    ? new URL(`/w/${encodeURIComponent(workspaceId)}`, origins.app).toString()
    : origins.app;
  const win = loadInWorkspaceWindow(url, origins);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Connect a folder for a workspace the user picked in the normal workspace UI.
 * Enters the SAME spine as first-run: the workspace step resolves the name from
 * the id (no re-picking), then the folder step asks where it should live.
 *
 * Refused while a flow is already running — that flow's own listener owns the
 * navigation, and superseding it here would abandon work the user is mid-way
 * through. But refusing SILENTLY is its own bug: the bridge awaits this call and
 * refreshes on resolution, so the page found no new folder and said nothing. The
 * user clicked "connect a folder" and, as far as they could tell, nothing
 * happened. Surfacing the running flow's window instead answers the only question
 * they have — where did my click go — and points them at the work they still have
 * to finish before a second folder can be started.
 */
async function connectFolderFor(workspaceId: string, origin?: string): Promise<void> {
  if (isOnboarding() && !(await awaitFinishingFlow())) {
    // Onboarding drives the workspace window, so raising that window IS showing the
    // user where their click went. Deliberately not a dialog: the running flow is
    // already on screen and asking for input, and a modal on top of it would be one
    // more thing to dismiss before they can answer it.
    const win = getWorkspaceWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return;
  }
  // Prefer the origin the request actually came from — the window that emitted the
  // sentinel, or the workspace window the page is running in. Falling back to
  // `trustedOrigins()[0]` unconditionally resolves the workspace against whichever
  // server happens to be listed first, which is the wrong one as soon as a
  // self-hosted instance adds a second.
  const appOrigin = origin ?? trustedOrigins()[0] ?? DEFAULT_APP_ORIGIN;
  try {
    await startOnboarding({ appOrigin, workspaceId });
  } catch (err: unknown) {
    console.error("[main] connect folder failed:", err);
    void dialog.showMessageBox({
      type: "error",
      title: "Treehouse",
      message: "Couldn't connect a folder for that workspace",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function startTray(): void {
  createTray({
    openWorkspace: (workspaceId, appOrigin) => void openWorkspace(workspaceId, appOrigin),
    // Re-auth can fail before the machine takes over (e.g. the folder's config is
    // unreadable, so there's no API origin to grant against). This is a menubar
    // click with no window behind it — without a dialog the click would appear to
    // do nothing at all, so report it rather than swallowing the rejection.
    reAuthenticate: (dir) => {
      void reauthenticate({ root: dir.root, workspaceId: dir.workspaceId }).catch(
        (err: unknown) => {
          console.error("[main] re-authenticate failed:", err);
          void dialog.showMessageBox({
            type: "error",
            title: "Treehouse",
            message: "Couldn't re-authenticate that folder",
            detail: err instanceof Error ? err.message : String(err),
          });
        },
      );
    },
    // "Add a Folder…": re-enter the onboarding spine against the origin this Mac
    // is already signed in to (falling back to the hosted default), so connecting
    // a second folder is the same flow as the first rather than a separate one.
    addFolder: () => {
      const appOrigin = trustedOrigins()[0] ?? DEFAULT_APP_ORIGIN;
      void startOnboarding({ appOrigin }).catch((err: unknown) => {
        console.error("[main] add folder failed:", err);
        void dialog.showMessageBox({
          type: "error",
          title: "Treehouse",
          message: "Couldn't start connecting another folder",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    },
  });
}

/** The first treehouse:// URL in an argv list (Windows/Linux cold-start path). */
function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.startsWith("treehouse://")) ?? null;
}

/** Route a raw deep-link URL to an action and perform it. Buffered until ready.
 * Returns whether the link was acted on — a garbage/unknown-host URL resolves to
 * `ignore` and returns false so the cold-start path can fall through to the normal
 * entry instead of leaving the app running with no UI. */
function handleDeepLink(raw: string): boolean {
  if (!appReady) {
    pendingDeepLink = raw;
    return true; // buffered — it will be handled once ready
  }
  const action = routeDeepLink(raw, {
    linkedWorkspaceIds: loadLinks().map((l) => l.workspaceId),
    onboarding: isOnboarding(),
  });
  switch (action.type) {
    case "ignore":
      return false;
    case "focus-workspace":
      void openWorkspace(action.workspaceId, action.appOrigin);
      return true;
    case "onboard":
      // Supersede rule: a new link restarts onboarding for its target (the machine
      // aborts + awaits any active flow, then starts clean for a different target).
      void startOnboarding(action.entry).catch((e: unknown) => console.error(e));
      return true;
  }
}

/**
 * Show the app icon on the Dock tile in dev. A packaged build gets this from the
 * bundle's icon.icns (electron-builder `mac.icon`); an unpackaged run would show
 * the stock Electron icon instead, so the artwork can't be reviewed without cutting
 * a release. Reads the same 1024 master the .icns is packed from. Best-effort: a
 * missing/unreadable file leaves the default icon rather than failing the boot.
 */
function setDevDockIcon(): void {
  if (app.isPackaged || !app.dock) return;
  const icon = nativeImage.createFromPath(join(__dirname, "..", "build", "icon.png"));
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

async function bootstrap(): Promise<void> {
  appReady = true;
  installE2EDialogs();
  setDevDockIcon();
  setWorkspaceSentinelHandler(connectFolderFor);
  // The page's read-and-request bridge. Registered once, before any window opens.
  registerBridgeHandlers({
    connectFolder: connectFolderFor,
    refresh: refreshTray,
  });
  startTray();

  // Own the shared daemon binary at the stable path: install/upgrade it (signature
  // verified), point launchd there, and repair plist drift an older CLI introduces —
  // now and periodically (U10). Only in the packaged app, where a bundled daemon
  // exists; a dev run has no resources/daemon and must not touch real launchd.
  if (app.isPackaged) {
    startDaemonOwnershipMonitor();
    // Re-render the menubar on every updater transition — the item's label IS the
    // progress indicator (see updater.ts).
    startAutoUpdate(() => void refreshTray());
  }

  // 0) A cold-start deep link takes precedence over the default entry — but only
  //    if it actually resolved to an action. A garbage/unknown-host URL (any web
  //    page can fire `treehouse://steal` while the app is closed) is ignored, and
  //    we must fall through to the normal entry rather than sit with no UI.
  const coldStart = pendingDeepLink ?? deepLinkFromArgv(process.argv);
  if (coldStart) {
    pendingDeepLink = null;
    if (handleDeepLink(coldStart)) return;
  }

  // 1) An interrupted onboarding takes priority — resume to the right screen. If it
  //    ended in an (abandoned) error — e.g. a declined trust for a hostile origin —
  //    the record was cleared; fall through to the normal entry.
  if (loadOnboarding()) {
    const step = await resumeOnboarding();
    if (step !== "error") return;
  }

  // 2) Returning user with linked folders — open the workspace window signed in.
  if (loadLinks().length > 0) {
    await openWorkspace();
    return;
  }

  // 3) Fresh install, no invite context — onboard against the default hosted
  //    origin (F2 create-workspace path).
  await startOnboarding({ appOrigin: DEFAULT_APP_ORIGIN });
}

// Single-instance lock: a second launch (e.g. from a deep link) hands off to the
// running instance instead of starting a rival.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Register the treehouse:// handler (electron-builder writes the packaged
  // Info.plist entry; this re-asserts ownership).
  //
  // NOT in a dev run unless asked: on macOS this rewrites the user's LaunchServices
  // default for the scheme to the stock Electron.app, so after one `pnpm dev` every
  // "Open in Treehouse" link on the machine — including for the INSTALLED app —
  // launched a bare Electron instead. The e2e harness opts in for the one pass
  // that tests a real browser → app hand-off, and restores the default afterwards.
  if (app.isPackaged || process.env.TREEHOUSE_DEV_PROTOCOL === "1") {
    app.setAsDefaultProtocolClient("treehouse");
  }

  app.on("second-instance", (_event, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) handleDeepLink(url);
    else void openWorkspace();
  });

  // macOS: clicking the Dock icon, or opening the app again from Finder or Spotlight
  // while it is already running, re-activates THIS process. It does not start a
  // second instance, so `second-instance` never fires. Without this handler a
  // running app whose window had closed ignored every attempt to reopen it, and
  // looked broken unless you knew to use the menubar.
  app.on("activate", (_event, hasVisibleWindows) => {
    if (appReady && !hasVisibleWindows) void openWorkspace();
  });

  // macOS delivers deep links via open-url — registered in will-finish-launching
  // because a COLD-START URL arrives before `ready` (and not in argv).
  app.on("will-finish-launching", () => {
    app.on("open-url", (event, url) => {
      event.preventDefault();
      handleDeepLink(url);
    });
  });

  void app
    .whenReady()
    .then(() => bootstrap().catch((e: unknown) => console.error("[bootstrap]", e)));
}

// The menubar presence IS the app: closing the workspace window sheds its memory
// but never quits. The user quits explicitly from the tray ("Quit (sync continues)").
app.on("window-all-closed", () => {
  // no-op
});

// Flush buffered analytics on the way out. Events are batched, so without this
// the last thing that happened before a quit — often the interesting thing — is
// the one that never gets reported. `will-quit` runs before the process ends and
// lets us await the flush.
//
// Never for an update restart: that flushes before it starts, and holding its quit
// once left the app running with no window (see `isQuittingForUpdate`).
app.on("will-quit", (event) => {
  if (analyticsFlushed || isQuittingForUpdate()) return;
  event.preventDefault();
  analyticsFlushed = true;
  void shutdownAnalytics().finally(() => app.quit());
});