// Which surface is this page running on?
//
// The same Nuxt app is served to a browser and to the desktop shell's window, and
// a few decisions genuinely differ between them — most obviously anything that
// offers to install the desktop app, which is nonsense once you are inside it.
//
// `?app=1` (see ~/utils/connect) does NOT answer this. That marker is put on a
// specific URL the shell loads for one step; it is gone the moment the user
// navigates anywhere else, so any page reached normally inside the shell — the
// workspace UI, and anything it navigates to — has no marker at all. That gap is
// exactly how "Download the Mac app" ended up being shown inside the Mac app.
//
// The user agent is the thing that survives navigation. Electron's default UA
// carries an `Electron/<version>` token, which is what this keys on.

// `isDesktopShellUserAgent` itself lives in `shared`, because the API asks the
// same question (it keeps the shell's navigations off the byte Worker).
import { isDesktopShellUserAgent } from "shared";

/** Whether this page is running inside the Treehouse desktop app. Client-only —
 * returns false during SSR, where there is no navigator and the answer would be
 * a guess. */
export function isDesktopShell(): boolean {
  if (typeof navigator === "undefined") return false;
  return isDesktopShellUserAgent(navigator.userAgent);
}
/**
 * `navigator.userAgentData`, typed once.
 *
 * Chromium-only and still not in lib.dom, so every reader was writing its own
 * inline `navigator as Navigator & { userAgentData?: … }` cast — three in one file,
 * each declaring a different subset of the shape. That is how the casts drift out
 * of step with each other and with reality. One place to correct if the API
 * changes, or to delete once the DOM types catch up.
 */
export interface UserAgentData {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
  }>;
}

/** Returns undefined outside Chromium (and during SSR, where there is no navigator). */
export function userAgentData(): UserAgentData | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
}