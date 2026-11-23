import { describe, expect, it } from "vite-plus/test";
import "./env";

// The workspace-scoped checkout route. Its job is to let someone buy a plan
// without the app ever holding an organization id — organizations are invisible
// machinery, and that rule has to hold on the billing path too.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const APP_ORIGIN = process.env.SMOKE_APP_ORIGIN ?? "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

let seq = 0;
const uid = () => `${Date.now()}_${Math.round(Math.random() * 1e9)}_${seq++}`;

async function member(role: "owner" | "admin" | "member" = "owner") {
  const stamp = uid();
  const email = `co${stamp}@example.test`;
  const { user } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "CO" } });
  const ws = await db.workspace.findFirst({
    where: { organization: { members: { some: { userId: user.id } } } },
  });
  if (role !== "owner") {
    await db.member.updateMany({
      where: { organizationId: ws!.organizationId, userId: user.id },
      data: { role },
    });
  }
  return { email, ws: ws! };
}

async function cookieFor(email: string) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

function checkout(wsId: string, cookie: string, body: unknown) {
  return fetch(`${BASE}/api/workspaces/${wsId}/billing/checkout`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!serverUp)("workspace checkout (HTTP)", () => {
  it("returns a Stripe checkout URL for an owner", async () => {
    const { email, ws } = await member("owner");
    const res = await checkout(ws.id, await cookieFor(email), { plan: "grove" });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain("checkout.stripe.com");
  });

  it("accepts the annual interval", async () => {
    const { email, ws } = await member("owner");
    const res = await checkout(ws.id, await cookieFor(email), { plan: "grove", annual: true });
    expect(res.status).toBe(200);
  });

  it("opens checkout with a seat for everyone already in the workspace", async () => {
    // The bug this covers: the plugin defaults the Stripe quantity to 1, so a
    // five-person workspace was quoted — and charged — a one-person price, then
    // corrected by the hourly reconcile into a prorated charge nobody had seen.
    //
    // The plugin writes the local subscription row when checkout OPENS, with
    // the seats it asked Stripe for, so that row is what the quantity can be
    // read back from without completing a payment.
    const { email, ws } = await member("owner");
    for (let i = 0; i < 4; i++) {
      const extra = await db.user.create({
        data: {
          id: `usr_s_${uid()}`,
          name: "S",
          email: `s${uid()}@example.test`,
          emailVerified: true,
        },
      });
      await db.member.create({
        data: {
          id: `mem_s_${uid()}`,
          organizationId: ws.organizationId,
          userId: extra.id,
          role: "member",
        },
      });
    }

    const res = await checkout(ws.id, await cookieFor(email), { plan: "grove" });
    expect(res.status).toBe(200);

    // One org, one checkout: there is exactly one row to read.
    const sub = await db.subscription.findFirst({
      where: { referenceId: ws.organizationId },
    });
    expect(sub?.seats).toBe(5);
  });

  it("credits the affiliate whose referral cookie came with the request", async () => {
    // Sidekick's script keeps the referral in `sk_ref` on .trytree.house, so it
    // arrives with the app's request. The plugin owns client_reference_id (the
    // org id), so the referral must ride in the session's metadata instead.
    const { email, ws } = await member("owner");
    const referral = "cmhx2k9vq0001l80g8f3a2b1c";
    const res = await checkout(ws.id, `${await cookieFor(email)}; sk_ref=${referral}`, {
      plan: "grove",
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const sessionId = url.match(/cs_(?:test|live)_[A-Za-z0-9]+/)?.[0];
    expect(sessionId).toBeTruthy();

    const { useStripe } = await import("../server/utils/billing");
    const session = await useStripe()!.checkout.sessions.retrieve(sessionId!);
    expect(session.metadata?.sidekick_referral).toBe(referral);
    expect(session.client_reference_id).toBe(ws.organizationId);
  });

  it("refuses a plain member — using a workspace is not buying for it", async () => {
    const { email, ws } = await member("member");
    const res = await checkout(ws.id, await cookieFor(email), { plan: "grove" });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown plan rather than guessing one", async () => {
    const { email, ws } = await member("owner");
    const cookie = await cookieFor(email);
    for (const plan of ["seedling", "enterprise", "", "legacy"]) {
      expect((await checkout(ws.id, cookie, { plan })).status).toBe(400);
    }
  });

  it("404s on someone else's workspace without confirming it exists", async () => {
    const { ws } = await member("owner");
    const outsider = await member("owner");
    const res = await checkout(ws.id, await cookieFor(outsider.email), { plan: "grove" });
    expect(res.status).toBe(404);
  });

  it("requires a session — an API key cannot buy", async () => {
    const { ws } = await member("owner");
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "grove" }),
    });
    expect(res.status).toBe(401);
  });
});