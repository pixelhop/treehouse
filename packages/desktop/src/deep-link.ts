import { type DeepLink, parseDeepLink } from "./contract";
import type { PersistedOnboarding } from "./onboarding/state";

// Pure routing for treehouse:// deep links (F1 accelerator; workspace-#2 gap).
// The router decides WHAT to do; main.ts performs the effect. Garbage / oversized
// / wrong-scheme input yields `ignore` (never thrown, never navigated to). A
// well-formed link naming an UNKNOWN origin still routes to onboarding, where U7's
// TOFU confirmation gates it before anything loads — the router never trusts the
// origin itself.
//
// MID-ONBOARDING RULE (documented, pinned by tests): a deep link arriving while a
// flow is in progress SUPERSEDES it. The onboarding machine is resumable and every
// step is idempotent, so restarting for the new (or same) target is safe and
// matches the user's intent of clicking a fresh link. `supersede` is surfaced so
// main can abandon the prior flow. `focus-workspace` never supersedes: opening an
// already-syncing workspace's window is not a request to redo setup.
//
// WEB-FIRST ENTRY (R7): `treehouse://open` is the browser's "open in Treehouse"
// button, so it routinely names a workspace that has no folder on this machine yet —
// the user just created it on the web. Focusing a window would show them nothing,
// so an unlinked target enters onboarding instead of dead-ending.

export type RouteAction =
  | { type: "ignore" }
  | { type: "focus-workspace"; appOrigin: string; workspaceId: string }
  | { type: "onboard"; entry: PersistedOnboarding; supersede: boolean };

export interface RouteContext {
  /** Workspace ids already linked on this machine. */
  linkedWorkspaceIds: string[];
  /** Whether an onboarding flow is currently in progress. */
  onboarding: boolean;
}

/** Workspace ids are opaque, server-issued strings. A deep link is untrusted input
 * (any web page can fire one), so cap what the router will carry into a flow — the
 * same bound `parseWorkspaceSentinel` puts on the other untrusted id channel. */
const MAX_WORKSPACE_ID_LENGTH = 128;

/** Could this plausibly be a workspace id? Non-empty, bounded, and free of spaces
 * and control characters (a value carrying a newline is a smuggling attempt, not an
 * id). Deliberately shape-only: membership is settled later by a real API lookup. */
function isUsableWorkspaceId(id: string | undefined): id is string {
  if (!id || id.length > MAX_WORKSPACE_ID_LENGTH) return false;
  for (const ch of id) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Decide what a (raw) deep link should do. Accepts the raw string so validation
 * and routing are one testable unit. */
export function routeDeepLink(raw: string, ctx: RouteContext): RouteAction {
  return routeParsed(parseDeepLink(raw), ctx);
}

/** Route an already-parsed link (or null). */
export function routeParsed(link: DeepLink | null, ctx: RouteContext): RouteAction {
  if (!link) return { type: "ignore" };

  // An `open` link IS its workspace id. With nothing usable there, there is no
  // window to focus and no workspace to onboard, so drop it rather than starting a
  // flow that would fail at its first API call. (An `invite` carries a token and
  // stays valid without one — its id is only a preselection hint.)
  if (link.kind === "open" && !isUsableWorkspaceId(link.workspaceId)) return { type: "ignore" };

  // The SAME shape check applies to an invite's id. An invite stays valid without
  // one — the id is only a preselection hint — but an unusable hint must be dropped
  // rather than carried: it goes into persisted onboarding state and from there into
  // an API path, so "only a hint" is not a reason to skip validating it. Dropping it
  // degrades to "invite with no preselection", which the flow already handles.
  const workspaceId = isUsableWorkspaceId(link.workspaceId) ? link.workspaceId : undefined;

  if (workspaceId && ctx.linkedWorkspaceIds.includes(workspaceId)) {
    // Already syncing this workspace — just focus its window.
    return { type: "focus-workspace", appOrigin: link.appOrigin, workspaceId };
  }

  // Not linked here yet → ONBOARDING, carrying the workspace id (TOFU first for an
  // unknown origin — this router never trusts the origin itself). Carrying the id
  // and NOT a name is deliberate: the machine's workspace step resolves the name
  // from the API under a membership check, so the user never re-picks the workspace
  // they just picked on the web, and the folder is named after it rather than
  // falling back to the literal "Workspace".
  const entry: PersistedOnboarding = {
    appOrigin: link.appOrigin,
    workspaceId,
    inviteToken: link.kind === "invite" ? link.inviteToken : undefined,
  };
  return { type: "onboard", entry, supersede: ctx.onboarding };
}