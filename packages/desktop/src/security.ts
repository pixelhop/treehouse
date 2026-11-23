import type { BrowserWindowConstructorOptions } from "electron";
import { APP_ORIGIN_ARG } from "./bridge";
import { normalizeOrigin, type TrustedOrigins } from "./origins";

// The remote-content security posture (KTD). The workspace window renders a
// remote web app, so the shell exposes ZERO privileged surface to it: no preload
// bridge, a sandboxed renderer, a locked-down navigation allow-list, and external
// links validated before they ever reach the system browser. The policy functions
// here are pure so they can be exhaustively unit-tested; `windows.ts` wires them
// onto real Electron objects.

// A named `persist:` partition so the better-auth session cookie survives app
// restarts (AE5: onboarding's sign-in carries into every later window) while
// staying isolated from any other Electron storage — and clearable on sign-out.
export const WORKSPACE_PARTITION = "persist:treehouse-workspace";

/**
 * The token the shell appends to its user agent so the web app can tell it is
 * running inside Treehouse rather than a browser, and adapt — no "download the
 * Mac app" inside the Mac app, no terminal-flavoured code check with no terminal.
 *
 * The user agent is the mechanism because it survives navigation and needs no
 * preload. A preload with `contextBridge` is the usual Electron answer, and it is
 * deliberately NOT used here: this window renders remote content with no preload
 * at all, which is load-bearing (see security.ts's window options and
 * docs/solutions/architecture-patterns/electron-remote-content-shell.md). Adding
 * one to answer "which surface am I on?" would trade a security property for a
 * cosmetic one.
 *
 * Our OWN token rather than Electron's default `Electron/<version>`: that default
 * is Electron's to change, and every Electron app carries it, so it identifies the
 * runtime rather than this product.
 *
 * This is a HINT, not a credential. Any client can send any user agent, so it may
 * only drive presentation — never authorisation. The one security-relevant use
 * (skipping the device-code eyeball check) is safe precisely because it removes a
 * check for a flow the shell drives end to end; forging it in a browser gets you
 * the shorter screen, not a grant you could not otherwise obtain.
 */
export const SHELL_UA_TOKEN = "TreehouseDesktop";

/** The app's own version, baked at bundle time. NOT `app.getVersion()`: that
 * returns ELECTRON's version in an unpackaged run, so a dev shell would announce
 * itself as TreehouseDesktop/33.x in every request it makes. */
export const SHELL_VERSION = process.env.TREEHOUSE_APP_VERSION || "0.0.0";

/** Append the shell's token to a base user agent, once. */
export function shellUserAgent(baseUserAgent: string, version: string): string {
  const token = `${SHELL_UA_TOKEN}/${version}`;
  return baseUserAgent.includes(`${SHELL_UA_TOKEN}/`) ? baseUserAgent : `${baseUserAgent} ${token}`;
}

/**
 * Navigation allow-list: the workspace window may only navigate within the app
 * origin or the API origin. Anything else (an ad iframe escaping, a phishing
 * redirect, a `javascript:`/`file:` URL) is refused — `windows.ts` calls
 * `preventDefault()` when this returns false.
 */
export function isAllowedNavigation(target: string, origins: TrustedOrigins): boolean {
  const o = normalizeOrigin(target);
  if (o === null) return false;
  return o === normalizeOrigin(origins.app) || o === normalizeOrigin(origins.api);
}

/**
 * Video players an iframe may load, as origin + path prefix. The "What's new"
 * release notes (Hopdate) turn a YouTube, Vimeo or Loom link into one of these
 * embeds, and the frame allow-list below would otherwise leave a blank box where
 * the video should be. Player paths only: a frame can show a video, not the
 * site's sign-in page or anything else on it.
 */
const EMBEDDED_PLAYERS: ReadonlyArray<{ origin: string; path: string }> = [
  { origin: "https://www.youtube-nocookie.com", path: "/embed/" },
  { origin: "https://www.youtube.com", path: "/embed/" },
  { origin: "https://player.vimeo.com", path: "/video/" },
  { origin: "https://www.loom.com", path: "/embed/" },
];

function isEmbeddedPlayer(target: string): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  return EMBEDDED_PLAYERS.some((p) => u.origin === p.origin && u.pathname.startsWith(p.path));
}

/**
 * The allow-list for a navigation in ANY frame. The main frame gets exactly
 * `isAllowedNavigation`; a subframe may also load an `EMBEDDED_PLAYERS` video.
 */
export function isAllowedFrameNavigation(
  target: string,
  origins: TrustedOrigins,
  isMainFrame: boolean,
): boolean {
  if (isAllowedNavigation(target, origins)) return true;
  return !isMainFrame && isEmbeddedPlayer(target);
}

/**
 * The only permission the remote page is ever granted. `navigator.clipboard
 * .writeText` asks for it, so denying everything left every copy button in the
 * app failing silently inside the shell while working in a browser.
 *
 * Write only, and sanitized: the page can put text on the clipboard — no worse
 * than a selection the user copies themselves — but never read it back.
 * `clipboard-read` stays denied with everything else.
 */
export const GRANTED_PERMISSION = "clipboard-sanitized-write";

/**
 * Permission policy for the workspace session: grant `GRANTED_PERMISSION` to the
 * app origin and deny everything else, to everyone. The API origin gets nothing —
 * it serves no page that copies.
 */
export function isPermissionGranted(
  permission: string,
  requestingUrl: string,
  origins: TrustedOrigins,
): boolean {
  if (permission !== GRANTED_PERMISSION) return false;
  const o = normalizeOrigin(requestingUrl);
  return o !== null && o === normalizeOrigin(origins.app);
}

/**
 * `openExternal` validator: only real `https:` URLs are ever handed to the
 * system browser. Rejects non-https (`http:`, `file:`), custom schemes
 * (`treehouse:`, `javascript:`) and unparseable input — so a hostile remote page
 * can't use `window.open` to launch an arbitrary URI handler.
 */
export function isSafeExternalUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:";
}

/**
 * BrowserWindow options for the locked-down workspace window: sandboxed,
 * context-isolated, no Node integration, NO preload script at all, and pinned to
 * the persistent named partition. Pure so the posture is snapshot-testable.
 */
export function workspaceWindowOptions(
  partition: string = WORKSPACE_PARTITION,
  preloadPath?: string,
  appOrigin?: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Treehouse",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // A preload IS now attached, reversing the original no-preload stance. The
      // workspace UI could not answer "where does this sync?" without one — the
      // shell could only push state at load time, which is useless for a window
      // the user navigates around in.
      //
      // What keeps it affordable is the shape of the bridge, not its absence:
      // read-and-request only (see bridge.ts), every mutation performed in the
      // main process behind a native dialog, basenames instead of paths, and the
      // surface withheld from any origin but the app's. Sandbox and context
      // isolation stay on, so contextBridge is the only crossing.
      //
      // The cost is real and worth stating: an XSS on the app origin can now make
      // a dialog appear. It still cannot move, unlink or read a path.
      ...(preloadPath ? { preload: preloadPath } : {}),
      // Tell the preload which origin is the app's, per window — see APP_ORIGIN_ARG.
      ...(appOrigin ? { additionalArguments: [`${APP_ORIGIN_ARG}${appOrigin}`] } : {}),
      partition,
    },
  };
}