import { join } from "node:path";
import { BrowserWindow, session, shell, type WebContents } from "electron";
import { parseWorkspaceSentinel } from "./contract";
import type { TrustedOrigins } from "./origins";
import {
  isAllowedFrameNavigation,
  isAllowedNavigation,
  isPermissionGranted,
  SHELL_VERSION,
  isSafeExternalUrl,
  shellUserAgent,
  WORKSPACE_PARTITION,
  workspaceWindowOptions,
} from "./security";

// Electron wiring for the locked-down workspace window. All decisions come from
// the pure policy in `security.ts`; this file only attaches them to real Electron
// objects (so the security logic is testable without an Electron runtime, per the
// U6/U12 split).

/**
 * Apply the remote-content security posture to a webContents: navigation
 * allow-listed to the app/API origins; `window.open` denied with safe https links
 * routed to the system browser. Exported so any window rendering remote content
 * gets the same treatment.
 */
export function hardenWebContents(wc: WebContents, origins: TrustedOrigins): void {
  wc.on("will-navigate", (e, url) => {
    if (!isAllowedNavigation(url, origins)) e.preventDefault();
  });
  // Also block redirect-based escapes to a disallowed origin. Fires for subframes
  // too, so it takes the same frame-aware policy as below.
  wc.on("will-redirect", (e) => {
    if (!isAllowedFrameNavigation(e.url, origins, e.isMainFrame)) e.preventDefault();
  });
  // `will-navigate` only fires for the MAIN frame. An iframe navigates
  // independently, so without this a page could embed untrusted third-party
  // content — inside the authed workspace partition — and the allow-list above
  // would never see it. `will-frame-navigate` covers every frame, subframes
  // included; a subframe may additionally load a known video player.
  wc.on("will-frame-navigate", (e) => {
    if (!isAllowedFrameNavigation(e.url, origins, e.isMainFrame)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** Where esbuild puts the preload bundle, next to the main bundle. */
function preloadPath(): string {
  return join(__dirname, "preload.cjs");
}

/** Deny every permission the remote page requests, bar clipboard write for the
 * app origin (see `isPermissionGranted`). */
export function applyPermissionLockdown(partition: string, origins: TrustedOrigins): void {
  const ses = session.fromPartition(partition);
  // Declare the shell in the user agent so the web app can adapt its surface.
  // Session-wide, so it survives every navigation in this window.
  ses.setUserAgent(shellUserAgent(ses.getUserAgent(), SHELL_VERSION));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(isPermissionGranted(permission, details.requestingUrl, origins)),
  );
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isPermissionGranted(permission, requestingOrigin, origins),
  );
}

/** Wipe the workspace window's persistent partition (sign-out; U8). */
export async function clearWorkspaceSession(): Promise<void> {
  await session.fromPartition(WORKSPACE_PARTITION).clearStorageData();
}

let workspaceWindow: BrowserWindow | null = null;

/**
 * Called when the workspace window navigates to a connect sentinel OUTSIDE an
 * onboarding flow — i.e. the user asked, from the normal workspace UI, to connect
 * a folder for a workspace. Registered by main.ts.
 *
 * Without this the only listener is the one `awaitNavigationSignal` attaches for
 * the duration of the workspace step, so a page could ask for a folder and
 * nothing would be listening. That is why creating a workspace inside the app
 * used to leave you with no folder and no prompt.
 *
 * The workspace id here is a request from a page, not proof of anything: the flow
 * it starts re-resolves that id through a membership-checked lookup, and still
 * needs the user to choose a folder and approve a grant.
 */
// The handler receives the origin the sentinel was validated against, not just the
// id. The navigation is only accepted because it matched THIS window's
// `origins.app`; resolving the workspace against a different trusted origin would
// look up the id on a server that never issued it.
let sentinelHandler: ((workspaceId: string, appOrigin: string) => void) | null = null;

export function setWorkspaceSentinelHandler(
  fn: (workspaceId: string, appOrigin: string) => void,
): void {
  sentinelHandler = fn;
}

/** The live workspace window, or null if none is open. */
export function getWorkspaceWindow(): BrowserWindow | null {
  return workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : null;
}

/**
 * Open (or focus, if already open) the workspace window on the app origin. The
 * window is destroyed — not hidden — when closed, to shed Chromium memory; the
 * tray keeps the process alive.
 */
export function openWorkspaceWindow(appUrl: string, origins: TrustedOrigins): BrowserWindow {
  const existing = getWorkspaceWindow();
  if (existing) {
    existing.focus();
    return existing;
  }

  applyPermissionLockdown(WORKSPACE_PARTITION, origins);
  const win = new BrowserWindow(
    workspaceWindowOptions(WORKSPACE_PARTITION, preloadPath(), origins.app),
  );
  hardenWebContents(win.webContents, origins);
  // Watch for a connect request from the normal workspace UI, for the window's
  // whole life. `awaitNavigationSignal` covers the onboarding step; this covers
  // everything else. It defers while a flow is running so the two never both act
  // on one navigation — the step's own listener owns it then.
  win.webContents.on("will-navigate", (e, url) => {
    const workspaceId = parseWorkspaceSentinel(url, origins.app);
    if (workspaceId === null || sentinelHandler === null) return;
    e.preventDefault(); // a signal, not a destination
    sentinelHandler(workspaceId, origins.app);
  });
  win.once("ready-to-show", () => win.show());
  void win.loadURL(appUrl);
  win.on("closed", () => {
    if (workspaceWindow === win) workspaceWindow = null;
  });
  workspaceWindow = win;
  return win;
}

/**
 * Create-or-reuse the locked-down workspace window and load a specific URL into
 * it (onboarding sign-in / device-approval pages). The URL must be within the
 * allow-listed origins — callers pass app-origin URLs only.
 */
export function loadInWorkspaceWindow(url: string, origins: TrustedOrigins): BrowserWindow {
  const win = openWorkspaceWindow(url, origins);
  if (win.webContents.getURL() && win.webContents.getURL() !== url) void win.loadURL(url);
  return win;
}

/**
 * Wait for the workspace window to attempt a navigation the caller recognises, and
 * resolve with whatever that navigation carried. This is how a WEB step returns a
 * result to the shell without the shell exposing any callable surface to remote
 * content (no preload, no IPC — see security.ts).
 *
 * The recognised navigation is CANCELLED rather than followed: the sentinel is a
 * signal, not a destination, so the window stays on the step it was showing while
 * the shell takes over. (The app still serves the sentinel route, so a plain
 * browser — with no shell listening — lands somewhere sane instead of a 404.)
 *
 * `will-navigate` is the right hook because the web step performs a FULL document
 * navigation. A client-side Vue-router push would not fire it — which is exactly
 * why the web side must not use `navigateTo` for the hand-off.
 *
 * Resolves null if the signal aborts or the window closes; rejects on timeout, so
 * a step that never completes surfaces as a recoverable error rather than hanging
 * onboarding forever (mirrors `waitForSession`).
 */
export function awaitNavigationSignal<T>(
  win: BrowserWindow,
  recognise: (url: string) => T | null,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T | null> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise<T | null>((resolve, reject) => {
    const wc = win.webContents;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      wc.off("will-navigate", onNavigate);
      win.off("closed", onClosed);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onNavigate = (e: Electron.Event, url: string): void => {
      const value = recognise(url);
      if (value === null) return; // ordinary navigation — keep waiting
      e.preventDefault(); // a signal, not a destination
      finish(() => resolve(value));
    };
    const onClosed = (): void => finish(() => resolve(null));
    const onAbort = (): void => finish(() => resolve(null));
    // A non-finite timeout means "wait as long as the window is open" — and must
    // not reach setTimeout, which coerces Infinity to ~1ms and fires at once.
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(
          () => finish(() => reject(new Error("timed out waiting for the step to finish"))),
          timeoutMs,
        )
      : null;

    if (opts.signal?.aborted) {
      finish(() => resolve(null));
      return;
    }
    wc.on("will-navigate", onNavigate);
    win.once("closed", onClosed);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}