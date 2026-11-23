// The web half of the desktop app's workspace step.
//
// The shell loads `/connect/workspace?app=1` in its authed window and then WATCHES
// where that page navigates — it never exposes a callable surface to the page (no
// preload, no IPC). So the page returns its answer by navigating to a sentinel
// path carrying the chosen workspace id.
//
// Two constraints that are easy to break and expensive to debug:
//
//  1. The hand-off must be a FULL document navigation (`location.assign`), not a
//     Vue-router push. Electron's `will-navigate` — the hook the shell listens on —
//     does not fire for client-side history changes, so a router push would leave
//     the shell waiting until it times out.
//
//  2. This contract is mirrored in `packages/desktop/src/contract.ts`. The two must
//     agree; the desktop side is the one with the security-relevant parsing.
//
// Keeping these as pure functions lets both be unit tested without mounting a
// component or running Electron.

/** Where the shell's workspace step lives. */
export const WORKSPACE_STEP_PATH = "/connect/workspace";

/** The sentinel the shell watches for. Also a real route, so a plain browser that
 * reaches it (nobody listening) lands somewhere sane instead of a 404. */
export const SENTINEL_PATH = "/connect/chosen";

/** Build the sentinel URL that hands `workspaceId` back to the shell. */
export function sentinelUrl(origin: string, workspaceId: string): string {
  const url = new URL(SENTINEL_PATH, origin);
  url.searchParams.set("workspace", workspaceId);
  return url.toString();
}

/** The `?app=1` marker is the SAME convention link.vue already uses, so this is
 * re-exported rather than reimplemented — two copies would drift the moment the
 * marker changed. */
export { isLinkAppMode as isAppMode } from "./desktopApp";

/**
 * Read one value out of a URL fragment, decoded once.
 *
 * Deliberately not URLSearchParams: it decodes on read, so a value containing an
 * encoded separator comes back already-decoded and any further splitting sees
 * real separators. Take it raw, decode once.
 */
export function hashParam(hash: string, key: string): string | null {
  const raw = hash.replace(/^#/, "");
  const value = new RegExp(`(?:^|&)${key}=([^&]*)`).exec(raw)?.[1];
  // `undefined` (no match) is absent; `""` (`#key=`) is PRESENT AND EMPTY. `!value`
  // conflated the two, and the contract reserves null for missing-or-invalid — so a
  // caller could not tell "the shell sent no linked workspaces" from "the shell sent
  // an empty list", which are different states.
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null; // bad percent-encoding — treat as absent
  }
}

/** A workspace that already has a folder on the machine running the shell. */
export interface LinkedWorkspace {
  workspaceId: string;
  folderName: string;
}

/**
 * Read the already-linked workspaces the shell passed in the URL fragment.
 *
 * The fragment — not the query string — because a fragment never reaches the
 * server, keeping the user's local folder names out of access logs. Mirrors
 * `buildWorkspaceStepUrl` in packages/desktop/src/contract.ts.
 *
 * Untrusted-ish input (anyone can type a fragment), but it only ever DISABLES
 * rows, so the worst a forged value does is stop someone picking a workspace —
 * annoying, never unsafe. Malformed entries are skipped rather than throwing.
 */
export function parseLinkedFromHash(hash: string): LinkedWorkspace[] {
  const raw = hash.replace(/^#/, "");
  // Deliberately NOT URLSearchParams: it decodes the value, so a folder name
  // containing an encoded separator would come back with real `,` and `:` in it
  // and then split into garbage entries. Take the value raw and decode once, per
  // field, below.
  const value = /(?:^|&)linked=([^&]*)/.exec(raw)?.[1];
  if (!value) return [];
  return value
    .split(",")
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx <= 0) return null;
      try {
        return {
          workspaceId: decodeURIComponent(pair.slice(0, idx)),
          folderName: decodeURIComponent(pair.slice(idx + 1)),
        };
      } catch {
        return null; // bad percent-encoding — skip this entry, keep the rest
      }
    })
    .filter((v): v is LinkedWorkspace => v !== null && v.workspaceId.length > 0);
}

/** Matches MAX_NAME in packages/api/server/routes/api/workspaces/index.post.ts.
 * Capping lower here would silently truncate a name the server would have
 * accepted; capping higher would POST one it rejects. */
const MAX_WORKSPACE_NAME = 100;

/** A workspace name the API will accept: trimmed, non-empty, length-capped.
 * Returns null when there's nothing usable, so the caller can keep the button
 * disabled rather than POSTing a name the server will reject. */
export function normalizeWorkspaceName(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_WORKSPACE_NAME);
}