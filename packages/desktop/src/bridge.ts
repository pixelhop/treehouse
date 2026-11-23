// The contract between the workspace window's preload and the main process.
//
// This window renders a REMOTE web app, so a bridge here is the one place the
// shell hands the page any capability at all. Two rules keep that affordable:
//
//  1. **Read and request, never perform.** The page can ask what is synced, and
//     ask for an action. Every action is then carried out by main-process code
//     behind a native dialog the user has to answer. The bridge cannot move,
//     unlink, or write anything by itself, so compromising the page buys you the
//     ability to open a dialog — not to touch the filesystem.
//  2. **No paths outward.** `folderName` is a basename. The full path stays in
//     the shell; the page never learns where the user's home directory is or what
//     it is called.
//
// Pure module (no electron import) so the channel names and the validation are
// unit-testable, and so the preload and the main process cannot drift apart on
// what a message looks like.

/** Every channel the bridge exposes. Anything not here is not reachable. */
export const BRIDGE_CHANNELS = {
  /** Read: what does this Mac sync, and where? */
  listFolders: "treehouse:list-folders",
  /** Request: connect a folder for a workspace that has none. */
  connectFolder: "treehouse:connect-folder",
  /** Request: move an existing folder somewhere else. */
  changeFolder: "treehouse:change-folder",
  /** Request: reveal the folder in Finder. */
  revealFolder: "treehouse:reveal-folder",
} as const;

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[keyof typeof BRIDGE_CHANNELS];

/** What the page learns about one synced folder. Basename only — never a path. */
export interface BridgeFolder {
  workspaceId: string;
  /** The folder's display name, not its location. */
  folderName: string;
  /** Whether syncing is currently paused for it. */
  paused: boolean;
}

/** The API surface `contextBridge` exposes on `window.treehouse`. */
export interface TreehouseBridge {
  /** Identifies the shell to the page, and pins the contract version so the web
   * app can degrade rather than guess if it meets an older shell. */
  readonly version: number;
  listFolders(): Promise<BridgeFolder[]>;
  connectFolder(workspaceId: string): Promise<void>;
  changeFolder(workspaceId: string): Promise<void>;
  revealFolder(workspaceId: string): Promise<void>;
}

export const BRIDGE_VERSION = 1;

/**
 * Workspace ids arrive from the PAGE, which is remote content. Bound and shape
 * them before anything in the main process acts on one. Deliberately strict: an
 * id is an opaque server-issued string, so anything with whitespace, control
 * characters or path separators in it is not an id and must not reach code that
 * goes looking for a matching folder.
 */
export function isValidWorkspaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    // \s covers whitespace; the codepoint check covers the rest of C0 plus DEL.
    // Done by codepoint rather than a regex class because a control-character
    // class is both lint-flagged and genuinely hard to read. Array.from, not
    // spread, so an astral character counts as one codepoint.
    !/[\s/\\.]/.test(value) &&
    !Array.from(value).some((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || cp === 0x7f;
    })
  );
}

/** The argv flag the shell uses to tell its preload which origin is the app's.
 * Passed per WINDOW rather than baked at build time: the app origin is not one
 * value. A self-hosted instance has its own, and a dev run has another, so a baked
 * origin would withhold the bridge from everyone except the hosted deployment. */
export const APP_ORIGIN_ARG = "--treehouse-app-origin=";

/** Read the app origin the shell injected, or null if it is absent/malformed.
 * Null means "expose nothing" — a preload that cannot tell which origin it is
 * meant to trust must not guess. */
export function appOriginFromArgv(argv: readonly string[]): string | null {
  const found = argv.find((a) => a.startsWith(APP_ORIGIN_ARG));
  if (!found) return null;
  const value = found.slice(APP_ORIGIN_ARG.length);
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Whether the bridge may be exposed to a page on this origin.
 *
 * A preload attaches to the webContents, not to a URL, so it runs again on every
 * navigation the allow-list permits — including to the API origin. Only the APP
 * origin renders our UI, so only it gets the bridge; an API error page or a JSON
 * response should never carry one.
 */
export function mayExposeBridge(pageOrigin: string, appOrigin: string): boolean {
  try {
    return new URL(pageOrigin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}