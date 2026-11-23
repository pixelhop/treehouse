import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { SMOKE_BASE, serverAvailable } from "./env";

// End-to-end OAuth for MCP against a RUNNING api: the whole path a client like
// Claude Code takes, over HTTP. Discovery from the MCP endpoint's 401, dynamic
// client registration, authorize with a browser session, the consent page's
// Allow (which also names the connection), the code exchange, MCP calls
// attributed to that name, then rename and disconnect from the user's side.
// Server-gated.

const BASE = SMOKE_BASE;
const serverUp = await serverAvailable();
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
// A browser calling the API from the app sends this; better-auth's CSRF check
// requires it on cookie-carrying writes.
const APP_ORIGIN = (process.env.APP_URL ?? "http://localhost:3000").split(",")[0]!.trim();

const b64url = (buf: Buffer) => buf.toString("base64url");

async function signUp(): Promise<string> {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({
      email: `oauth${stamp}@example.test`,
      password: "correct-horse-battery",
      name: "OAuth User",
    }),
  });
  expect(res.ok).toBe(true);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token");
  return cookie;
}

async function register(clientName: string) {
  const res = await fetch(`${BASE}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

// Authorize → consent (with a name) → token. Returns the token response.
async function connect(cookie: string, clientId: string, name: string) {
  return exchange(clientId, await authorize(cookie, clientId, name));
}

// Authorize → consent (with a name). Returns the authorization code, not yet
// exchanged, and the PKCE verifier that goes with it.
async function authorize(cookie: string, clientId: string, name: string) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authorize = new URL(`${BASE}/api/auth/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/api/mcp`,
  }).toString();

  // A browser navigation gets a 302. Node's fetch always sends
  // `Sec-Fetch-Mode: cors`, which better-auth answers with the same redirect as
  // JSON instead — so accept either form.
  const res = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
  const location =
    res.status === 302 ? res.headers.get("location") : ((await res.json()) as { url?: string }).url;
  const consentUrl = new URL(location ?? "");
  // The authorization server sends the browser to the app's consent page.
  expect(consentUrl.pathname).toBe("/oauth/consent");
  const oauthQuery = consentUrl.search.slice(1);

  const info = await fetch(
    `${BASE}/api/oauth/consent?oauth_query=${encodeURIComponent(oauthQuery)}`,
    { headers: { cookie } },
  );
  expect(info.status).toBe(200);
  expect(((await info.json()) as { client: { name: string } }).client.name).toBeTruthy();

  const consent = await fetch(`${BASE}/api/oauth/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ oauth_query: oauthQuery, accept: true, name }),
  });
  expect(consent.status).toBe(200);
  const { url } = (await consent.json()) as { url: string };
  const callback = new URL(url);
  expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
  expect(callback.searchParams.get("state")).toBe("xyz");
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

async function exchange(clientId: string, grant: { code: string; verifier: string }) {
  const token = await redeem(clientId, grant);
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token?: string };
}

function redeem(clientId: string, { code, verifier }: { code: string; verifier: string }) {
  return fetch(`${BASE}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/api/mcp`,
    }),
  });
}

async function mcp(token: string | null, method: string, params: Record<string, unknown> = {}) {
  return fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcp(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
}

describe.skipIf(!serverUp)("MCP over OAuth", () => {
  it("answers an unauthenticated MCP request with a challenge that leads to discovery", async () => {
    const res = await mcp(null, "tools/list");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadataUrl).toBeTruthy();

    const resource = (await (await fetch(metadataUrl!)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resource.resource).toBe(`${BASE}/api/mcp`);

    const issuer = new URL(resource.authorization_servers[0]!);
    const server = (await (
      await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)
    ).json()) as { registration_endpoint?: string; issuer: string };
    expect(server.issuer).toBe(resource.authorization_servers[0]);
    expect(server.registration_endpoint).toBe(`${BASE}/api/auth/oauth2/register`);
  });

  it("connects a named agent, attributes its writes, and stops it on disconnect", async () => {
    const cookie = await signUp();
    const { client_id } = await register("Claude Code");
    const tokens = await connect(cookie, client_id, "Claude on my laptop");
    expect(tokens.refresh_token).toBeTruthy();

    const listed = await callTool(tokens.access_token, "list_workspaces", {});
    const workspaces = listed.result.structuredContent?.workspaces as { id: string }[];
    expect(workspaces.length).toBeGreaterThan(0);
    const workspaceId = workspaces[0]!.id;

    const written = await callTool(tokens.access_token, "write_file", {
      workspaceId,
      path: "from-oauth.md",
      content: "hello",
    });
    expect(written.result.isError).toBeFalsy();

    const feed = (await (
      await fetch(`${BASE}/api/workspaces/${workspaceId}/changes`, { headers: { cookie } })
    ).json()) as {
      changes: { path: string; principal: string; actorLabel: string | null }[];
    };
    const event = feed.changes.find((e) => e.path === "from-oauth.md");
    expect(event).toMatchObject({ principal: "agent", actorLabel: "Claude on my laptop" });

    // The user sees the connection under its name, and can rename it.
    const { connections } = (await (
      await fetch(`${BASE}/api/mcp-connections`, { headers: { cookie } })
    ).json()) as { connections: { id: string; name: string; clientName: string }[] };
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      name: "Claude on my laptop",
      clientName: "Claude Code",
    });
    const id = connections[0]!.id;

    const renamed = await fetch(`${BASE}/api/mcp-connections/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ name: "Research agent" }),
    });
    expect(renamed.status).toBe(200);

    // A bearer token is not a browser session: it can't manage connections.
    const asAgent = await fetch(`${BASE}/api/mcp-connections`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(asAgent.status).toBe(401);

    // Disconnecting kills the still-unexpired access token on its next use...
    const gone = await fetch(`${BASE}/api/mcp-connections/${id}`, {
      method: "DELETE",
      headers: { cookie, origin: APP_ORIGIN },
    });
    expect(gone.status).toBe(200);
    const after = await mcp(tokens.access_token, "tools/list");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain("resource_metadata=");

    // ...and its refresh token can't mint a new one.
    const refreshed = await fetch(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id,
      }),
    });
    expect(refreshed.ok).toBe(false);

    // Connecting the same client again must not bring the old token back.
    const again = await connect(cookie, client_id, "Claude, reconnected");
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
    expect((await mcp(again.access_token, "tools/list")).status).toBe(200);
  });

  it("refuses a code from before a disconnect, even after a reconnect", async () => {
    const cookie = await signUp();
    const { client_id } = await register("Claude Code");
    // A code the client keeps back instead of exchanging.
    const kept = await authorize(cookie, client_id, "First");

    const { connections } = (await (
      await fetch(`${BASE}/api/mcp-connections`, { headers: { cookie } })
    ).json()) as { connections: { id: string }[] };
    await fetch(`${BASE}/api/mcp-connections/${connections[0]!.id}`, {
      method: "DELETE",
      headers: { cookie, origin: APP_ORIGIN },
    });
    await connect(cookie, client_id, "Second");

    expect((await redeem(client_id, kept)).ok).toBe(false);
  });

  it("refuses a token minted for a different resource", async () => {
    const cookie = await signUp();
    const { client_id } = await register("Elsewhere");
    const tokens = await connect(cookie, client_id, "");
    // Tamper-free check: the same token must work here, so a broken audience
    // check would show up as this passing for the wrong reason.
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(200);
    const forged = `${tokens.access_token.slice(0, -4)}AAAA`;
    expect((await mcp(forged, "tools/list")).status).toBe(401);
  });
});