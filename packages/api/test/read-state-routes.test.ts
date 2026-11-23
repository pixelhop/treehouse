import { describe, expect, it } from "vite-plus/test";
import "./env";

// Route-level integration test against a RUNNING api dev server. Exercises the
// per-user read-state (activity-feed watermark) routes: cookie-only PUT,
// monotonic advance, integer validation, and per-user isolation. Server-gated.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

const PASSWORD = "correct-horse-battery";
const APP_ORIGIN = process.env.SMOKE_APP_ORIGIN ?? "http://localhost:3000";

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const email = `rs${stamp}@example.test`;
  const { user } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "RS" } });
  const org = await db.organization.create({ data: { id: `org_rs_${stamp}`, name: "RS Org" } });
  await db.member.create({
    data: {
      id: `mem_rs_${stamp}`,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "rs-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, email, key: key.key, userId: user.id, orgId: org.id };
}

async function cookieFor(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

describe.skipIf(!serverUp)("read-state routes (HTTP)", () => {
  it("GET returns null before anything is seen; PUT then GET round-trips", async () => {
    const { ws, email } = await setup();
    const cookie = await cookieFor(email);
    const h = { cookie, "content-type": "application/json", origin: APP_ORIGIN };

    const before = await fetch(`${BASE}/api/workspaces/${ws.id}/read-state`, {
      headers: { cookie },
    });
    expect(await before.json()).toEqual({ lastSeenSeq: null });

    const put = await fetch(`${BASE}/api/workspaces/${ws.id}/read-state`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ lastSeenSeq: 42 }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).lastSeenSeq).toBe(42);

    const after = await fetch(`${BASE}/api/workspaces/${ws.id}/read-state`, {
      headers: { cookie },
    });
    expect((await after.json()).lastSeenSeq).toBe(42);
  });

  it("never lowers an existing watermark (monotonic)", async () => {
    const { ws, email } = await setup();
    const cookie = await cookieFor(email);
    const h = { cookie, "content-type": "application/json", origin: APP_ORIGIN };
    const put = (n: number) =>
      fetch(`${BASE}/api/workspaces/${ws.id}/read-state`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({ lastSeenSeq: n }),
      }).then((r) => r.json());

    await put(50);
    expect((await put(30)).lastSeenSeq).toBe(50); // lower request is a no-op
    expect((await put(60)).lastSeenSeq).toBe(60);
  });

  it("rejects a non-integer / negative lastSeenSeq with 400", async () => {
    const { ws, email } = await setup();
    const cookie = await cookieFor(email);
    const h = { cookie, "content-type": "application/json", origin: APP_ORIGIN };
    for (const bad of [1.5, -1, "12", null]) {
      const res = await fetch(`${BASE}/api/workspaces/${ws.id}/read-state`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({ lastSeenSeq: bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects PUT via API key (cookie session required)", async () => {
    const { ws, key } = await setup();
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/read-state`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ lastSeenSeq: 5 }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a non-member of the workspace with 403", async () => {
    const a = await setup();
    const b = await setup();
    // b is not a member of a's workspace → 403 on read.
    const cookieB = await cookieFor(b.email);
    const cross = await fetch(`${BASE}/api/workspaces/${a.ws.id}/read-state`, {
      headers: { cookie: cookieB },
    });
    expect(cross.status).toBe(403);
  });

  it("keeps watermarks independent for two members of the same workspace", async () => {
    const a = await setup();
    const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    const emailB = `rsb${stamp}@example.test`;
    const { user: userB } = await auth.api.signUpEmail({
      body: { email: emailB, password: PASSWORD, name: "RS-B" },
    });
    await db.member.create({
      data: {
        id: `mem_rsb_${stamp}`,
        organizationId: a.orgId,
        userId: userB.id,
        role: "member",
        createdAt: new Date(),
      },
    });

    const cookieA = await cookieFor(a.email);
    const cookieB = await cookieFor(emailB);
    await fetch(`${BASE}/api/workspaces/${a.ws.id}/read-state`, {
      method: "PUT",
      headers: { cookie: cookieA, "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ lastSeenSeq: 42 }),
    });

    // B is a member of the same workspace, so the read is authorized (200), but
    // B's watermark is independent of A's advance.
    const bState = await fetch(`${BASE}/api/workspaces/${a.ws.id}/read-state`, {
      headers: { cookie: cookieB },
    });
    expect(bState.status).toBe(200);
    expect((await bState.json()).lastSeenSeq).toBeNull();
  });
});