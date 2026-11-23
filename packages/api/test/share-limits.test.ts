import { afterEach, describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// Share ceiling enforcement (U5). The load-bearing behaviour is not that a
// paused link stops serving — it is everything that must KEEP working while it
// is paused: the owner's own workspace, their writes, and their files.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const APP_ORIGIN = process.env.SMOKE_APP_ORIGIN ?? "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
// Under REQUIRE_SERVER=1 this THROWS instead of returning false, so a suite that
// exists to prove an authorization boundary fails rather than skipping to green
// — including when the server disappears for only part of a run. It also carries
// a deadline, so a peer that connects and then says nothing cannot hang the gate.
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { shareLimitState, monthKey } = await import("../server/utils/share-usage");
const { assignPlan, clearPlanCache } = await import("../server/utils/plans");
const db = usePrismaClient();

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

let seq = 0;
const uid = () => `${Date.now()}_${Math.round(Math.random() * 1e9)}_${seq++}`;

async function setup(plan?: "seedling" | "grove") {
  const stamp = uid();
  const email = `sl${stamp}@example.test`;
  const { user } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "SL" } });
  const org = await db.organization.create({ data: { id: `org_sl_${stamp}`, name: "SL Org" } });
  await db.member.create({
    data: { id: `mem_sl_${stamp}`, organizationId: org.id, userId: user.id, role: "owner" },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Client Work" } });
  const key = await auth.api.createApiKey({
    body: { userId: user.id, name: "sl", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  // Assigned before any HTTP request touches this org. The API caches plan
  // resolution for 30s, so a plan assigned *after* a request would not be
  // visible to the server until that entry expired — which is real behaviour
  // (see assignPlan), not something to paper over here.
  if (plan) await assignPlan(org.id, plan);
  return { ws, org, email, key: key.key };
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
  return res;
}

async function publicShare(wsId: string, cookie: string, path: string) {
  const res = await fetch(`${BASE}/api/workspaces/${wsId}/shares`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ path, kind: "file", access: "public" }),
  });
  const { share } = (await res.json()) as { share: { id: string; token: string } };
  return share;
}

/** Put the workspace's monthly counters wherever the test needs them. */
async function setMonthUsage(wsId: string, views: number, bytes = 0) {
  await db.shareUsage.upsert({
    where: { workspaceId_kind_period: { workspaceId: wsId, kind: "month", period: monthKey() } },
    create: { workspaceId: wsId, kind: "month", period: monthKey(), views, bytes: BigInt(bytes) },
    update: { views, bytes: BigInt(bytes) },
  });
}

/** An org on a given plan, without the HTTP setup the ceiling tests need. */
async function newOrgOnPlan(plan: "seedling" | "grove") {
  const org = await db.organization.create({ data: { id: `org_fo_${uid()}`, name: "FO" } });
  await assignPlan(org.id, plan);
  return { org };
}

afterEach(() => {
  clearPlanCache();
});

describe.skipIf(!serverUp)("share ceilings (HTTP)", () => {
  it("serves right up to the limit and pauses the request after it", async () => {
    const { ws, email, key } = await setup("seedling");
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "proposal.md", "# Proposal");
    const share = await publicShare(ws.id, cookie, "proposal.md");
    await setMonthUsage(ws.id, 499);

    const open = () =>
      fetch(`${BASE}/api/share/${share.token}/file`, { headers: { "user-agent": BROWSER } });
    expect((await open()).status).toBe(200);

    // That request was the 500th view. The next visitor finds it paused.
    await setMonthUsage(ws.id, 500);
    const blocked = await open();
    expect(blocked.status).toBe(402);
    expect(((await blocked.json()) as { data?: { error?: string } }).data?.error).toBe(
      "share_paused",
    );
  });

  it("leaves the owner's own workspace fully usable while links are paused", async () => {
    // The whole point. A usage ceiling must never become a data-access block —
    // it pauses public serving, not the customer's access to their own files.
    const { ws, email, key } = await setup("seedling");
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "notes.md", "# Notes");
    const share = await publicShare(ws.id, cookie, "notes.md");
    await setMonthUsage(ws.id, 5_000);

    // Public link: dark.
    const publicRes = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(publicRes.status).toBe(402);

    // The member reading the same file: unaffected.
    const read = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes.md`, {
      headers: { "x-api-key": key },
    });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("# Notes");

    // ...and still able to write.
    const write = await putFile(ws.id, key, "new-note.md", "# Still working");
    expect(write.status).toBe(201);

    // ...and to list.
    const list = await fetch(`${BASE}/api/workspaces/${ws.id}/list`, {
      headers: { "x-api-key": key },
    });
    expect(list.status).toBe(200);
  });

  it("pauses on the daily byte backstop while views are well under the limit", async () => {
    // Views bound the common case; one visit to a folder portal can pull far
    // more bytes than a view count can express, which is what this catches.
    const { ws, email, key } = await setup("seedling");
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "video.md", "# Big");
    const share = await publicShare(ws.id, cookie, "video.md");
    await db.shareUsage.upsert({
      where: {
        workspaceId_kind_period: {
          workspaceId: ws.id,
          kind: "day",
          period: new Date().toISOString().slice(0, 10),
        },
      },
      create: {
        workspaceId: ws.id,
        kind: "day",
        period: new Date().toISOString().slice(0, 10),
        views: 3,
        bytes: BigInt(2 * 1024 ** 3),
      },
      update: { bytes: BigInt(2 * 1024 ** 3) },
    });

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(res.status).toBe(402);
    const state = await shareLimitState(ws.id);
    expect(state.reason).toBe("day_bytes");
  });

  it("never pauses a paid plan", async () => {
    const { ws, email, key } = await setup("grove");
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "report.md", "# Report");
    const share = await publicShare(ws.id, cookie, "report.md");
    await setMonthUsage(ws.id, 5_000_000, 500 * 1024 ** 3);

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(res.status).toBe(200);
    expect((await shareLimitState(ws.id)).paused).toBe(false);
  });

  it("never pauses when no plan is assigned", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "open.md", "# Open");
    const share = await publicShare(ws.id, cookie, "open.md");
    await setMonthUsage(ws.id, 10_000);

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(res.status).toBe(200);
  });

  it("resumes automatically at a month boundary", async () => {
    const { ws, email, key } = await setup("seedling");
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "monthly.md", "# Monthly");
    const share = await publicShare(ws.id, cookie, "monthly.md");

    // Last month was over the limit; the current period is empty.
    await db.shareUsage.create({
      data: { workspaceId: ws.id, kind: "month", period: "2020-01", views: 9_999, bytes: 0n },
    });

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER },
    });
    expect(res.status).toBe(200);
  });
});

describe("usage-read failure", () => {
  it("serves rather than pausing when the usage query fails", async () => {
    // shareLimitState runs inside requirePublicShare, so a throw here would turn
    // a transient database blip into a 500 on every public link a customer has
    // ever sent a client. A metering outage must never take down delivery.
    // Swap the usage read for one that fails the way a database blip would.
    const usageModel = db.shareUsage as unknown as { findMany: unknown };
    const original = usageModel.findMany;
    usageModel.findMany = () => Promise.reject(new Error("connection terminated"));
    try {
      const { org } = await newOrgOnPlan("seedling");
      const ws = await db.workspace.create({ data: { organizationId: org.id, name: "W" } });
      const state = await shareLimitState(ws.id);
      expect(state.paused).toBe(false);
      expect(state.reason).toBeNull();
    } finally {
      usageModel.findMany = original;
    }
  });
});

describe.skipIf(!serverUp)("owner notifications", () => {
  it("warns once at 80% of the view limit, not on every visit", async () => {
    const { ws, email, key } = await setup("seedling");
    const cookie = await cookieFor(email);
    await putFile(ws.id, key, "warned.md", "# Warned");
    const share = await publicShare(ws.id, cookie, "warned.md");
    await setMonthUsage(ws.id, 405);

    const period = monthKey();
    const before = await db.shareUsage.findUnique({
      where: { workspaceId_kind_period: { workspaceId: ws.id, kind: "month", period } },
      select: { warnedAt: true },
    });
    expect(before?.warnedAt).toBeNull();

    for (const suffix of ["A", "B", "C"]) {
      await fetch(`${BASE}/api/share/${share.token}/file`, {
        headers: { "user-agent": `${BROWSER} ${suffix}` },
      });
    }

    const after = await db.shareUsage.findUnique({
      where: { workspaceId_kind_period: { workspaceId: ws.id, kind: "month", period } },
      select: { warnedAt: true },
    });
    // The latch is set exactly once — three distinct visitors, one notification.
    expect(after?.warnedAt).not.toBeNull();
  });

  it("reports warning state and views remaining on the usage endpoint", async () => {
    const { ws, key } = await setup("seedling");
    await setMonthUsage(ws.id, 450);

    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/usage`, {
      headers: { "x-api-key": key },
    });
    const body = (await res.json()) as {
      shareViews: number;
      shareViewLimit: number | null;
      shareViewsRemaining: number | null;
      shareWarning: boolean;
      sharesPaused: boolean;
    };
    expect(body.shareViews).toBe(450);
    expect(body.shareViewLimit).toBe(500);
    expect(body.shareViewsRemaining).toBe(50);
    expect(body.shareWarning).toBe(true);
    expect(body.sharesPaused).toBe(false);
  });
});