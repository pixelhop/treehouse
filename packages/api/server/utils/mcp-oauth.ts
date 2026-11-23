import { createResourceServerChallenge, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { requireMcpAuth } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { usePrismaClient } from "db";
import { createError } from "h3";
import { auth, MCP_RESOURCE, MCP_SCOPES } from "./auth";
import { CONSENT_CLAIM } from "./connection-claim";
import type { RequestPrincipal } from "./workspace";

// OAuth connections for MCP clients.
//
// A "connection" is one OAuth client's consent from one user: the
// `oauthConsent` row better-auth writes when the user clicks Allow. Clients
// register themselves dynamically, so each install of Claude Code, Cursor, etc.
// is its own client and its own connection. The consent page is where the user
// names it, and that name is the agent's label on the change feed — the same
// role an API key's name plays.
//
// The consent row is also what keeps a connection alive. Access tokens are JWTs
// verified against the signing keys, so on their own they stay valid until they
// expire (an hour). Every MCP request therefore also requires the consent the
// token was issued under to still exist, which makes Disconnect immediate
// rather than "within the hour", and keeps it so across a reconnect.

const FALLBACK_LABEL = "MCP client";

/** The name to show for a connection: the user's own, else the client's. */
export function connectionLabel(c: {
  name: string | null;
  client: { name: string | null };
}): string {
  return c.name?.trim() || c.client.name?.trim() || FALLBACK_LABEL;
}

// The 401 a client gets when its token no longer maps to a live connection. It
// carries the same RFC 9728 challenge as a missing token, so the client starts
// a fresh authorization instead of giving up.
function reauthorize(): Response {
  const challenge = createResourceServerChallenge(
    new APIError("UNAUTHORIZED", { message: "connection revoked" }),
    MCP_RESOURCE,
    { challengeScopes: MCP_SCOPES },
  );
  const headers = new Headers(challenge?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "connection revoked" },
      id: null,
    }),
    { status: 401, headers },
  );
}

type TokenClaims = { sub?: string; azp?: unknown; [CONSENT_CLAIM]?: unknown };

// The live consent a token acts under, or null when it names no user (a
// client-credentials token, which this provider never grants for MCP), its
// client is disabled, or it was issued under an earlier consent (see
// connection-claim.ts).
async function consentForToken(claims: TokenClaims) {
  const clientId = typeof claims.azp === "string" ? claims.azp : undefined;
  if (!claims.sub || !clientId) return null;
  const consent = await usePrismaClient().oauthConsent.findFirst({
    where: { clientId, userId: claims.sub, client: { disabled: { not: true } } },
    select: { id: true, name: true, client: { select: { name: true } } },
  });
  return consent && claims[CONSENT_CLAIM] === consent.id ? consent : null;
}

/**
 * Resolve a verified access token to the principal it acts as, or null when
 * its connection has been disconnected.
 *
 * `keyId` is set for OAuth just as for an API key. Routes use its presence to
 * mean "not a logged-in browser session" and refuse the sensitive actions
 * (public links, script-running links) on that basis. It is the consent's id,
 * not the client's: one registered client can be connected by several people
 * (a hosted app may register once for all its users), and activity groups an
 * agent's changes by this id, so a client id would merge their agents' work.
 */
export async function principalForToken(claims: TokenClaims): Promise<RequestPrincipal | null> {
  const consent = await consentForToken(claims);
  if (!consent || !claims.sub) return null;
  return {
    userId: claims.sub,
    principal: "agent",
    keyId: `oauth:${consent.id}`,
    keyName: connectionLabel(consent),
  };
}

/**
 * Wrap an MCP request handler with OAuth: verify the bearer token (signature,
 * issuer, audience = this MCP endpoint, expiry), answer a missing or invalid one
 * with the 401 + `WWW-Authenticate` that starts a client's OAuth flow, and hand
 * the handler the principal the token acts as.
 */
export function withMcpOAuth(
  handler: (request: Request, ctx: RequestPrincipal) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return requireMcpAuth(
    auth,
    async (request, claims) => {
      const ctx = await principalForToken(claims);
      if (!ctx) return reauthorize();
      return handler(request, ctx);
    },
    {
      resource: MCP_RESOURCE,
      challengeScopes: MCP_SCOPES,
    },
  );
}

/**
 * Check the signed query the authorization server put on the consent page's
 * URL, and read the client it is for. The client id is taken from this query,
 * so it must never be trusted unsigned. Throws a 400 when the signature is bad
 * or the request has expired.
 */
export async function verifyConsentQuery(raw: unknown): Promise<{
  oauthQuery: string;
  clientId: string;
}> {
  const oauthQuery = typeof raw === "string" ? raw : "";
  const { secret } = await auth.$context;
  const clientId = new URLSearchParams(oauthQuery).get("client_id");
  if (!clientId || !(await verifyOAuthQueryParams(oauthQuery, secret))) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid or expired authorization request",
    });
  }
  return { oauthQuery, clientId };
}

/**
 * Allow or deny on the user's behalf, through better-auth's own consent
 * endpoint. Called via the handler with a constructed Request rather than
 * `auth.api.oauth2Consent`: on Allow the endpoint re-runs the authorization
 * step, which needs a real Request. Resolves to where the browser goes next —
 * the client's callback, carrying the code or the denial.
 */
export async function submitConsent(
  headers: Headers,
  oauthQuery: string,
  accept: boolean,
): Promise<{ url: string }> {
  const forwarded = new Headers(headers);
  forwarded.set("content-type", "application/json");
  forwarded.set("accept", "application/json");
  forwarded.delete("content-length");
  const response = await auth.handler(
    new Request(`${auth.options.baseURL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: forwarded,
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
    }),
  );
  const result = (await response.json().catch(() => ({}))) as {
    url?: string;
    error_description?: string;
  };
  if (!response.ok || !result.url) {
    throw createError({
      statusCode: response.ok ? 502 : response.status,
      statusMessage: result.error_description ?? "Consent failed",
    });
  }
  return { url: result.url };
}

export interface ConnectionView {
  id: string;
  name: string;
  /** The name the client registered with ("Claude Code"), for context under a custom name. */
  clientName: string | null;
  clientIcon: string | null;
  connectedAt: string;
}

/** The signed-in user's OAuth connections, newest first. */
export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const rows = await usePrismaClient().oauthConsent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      client: { select: { name: true, icon: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: connectionLabel(r),
    clientName: r.client.name,
    clientIcon: r.client.icon,
    connectedAt: r.createdAt.toISOString(),
  }));
}

/** Save the name typed on the consent screen against the consent it created. */
export async function nameConnection(userId: string, clientId: string, name: string) {
  await usePrismaClient().oauthConsent.updateMany({
    where: { clientId, userId },
    data: { name: name || null },
  });
}

export async function renameConnection(userId: string, id: string, name: string): Promise<boolean> {
  const { count } = await usePrismaClient().oauthConsent.updateMany({
    where: { id, userId },
    data: { name: name || null },
  });
  return count > 0;
}

/**
 * Matchers for the user's outstanding authorization codes for one client. The
 * provider keeps each code as a `verification` row whose value is JSON naming
 * its type, user and client (the identifier is the hashed code). Both ids are
 * plain alphanumeric strings, so they appear in that JSON verbatim.
 */
function authorizationCodeMatchers(clientId: string, userId: string) {
  return [
    { value: { contains: '"type":"authorization_code"' } },
    { value: { contains: `"userId":${JSON.stringify(userId)}` } },
    { value: { contains: `"client_id":${JSON.stringify(clientId)}` } },
  ];
}

/**
 * Disconnect: drop the consent, every token issued under it, and any
 * authorization code not yet exchanged. Access tokens are JWTs and can't be
 * recalled, but the MCP route refuses any token whose consent is gone, so they
 * stop working immediately too. The codes matter because the token endpoint
 * doesn't check consent: a code kept back from before the disconnect could
 * otherwise be exchanged after a reconnect and come away stamped with the new
 * consent. No new code can be minted until the user approves again. The client
 * is left registered; connecting it again goes back through consent.
 */
export async function disconnectConnection(userId: string, id: string): Promise<boolean> {
  const db = usePrismaClient();
  return db.$transaction(async (tx) => {
    const consent = await tx.oauthConsent.findFirst({
      where: { id, userId },
      select: { clientId: true },
    });
    if (!consent) return false;
    const owned = { clientId: consent.clientId, userId };
    await tx.oauthAccessToken.deleteMany({ where: owned });
    await tx.oauthRefreshToken.deleteMany({ where: owned });
    await tx.oauthConsent.deleteMany({ where: owned });
    await tx.verification.deleteMany({
      where: { AND: authorizationCodeMatchers(consent.clientId, userId) },
    });
    return true;
  });
}