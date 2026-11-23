import type { Share } from "db";
import { createError, getCookie, getRouterParam, type H3Event } from "h3";
import { shareLimitState } from "./share-usage";
import { resolveShare, shareCookieName, verifyShareUnlock } from "./shares";

// Helpers for the UNAUTHENTICATED public-share routes. They never call
// authenticate(); access is granted solely by the unguessable token (plus the
// optional password gate). Every read re-resolves the share so a revoked link
// dies immediately even if an unlock cookie is still held.

/** Resolve the route's `[token]` to a live share, or 404. */
export async function requirePublicShare(event: H3Event): Promise<{ token: string; share: Share }> {
  const token = getRouterParam(event, "token") ?? "";
  if (!token) throw createError({ statusCode: 404, statusMessage: "Not found" });
  const share = await resolveShare(token);
  if (!share) throw createError({ statusCode: 404, statusMessage: "Not found" });

  // Usage ceiling. 402 rather than 404: the link is real and its owner can
  // restore it, and the app renders a neutral "temporarily unavailable" page
  // from this code. The person seeing it is the owner's CLIENT, so nothing here
  // names the owner, their plan, or what they failed to pay for.
  //
  // This pauses PUBLIC serving only. Authenticated workspace access is
  // untouched: an abuse ceiling must never become a data-access block.
  const limits = await shareLimitState(share.workspaceId);
  if (limits.paused) {
    throw createError({
      statusCode: 402,
      statusMessage: "Temporarily unavailable",
      data: { error: "share_paused" },
    });
  }

  return { token, share };
}

/** Enforce the password gate: an open share passes; a password share requires a
 * valid token-bound unlock cookie (401 otherwise). */
export function assertUnlocked(event: H3Event, token: string, share: Share): void {
  if (!share.passwordHash) return;
  const cookie = getCookie(event, shareCookieName(token));
  if (!verifyShareUnlock(token, cookie)) {
    throw createError({ statusCode: 401, statusMessage: "Password required" });
  }
}