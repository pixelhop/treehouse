// The cross-component URL contract. Two shapes cross a trust/process boundary and
// MUST stay in lock-step with the web app (packages/app), which is built in
// parallel (U5). This module is the single source of truth on the shell side.
//
// (1) treehouse:// DEEP LINK — produced by the web invite page (U5), consumed by
//     the shell's deep-link router (U9). Deep links are UNTRUSTED input (any web
//     page can fire one), so the router validates every field and an unknown
//     `origin` goes through TOFU (U7) before anything loads.
//
//        treehouse://invite?token=<inviteToken>&workspace=<workspaceId>&origin=<appOrigin>
//            → onboarding entry for an invited teammate (workspace preselected).
//        treehouse://open?workspace=<workspaceId>&origin=<appOrigin>
//            → focus an already-linked workspace's window (or onboard it if new).
//
// (2) /link APP MODE — the approval page the shell loads in the ALREADY-AUTHED
//     webview during the device grant (U5's link.vue app mode). The `workspace`
//     param preselects the target so the grant is genuinely one click and cannot
//     approve the wrong workspace; `app=1` swaps the terminal-flavored copy.
//
//        <appOrigin>/link?code=<userCode>&workspace=<workspaceId>&app=1

import { DEFAULT_APP_ORIGIN } from "./origins";

/**
 * Build the app-mode approval URL loaded in the authed webview during the grant.
 * `workspaceId` preselects the workspace (omit for the create-workspace path).
 * `keyName` labels the minted key honestly in the key-management UI — link.vue app
 * mode forwards it to the approve call (U4's honest-label requirement).
 */
export function buildApprovalUrl(
  appOrigin: string,
  params: { code: string; workspaceId?: string; keyName?: string; folderName?: string },
): string {
  const url = new URL("/link", appOrigin);
  url.searchParams.set("code", params.code);
  if (params.workspaceId) url.searchParams.set("workspace", params.workspaceId);
  if (params.keyName) url.searchParams.set("name", params.keyName);
  url.searchParams.set("app", "1");
  // The folder rides in the FRAGMENT, like the linked-workspace list: a fragment
  // never reaches the server, so the user's folder name stays out of access logs.
  // Only the basename travels; the full path never leaves the shell.
  //
  // Without this the approval page cannot name the one thing worth confirming.
  // It knows the workspace but not the folder, which is why it ended up asking
  // people to re-confirm a workspace they had just chosen.
  if (params.folderName) url.hash = `folder=${encodeURIComponent(params.folderName)}`;
  return url.toString();
}

// ─────────────────────────── (3) the workspace step ───────────────────────────
//
// The shell needs a workspace choice back out of a WEB page without giving that
// page a way to call into the shell. It gets one by watching where the page
// navigates: the web step finishes by navigating to a sentinel path on the app
// origin, and the shell's existing `will-navigate` hook (windows.ts) reads the
// workspace id off it.
//
//    <appOrigin>/connect/workspace?app=1        ← the step the shell loads
//    <appOrigin>/connect/chosen?workspace=<id>  ← the sentinel it watches for
//
// This is the same observe-don't-call posture already used for sign-in (cookie
// polling) and the device grant (approval polling), and it is why the workspace
// window still runs with NO preload and no IPC channel — see security.ts and
// docs/solutions/architecture-patterns/electron-remote-content-shell.md.
//
// The id read off the sentinel is UNTRUSTED: a page on the app origin could
// navigate anywhere it likes. It is a HINT that the user picked something, not
// proof they may have it. The shell re-resolves the workspace by id through a
// membership-checked API call before using it, exactly as link.vue app mode does.

const SENTINEL_PATH = "/connect/chosen";
const WORKSPACE_STEP_PATH = "/connect/workspace";

/** Workspace ids are opaque server-issued strings; cap the length so a hostile
 * navigation can't push an unbounded value into the flow's context. */
const MAX_WORKSPACE_ID_LENGTH = 128;

/** A workspace already synced to a folder on THIS machine. */
export interface LinkedWorkspace {
  workspaceId: string;
  /** The folder's display name (basename) — never the full path. */
  folderName: string;
}

/**
 * Build the URL of the web workspace step the shell loads in its authed window.
 *
 * Already-linked workspaces ride in the URL FRAGMENT, not the query string. The
 * page needs them so it can mark those rows instead of letting the user pick a
 * workspace that already has a folder here — but a fragment is never sent to the
 * server, so local folder names stay out of access logs, CDN logs and the API's
 * request trace. Only the basename travels; the full path never leaves the shell.
 */
export function buildWorkspaceStepUrl(appOrigin: string, linked: LinkedWorkspace[] = []): string {
  const url = new URL(WORKSPACE_STEP_PATH, appOrigin);
  url.searchParams.set("app", "1");
  if (linked.length > 0) {
    const packed = linked
      .map((l) => `${encodeURIComponent(l.workspaceId)}:${encodeURIComponent(l.folderName)}`)
      .join(",");
    url.hash = `linked=${packed}`;
  }
  return url.toString();
}

const FOLDER_STEP_PATH = "/connect/folder";

/**
 * Build the URL of the page shown BEHIND the native folder picker. The picker is a
 * sheet on the workspace window; without this the window kept showing whatever was
 * there before — on a deep link, a DIFFERENT workspace's page — so the one question
 * on screen ("where should this live?") arrived over the wrong workspace's name.
 *
 * Purely presentational: the page takes no input back. The suggested folder's
 * basename rides in the fragment for the same reason as the linked list above.
 */
export function buildFolderStepUrl(
  appOrigin: string,
  params: { workspaceId: string; folderName?: string; reclaim?: boolean },
): string {
  const url = new URL(FOLDER_STEP_PATH, appOrigin);
  url.searchParams.set("app", "1");
  url.searchParams.set("workspace", params.workspaceId);
  // encodeURIComponent, not URLSearchParams: the page decodes with
  // decodeURIComponent (`hashParam`), which leaves URLSearchParams' "+" for a space.
  const parts: string[] = [];
  if (params.folderName) parts.push(`folder=${encodeURIComponent(params.folderName)}`);
  if (params.reclaim) parts.push("reclaim=1");
  if (parts.length > 0) url.hash = parts.join("&");
  return url.toString();
}

/**
 * Read a workspace id off a sentinel navigation, or null when this navigation
 * isn't one. Returns null for a different path, a different origin (a page can
 * navigate off-origin; that is not a result), or a missing/oversized id — so the
 * caller can treat "not the sentinel" and "malformed sentinel" identically and
 * keep waiting.
 */
export function parseWorkspaceSentinel(target: string, appOrigin: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(target);
    base = new URL(appOrigin);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (url.pathname !== SENTINEL_PATH) return null;
  const id = url.searchParams.get("workspace");
  if (!id || id.length > MAX_WORKSPACE_ID_LENGTH) return null;
  return id;
}

export type DeepLink =
  | { kind: "invite"; appOrigin: string; workspaceId?: string; inviteToken?: string }
  | { kind: "open"; appOrigin: string; workspaceId: string };

// A deep-link URL is hard-capped: anything larger is not a legitimate accelerator
// link and is dropped without parsing (untrusted-input hygiene).
const MAX_DEEP_LINK_LENGTH = 2048;

/** Validate the `origin` param into a safe app origin, or null. Absent → default. */
function safeAppOrigin(raw: string | null): string | null {
  if (raw === null) return DEFAULT_APP_ORIGIN;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const isLocalhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "https:" || (u.protocol === "http:" && isLocalhost)) return u.origin;
  return null;
}

/**
 * Parse a treehouse:// deep link into a validated intent, or null for anything
 * that isn't a well-formed one (wrong scheme, oversized, unknown host, missing
 * required params, hostile `origin`). The result is never fed to `openExternal`
 * or navigation — deep links are UNTRUSTED input; an unknown origin still goes
 * through U7's TOFU downstream.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_DEEP_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "treehouse:") return null;

  const host = url.hostname || url.host;
  const q = url.searchParams;

  if (host === "invite") {
    const appOrigin = safeAppOrigin(q.get("origin"));
    if (!appOrigin) return null;
    return {
      kind: "invite",
      appOrigin,
      workspaceId: q.get("workspace") ?? undefined,
      inviteToken: q.get("token") ?? undefined,
    };
  }
  if (host === "open") {
    const appOrigin = safeAppOrigin(q.get("origin"));
    const workspaceId = q.get("workspace");
    if (!appOrigin || !workspaceId) return null;
    return { kind: "open", appOrigin, workspaceId };
  }
  return null;
}