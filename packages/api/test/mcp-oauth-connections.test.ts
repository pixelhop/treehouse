import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import "./env";

// The connection model behind MCP OAuth, against the database: a connection is
// one client's consent from one user, its name is the agent's label, and
// disconnecting it is what makes an unexpired access token stop working. The
// HTTP flow end to end is covered by mcp-oauth.test.ts (server-gated).

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { CONNECTION_NAME_MAX, parseConnectionName, parseConsentBody } =
  await import("../server/utils/connection-name");
const { disconnectConnection, listConnections, principalForToken, renameConnection } =
  await import("../server/utils/mcp-oauth");
const { CONSENT_CLAIM, consentClaim } = await import("../server/utils/connection-claim");
const db = usePrismaClient();

// The claims of an access token issued now: what the provider stamps on it.
async function tokenFor(userId: string, clientId: string) {
  return { sub: userId, azp: clientId, ...(await consentClaim(userId, clientId)) };
}

async function makeUser() {
  const email = `conn${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;
  const { user } = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "Conn User" },
  });
  return user;
}

async function registerClient(clientName: string) {
  const clientId = `client_${randomUUID()}`;
  const now = new Date();
  await db.oauthClient.create({
    data: { id: randomUUID(), clientId, name: clientName, createdAt: now, updatedAt: now },
  });
  return clientId;
}

// The user's consent to a client: what Allow leaves behind.
async function consent(userId: string, clientId: string, name: string | null) {
  const at = new Date();
  const row = await db.oauthConsent.create({
    data: {
      id: randomUUID(),
      clientId,
      userId,
      scopes: ["openid", "offline_access"],
      name,
      createdAt: at,
      updatedAt: at,
    },
  });
  return row.id;
}

// A registered client and the user's consent to it.
async function connect(userId: string, clientName: string, name: string | null) {
  const clientId = await registerClient(clientName);
  return { clientId, consentId: await consent(userId, clientId, name) };
}

describe("MCP OAuth connections", () => {
  it("resolves a token to an agent labelled with the connection's name", async () => {
    const user = await makeUser();
    const { clientId, consentId } = await connect(user.id, "Claude Code", "Claude on my laptop");

    const ctx = await principalForToken(await tokenFor(user.id, clientId));
    expect(ctx).toEqual({
      userId: user.id,
      principal: "agent",
      keyId: `oauth:${consentId}`,
      keyName: "Claude on my laptop",
    });
  });

  it("falls back to the client's own name when the user gave none", async () => {
    const user = await makeUser();
    const { clientId } = await connect(user.id, "Cursor", null);
    expect((await principalForToken(await tokenFor(user.id, clientId)))?.keyName).toBe("Cursor");
  });

  it("refuses a token whose consent belongs to someone else, or is gone", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { clientId, consentId } = await connect(owner.id, "Claude Code", null);

    expect(await principalForToken(await tokenFor(other.id, clientId))).toBeNull();
    expect(await principalForToken({ sub: owner.id })).toBeNull();

    expect(await disconnectConnection(owner.id, consentId)).toBe(true);
    expect(await principalForToken(await tokenFor(owner.id, clientId))).toBeNull();
  });

  it("keeps a disconnected token dead after the same client reconnects", async () => {
    const user = await makeUser();
    const { clientId, consentId } = await connect(user.id, "Claude Code", null);
    // An hour-long JWT from the first connection, still unexpired.
    const oldToken = await tokenFor(user.id, clientId);
    expect(await principalForToken(oldToken)).not.toBeNull();

    await disconnectConnection(user.id, consentId);
    await consent(user.id, clientId, null);

    expect(await principalForToken(oldToken)).toBeNull();
    // Tokens the reconnected client is issued now still work.
    expect(await principalForToken(await tokenFor(user.id, clientId))).not.toBeNull();
  });

  it("discards the codes a disconnected client hasn't exchanged yet", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const { clientId, consentId } = await connect(user.id, "Claude Code", null);
    const otherClient = await registerClient("Cursor");
    // Stored the way the provider stores an authorization code.
    const code = async (userId: string, client: string) =>
      (
        await db.verification.create({
          data: {
            id: randomUUID(),
            identifier: randomUUID(),
            expiresAt: new Date(Date.now() + 600_000),
            value: JSON.stringify({
              type: "authorization_code",
              query: { client_id: client, redirect_uri: "http://127.0.0.1:1/cb" },
              userId,
            }),
          },
        })
      ).id;
    const mine = await code(user.id, clientId);
    const myOtherClient = await code(user.id, otherClient);
    const theirs = await code(other.id, clientId);

    await disconnectConnection(user.id, consentId);

    const left = await db.verification.findMany({
      where: { id: { in: [mine, myOtherClient, theirs] } },
      select: { id: true },
    });
    expect(left.map((r) => r.id).sort()).toEqual([myOtherClient, theirs].sort());
  });

  it("refuses a token that names no consent, or another user's", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const { clientId } = await connect(user.id, "Claude Code", null);
    const theirs = await connect(other.id, "Claude Code", null);
    expect(await principalForToken({ sub: user.id, azp: clientId })).toBeNull();
    expect(
      await principalForToken({
        sub: user.id,
        azp: clientId,
        [CONSENT_CLAIM]: theirs.consentId,
      }),
    ).toBeNull();
  });

  it("stamps no consent on a token without a user or a consent", async () => {
    const user = await makeUser();
    const clientId = await registerClient("Unapproved");
    expect(await consentClaim(undefined, clientId)).toEqual({});
    expect(await consentClaim(user.id, clientId)).toEqual({});
  });

  it("gives two people's connections to one client different activity ids", async () => {
    // A hosted app may register one client for all its users.
    const clientId = await registerClient("Hosted agent");
    const alice = await makeUser();
    const bob = await makeUser();
    await consent(alice.id, clientId, "Alice's agent");
    await consent(bob.id, clientId, "Bob's agent");

    const a = await principalForToken(await tokenFor(alice.id, clientId));
    const b = await principalForToken(await tokenFor(bob.id, clientId));
    expect(a?.keyName).toBe("Alice's agent");
    expect(b?.keyName).toBe("Bob's agent");
    expect(a?.keyId).not.toBe(b?.keyId);
  });

  it("refuses a token for a client that has been disabled", async () => {
    const user = await makeUser();
    const { clientId } = await connect(user.id, "Claude Code", null);
    await db.oauthClient.update({ where: { clientId }, data: { disabled: true } });
    expect(await principalForToken(await tokenFor(user.id, clientId))).toBeNull();
  });

  it("lists, renames and disconnects only the user's own connections", async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const { consentId } = await connect(user.id, "Claude Code", "Laptop");

    const [listed] = await listConnections(user.id);
    expect(listed).toMatchObject({ id: consentId, name: "Laptop", clientName: "Claude Code" });
    expect(await listConnections(stranger.id)).toEqual([]);

    expect(await renameConnection(stranger.id, consentId, "Hijacked")).toBe(false);
    expect(await disconnectConnection(stranger.id, consentId)).toBe(false);

    expect(await renameConnection(user.id, consentId, "Desktop")).toBe(true);
    expect((await listConnections(user.id))[0]?.name).toBe("Desktop");
    // Clearing the name shows the app's own again.
    expect(await renameConnection(user.id, consentId, "")).toBe(true);
    expect((await listConnections(user.id))[0]?.name).toBe("Claude Code");
  });
});

describe("parseConnectionName", () => {
  it("trims, and treats a missing name as none", () => {
    expect(parseConnectionName("  Research agent  ")).toBe("Research agent");
    expect(parseConnectionName(undefined)).toBe("");
    expect(parseConnectionName(null)).toBe("");
  });

  it("rejects a non-string or an over-long name", () => {
    expect(() => parseConnectionName(42)).toThrow();
    expect(() => parseConnectionName("x".repeat(CONNECTION_NAME_MAX + 1))).toThrow();
    expect(parseConnectionName("x".repeat(CONNECTION_NAME_MAX))).toHaveLength(CONNECTION_NAME_MAX);
  });
});

describe("parseConsentBody", () => {
  it("requires an explicit decision", () => {
    expect(() => parseConsentBody({ oauth_query: "q" })).toThrow();
    expect(() => parseConsentBody(undefined)).toThrow();
  });

  it("passes the decision, the parsed name and the raw query through", () => {
    expect(parseConsentBody({ accept: true, name: " Laptop ", oauth_query: "q" })).toEqual({
      accept: true,
      name: "Laptop",
      oauthQuery: "q",
    });
    expect(parseConsentBody({ accept: false }).name).toBe("");
  });
});