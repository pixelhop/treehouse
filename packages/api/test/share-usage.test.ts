import { describe, expect, it } from "vite-plus/test";
import "./env";

// Share usage counting (U4), exercised over real HTTP against a running dev
// server — the counters hook into the public share routes, so an in-process
// unit test would prove the arithmetic without proving the wiring.
//
// Start a server and point SMOKE_BASE at it to run these.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const APP_ORIGIN = process.env.SMOKE_APP_ORIGIN ?? "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { isBotRequest } = await import("../server/utils/share-usage");
const db = usePrismaClient();

// A browser-shaped user-agent. The counter treats an absent or bot-shaped UA as
// not-a-view, so every request that should count has to carry one.
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

let seq = 0;
const uid = () => `${Date.now()}_${Math.round(Math.random() * 1e9)}_${seq++}`;

async function setup() {
  const stamp = uid();
  const email = `su${stamp}@example.test`;
  const { user } = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: "SU" },
  });
  const org = await db.organization.create({ data: { id: `org_su_${stamp}`, name: "SU Org" } });
  await db.member.create({
    data: { id: `mem_su_${stamp}`, organizationId: org.id, userId: user.id, role: "owner" },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: { userId: user.id, name: "su", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  return { ws, email, key: key.key, userId: user.id };
}

async function cookieFor(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function putFile(wsId: string, key: string, path: string, body: string) {
  const res = await fetch(`${BASE}/api/workspaces/${wsId}/files/${path}`, {
    method: "PUT",
    headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
    body,
  });
  if (!res.ok) throw new Error(`putFile failed: ${res.status} ${await res.text()}`);
}

/** Mint a public share via a cookie session (public links are cookie-only). */
async function publicShare(wsId: string, cookie: string, path: string, kind: "file" | "folder") {
  const res = await fetch(`${BASE}/api/workspaces/${wsId}/shares`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ path, kind, access: "public" }),
  });
  if (!res.ok) throw new Error(`share failed: ${res.status} ${await res.text()}`);
  const { share } = (await res.json()) as { share: { id: string; token: string } };
  return share;
}

function usage(wsId: string) {
  return db.shareUsage.findMany({
    where: { workspaceId: wsId },
    select: { kind: true, views: true, bytes: true },
  });
}

const monthly = (rows: { kind: string; views: number; bytes: bigint }[]) =>
  rows.find((r) => r.kind === "month");

describe("bot and unfurler filtering", () => {
  it("treats crawlers and link unfurlers as non-views", () => {
    // Slack, iMessage and WhatsApp all fetch a link the moment it is pasted. If
    // those counted, a share's view count would rise before any human opened it
    // and the number members see would be untrustworthy.
    for (const ua of [
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "facebookexternalhit/1.1",
      "WhatsApp/2.23",
      "Twitterbot/1.0",
      "Discordbot/2.0",
      "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "curl/8.4.0",
    ]) {
      expect(isBotRequest(ua)).toBe(true);
    }
  });

  it("treats a missing user-agent as a non-view", () => {
    expect(isBotRequest(undefined)).toBe(true);
    expect(isBotRequest("")).toBe(true);
  });

  it("treats a real browser as a view", () => {
    expect(isBotRequest(BROWSER)).toBe(false);
  });
});

describe.skipIf(!serverUp)("share view counting (HTTP)", () => {
  it("counts one view per visitor per day, not one per request", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "proposal.md", "# Proposal");
    const share = await publicShare(ws.id, cookie, "proposal.md", "file");

    const open = () =>
      fetch(`${BASE}/api/share/${share.token}/file`, { headers: { "user-agent": BROWSER } });

    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);

    const row = await db.share.findUnique({
      where: { id: share.id },
      select: { viewCount: true, lastViewedAt: true },
    });
    expect(row?.viewCount).toBe(1);
    expect(row?.lastViewedAt).not.toBeNull();
    expect(monthly(await usage(ws.id))?.views).toBe(1);
  });

  it("counts two distinct visitors separately", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "brief.md", "# Brief");
    const share = await publicShare(ws.id, cookie, "brief.md", "file");

    // The visitor pseudonym mixes IP and user-agent; the IP is identical here,
    // so a different UA is what makes these two different visitors.
    await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": `${BROWSER} VisitorA` },
    });
    await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": `${BROWSER} VisitorB` },
    });

    const row = await db.share.findUnique({
      where: { id: share.id },
      select: { viewCount: true },
    });
    expect(row?.viewCount).toBe(2);
  });

  it("counts one view for a folder portal that then pulls several files", async () => {
    // The number members see has to mean "someone opened the link", not "how
    // many HTTP requests the browser happened to make".
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    for (const n of ["a", "b", "c"]) await putFile(ws.id, key, `docs/${n}.md`, `# ${n}`);
    const share = await publicShare(ws.id, cookie, "docs", "folder");

    const h = { "user-agent": BROWSER };
    await fetch(`${BASE}/api/share/${share.token}/meta`, { headers: h });
    await fetch(`${BASE}/api/share/${share.token}/list`, { headers: h });
    for (const n of ["a", "b", "c"]) {
      await fetch(`${BASE}/api/share/${share.token}/file?path=docs/${n}.md`, { headers: h });
    }

    const row = await db.share.findUnique({
      where: { id: share.id },
      select: { viewCount: true },
    });
    expect(row?.viewCount).toBe(1);
  });

  it("counts nothing for a bot", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "post.md", "# Post");
    const share = await publicShare(ws.id, cookie, "post.md", "file");

    await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0" },
    });

    const row = await db.share.findUnique({
      where: { id: share.id },
      select: { viewCount: true },
    });
    expect(row?.viewCount).toBe(0);
    expect(monthly(await usage(ws.id))?.views ?? 0).toBe(0);
  });

  it("counts nothing for an authenticated member reading the same file", async () => {
    // Share limits gate PUBLIC traffic only — a team hammering its own
    // workspace must never be able to trip them.
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "internal.md", "# Internal");
    await publicShare(ws.id, cookie, "internal.md", "file");

    for (let i = 0; i < 3; i++) {
      await fetch(`${BASE}/api/workspaces/${ws.id}/files/internal.md`, {
        headers: { "x-api-key": key, "user-agent": BROWSER },
      });
    }
    expect(monthly(await usage(ws.id))?.views ?? 0).toBe(0);
  });

  it("counts nothing while a password-gated link is still locked", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "secret.md", "# Secret");
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        path: "secret.md",
        kind: "file",
        access: "public",
        password: "hunter2hunter2",
      }),
    });
    const { share } = (await res.json()) as { share: { id: string; token: string } };

    // Locked: the visitor has seen nothing, so nothing is counted.
    const locked = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(locked.status).toBe(401);
    const before = await db.share.findUnique({
      where: { id: share.id },
      select: { viewCount: true },
    });
    expect(before?.viewCount).toBe(0);
  });

  it("accumulates served bytes and leaves a 304 uncounted", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    const body = "x".repeat(500);
    await putFile(ws.id, key, "big.md", body);
    const share = await publicShare(ws.id, cookie, "big.md", "file");

    const first = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const afterFirst = Number(monthly(await usage(ws.id))?.bytes ?? 0n);
    expect(afterFirst).toBe(body.length);

    // A conditional re-request writes no body, so it must add no bytes.
    const second = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER, "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    expect(Number(monthly(await usage(ws.id))?.bytes ?? 0n)).toBe(afterFirst);
  });

  it("surfaces the view count to members on the share list", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "client.md", "# Client");
    const share = await publicShare(ws.id, cookie, "client.md", "file");
    await fetch(`${BASE}/api/share/${share.token}/file`, { headers: { "user-agent": BROWSER } });

    const listed = await fetch(`${BASE}/api/workspaces/${ws.id}/shares?path=client.md`, {
      headers: { "x-api-key": key },
    });
    const { shares } = (await listed.json()) as {
      shares: { id: string; viewCount: number; lastViewedAt: string | null }[];
    };
    const mine = shares.find((s) => s.id === share.id);
    expect(mine?.viewCount).toBe(1);
    expect(mine?.lastViewedAt).toBeTruthy();
  });

  it("counts nothing for a revoked link", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "gone.md", "# Gone");
    const share = await publicShare(ws.id, cookie, "gone.md", "file");
    await db.share.update({ where: { id: share.id }, data: { revokedAt: new Date() } });

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(res.status).toBe(404);
    const row = await db.share.findUnique({
      where: { id: share.id },
      select: { viewCount: true },
    });
    expect(row?.viewCount).toBe(0);
  });
});