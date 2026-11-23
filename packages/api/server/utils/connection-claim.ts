import { usePrismaClient } from "db";

// Binds each OAuth access token to the consent it was issued under.
//
// Access tokens are JWTs nobody can recall. Disconnect deletes the consent, and
// the MCP route refuses a token without one — but if the same user then
// connects the same client again, a consent exists once more, and a token from
// before the disconnect (a leaked one, say) would pass. So the token carries
// the consent's id, and the route requires it to match the consent that exists
// now. A reconnect creates a new consent row; re-approving without
// disconnecting updates the old one and keeps its id.
//
// Lives apart from mcp-oauth.ts because the auth config uses it, and that
// module imports the auth instance.

/** The access-token claim holding the consent id. Namespaced, per RFC 7519 §4.2. */
export const CONSENT_CLAIM = "https://trytree.house/consent";

/**
 * The claim to add to an access token for this user and client — empty when
 * there is no user (a client-credentials token) or no consent yet, which leaves
 * the token unusable at the MCP route.
 */
export async function consentClaim(
  userId: string | undefined,
  clientId: string,
): Promise<Record<string, string>> {
  if (!userId) return {};
  const consent = await usePrismaClient().oauthConsent.findFirst({
    where: { clientId, userId },
    select: { id: true },
  });
  return consent ? { [CONSENT_CLAIM]: consent.id } : {};
}