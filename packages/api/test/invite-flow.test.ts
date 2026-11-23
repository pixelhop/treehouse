import { describe, expect, it } from "vite-plus/test";
import "./env";

// Route-level integration test for shareable workspace invite links against a
// RUNNING api dev server (start with `pnpm --filter api dev`, or nitro on :3001).
// Gated on reachability so `vp test` stays green without a server.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { assignPlan } = await import("../server/utils/plans");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function signUp() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const res = await auth.api.signUpEmail({
    body: { email: `inv${stamp}@example.test`, password: "correct-horse-battery", name: "Inv" },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!cookie || !userId) throw new Error(`sign-up failed (${res.status})`);
  return { cookie, userId, stamp };
}

async function makeWorkspace(userId: string, stamp: string, member = true) {
  const org = await db.organization.create({ data: { id: `org_inv_${stamp}`, name: "Inv Org" } });
  if (member) {
    await db.member.create({
      data: { id: `mem_inv_${stamp}`, organizationId: org.id, userId, role: "owner" },
    });
  }
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  return { org, ws };
}

const createInvite = (cookie: string, body: object) =>
  fetch(`${BASE}/api/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const preview = (token: string) => fetch(`${BASE}/api/invites/${encodeURIComponent(token)}`);
const accept = (cookie: string, token: string) =>
  fetch(`${BASE}/api/invites/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: { cookie },
  });

describe.skipIf(!serverUp)("workspace invite links (HTTP)", () => {
  it("create -> preview -> a second user accepts and becomes a member", async () => {
    const owner = await signUp();
    const { org, ws } = await makeWorkspace(owner.userId, owner.stamp);

    const created = await createInvite(owner.cookie, { workspaceId: ws.id });
    expect(created.status).toBe(200);
    const { token, url } = (await created.json()) as { token: string; url: string };
    expect(url).toContain(`/invite/${token}`);

    const prev = (await (await preview(token)).json()) as {
      valid: boolean;
      workspace: { name: string };
    };
    expect(prev.valid).toBe(true);
    expect(prev.workspace.name).toBe("Default");

    const invitee = await signUp();
    const res = await accept(invitee.cookie, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; alreadyMember: boolean };
    expect(body.workspaceId).toBe(ws.id);
    expect(body.alreadyMember).toBe(false);

    const member = await db.member.findFirst({
      where: { organizationId: org.id, userId: invitee.userId },
    });
    expect(member).not.toBeNull();
  });

  it("accept is idempotent and doesn't consume a second use", async () => {
    const owner = await signUp();
    const { ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };

    const invitee = await signUp();
    const first = (await (await accept(invitee.cookie, token)).json()) as {
      alreadyMember: boolean;
    };
    const second = (await (await accept(invitee.cookie, token)).json()) as {
      alreadyMember: boolean;
    };
    expect(first.alreadyMember).toBe(false);
    expect(second.alreadyMember).toBe(true);

    const invite = await db.workspaceInvite.findFirst({ where: { workspaceId: ws.id } });
    expect(invite?.uses).toBe(1); // not double-counted
  });

  it("CONCURRENT accepts create exactly one membership and consume exactly one use", async () => {
    // The route checks "already a member?" and inserts in two separate statements,
    // so simultaneous accepts could both pass the check and both insert. The
    // unique(organizationId, userId) constraint is what actually serializes them;
    // the loser is reported as an idempotent "already a member" and refunds its use.
    const owner = await signUp();
    const { org, ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };

    const invitee = await signUp();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => accept(invitee.cookie, token)),
    );
    for (const r of results) expect(r.status).toBe(200);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as {
      alreadyMember: boolean;
    }[];
    // Exactly one race winner actually created the membership.
    expect(bodies.filter((b) => !b.alreadyMember).length).toBe(1);

    const members = await db.member.findMany({
      where: { organizationId: org.id, userId: invitee.userId },
    });
    expect(members.length).toBe(1); // no duplicate membership rows

    const invite = await db.workspaceInvite.findFirst({ where: { workspaceId: ws.id } });
    expect(invite?.uses).toBe(1); // losers refunded the use they claimed
  });

  it("rejects creating an invite for a workspace you're not a member of", async () => {
    const owner = await signUp();
    const { ws } = await makeWorkspace(owner.userId, owner.stamp);
    const outsider = await signUp();
    const res = await createInvite(outsider.cookie, { workspaceId: ws.id });
    expect(res.status).toBe(403);
  });

  it("rejects accepting an expired invite", async () => {
    const owner = await signUp();
    const { ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };
    // Force-expire it.
    await db.workspaceInvite.updateMany({
      where: { workspaceId: ws.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const invitee = await signUp();
    const res = await accept(invitee.cookie, token);
    expect(res.status).toBe(410);
  });

  it("an existing member re-accepting an EXPIRED invite still gets ok+alreadyMember", async () => {
    // The membership check is hoisted above the expiry/revocation gates, so a
    // returning member re-clicking an old link resolves (for the app offer) instead
    // of hitting the "unavailable" dead end — and consumes no use.
    const owner = await signUp();
    const { ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };
    const invitee = await signUp();
    expect((await accept(invitee.cookie, token)).status).toBe(200); // becomes a member

    // Force-expire the invite, then the same member re-accepts.
    await db.workspaceInvite.updateMany({
      where: { workspaceId: ws.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await accept(invitee.cookie, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyMember: boolean };
    expect(body.alreadyMember).toBe(true);

    const invite = await db.workspaceInvite.findFirst({ where: { workspaceId: ws.id } });
    expect(invite?.uses).toBe(1); // the re-accept consumed nothing
  });

  it("accepting an invite joins the workspace's CURRENT org after re-parenting", async () => {
    // The invite row denormalizes an organizationId that goes stale the moment a
    // workspace is re-parented (exactly what the one-org-per-workspace migration
    // does). The accept route must resolve the org through the workspace, or an
    // old link would join the pre-split org and grant nothing.
    const owner = await signUp();
    const { org: oldOrg, ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };

    // Simulate the migration: a fresh org owns the workspace; the owner's
    // membership is copied; the invite row's stored org id is left STALE.
    const newOrg = await db.organization.create({
      data: { id: `org_split_${owner.stamp}`, name: "Split Org" },
    });
    await db.member.create({
      data: {
        id: `mem_split_${owner.stamp}`,
        organizationId: newOrg.id,
        userId: owner.userId,
        role: "owner",
      },
    });
    await db.workspace.update({ where: { id: ws.id }, data: { organizationId: newOrg.id } });

    const invitee = await signUp();
    const res = await accept(invitee.cookie, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      organizationId: string;
      alreadyMember: boolean;
    };
    expect(body.workspaceId).toBe(ws.id);
    expect(body.alreadyMember).toBe(false);
    expect(body.organizationId).toBe(newOrg.id);

    // Membership landed in the NEW org, not the invite's stored (stale) one.
    expect(
      await db.member.findFirst({ where: { organizationId: newOrg.id, userId: invitee.userId } }),
    ).not.toBeNull();
    expect(
      await db.member.findFirst({ where: { organizationId: oldOrg.id, userId: invitee.userId } }),
    ).toBeNull();

    // ...and the invitee can actually see the workspace.
    const list = (await (
      await fetch(`${BASE}/api/workspaces`, { headers: { cookie: invitee.cookie } })
    ).json()) as { workspaces: { id: string }[] };
    expect(list.workspaces.map((w) => w.id)).toContain(ws.id);
  });

  it("checks the member limit against the CURRENT org, not the invite's stale one", async () => {
    // The sibling test above proves the MEMBERSHIP lands in the right org. This
    // one covers the plan gate, which was still reading `invite.organizationId`
    // — so the limit was evaluated against one organization while the member was
    // created in another. Here the stale org is left empty and the current org
    // is already full, so a stale check would wave the accept through.
    const owner = await signUp();
    const { ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };

    const newOrg = await db.organization.create({
      data: { id: `org_lim_${owner.stamp}`, name: "Limit Org" },
    });
    await db.member.create({
      data: {
        id: `mem_lim_${owner.stamp}`,
        organizationId: newOrg.id,
        userId: owner.userId,
        role: "owner",
      },
    });
    await db.workspace.update({ where: { id: ws.id }, data: { organizationId: newOrg.id } });

    // The org the workspace now belongs to is on the one-member tier and full.
    //
    // Assigning the plan is enough on its own: an org with a hand-assigned tier
    // is enforced whether or not BILLING_ENABLED is set, which is what makes it
    // testable across the process boundary — these tests drive a SEPARATE server
    // process, so an env var set here would never reach the gate.
    await assignPlan(newOrg.id, "seedling");

    const invitee = await signUp();
    const res = await accept(invitee.cookie, token);
    // 402, not 200: the gate saw the org actually being joined.
    expect(res.status).toBe(402);
    expect(
      await db.member.findFirst({
        where: { organizationId: newOrg.id, userId: invitee.userId },
      }),
    ).toBeNull();
  });

  it("GET /api/workspaces unions every org the caller belongs to", async () => {
    // A and B share one org (the pre-migration shape); C lives in its own.
    // Membership-based listing must return all three, regardless of which org
    // the session considers "active".
    const user = await signUp();
    const { org: sharedOrg, ws: a } = await makeWorkspace(user.userId, `${user.stamp}_ab`);
    const b = await db.workspace.create({
      data: { organizationId: sharedOrg.id, name: "B" },
    });
    const { ws: c } = await makeWorkspace(user.userId, `${user.stamp}_c`);

    const res = await fetch(`${BASE}/api/workspaces`, { headers: { cookie: user.cookie } });
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as { workspaces: { id: string; name: string }[] };
    const ids = workspaces.map((w) => w.id);
    for (const id of [a.id, b.id, c.id]) expect(ids).toContain(id);
    // Shape is unchanged: id/name/icon/color/theme/themeCss.
    expect(Object.keys(workspaces[0] as object).sort()).toEqual(
      ["color", "icon", "id", "name", "theme", "themeCss"].sort(),
    );
  });

  it("inviting someone to ONE created workspace does not hand them the other", async () => {
    // The headline promise of the workspace-only model, exercised through the
    // real creation route: POST /api/workspaces mints a workspace with its own
    // hidden organization, so an invite to the first grants exactly the first.
    const owner = await signUp();
    const mk = async (name: string) => {
      const res = await fetch(`${BASE}/api/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string; name: string };
    };
    const shared = await mk("Shared Space");
    const priv = await mk("Private Space");

    // Distinct hidden orgs, one workspace each.
    const [sharedRow, privRow] = await Promise.all([
      db.workspace.findUniqueOrThrow({ where: { id: shared.id } }),
      db.workspace.findUniqueOrThrow({ where: { id: priv.id } }),
    ]);
    expect(sharedRow.organizationId).not.toBe(privRow.organizationId);

    const { token } = (await (
      await createInvite(owner.cookie, { workspaceId: shared.id })
    ).json()) as { token: string };
    const guest = await signUp();
    expect((await accept(guest.cookie, token)).status).toBe(200);

    const list = (await (
      await fetch(`${BASE}/api/workspaces`, { headers: { cookie: guest.cookie } })
    ).json()) as { workspaces: { id: string }[] };
    const ids = list.workspaces.map((w) => w.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(priv.id);

    // ...and the route-level guard agrees.
    const denied = await fetch(`${BASE}/api/workspaces/${priv.id}/list`, {
      headers: { cookie: guest.cookie },
    });
    expect(denied.status).toBe(403);
  });

  it("a NON-member still hits the expiry gate (410) on an expired invite", async () => {
    const owner = await signUp();
    const { ws } = await makeWorkspace(owner.userId, owner.stamp);
    const { token } = (await (await createInvite(owner.cookie, { workspaceId: ws.id })).json()) as {
      token: string;
    };
    await db.workspaceInvite.updateMany({
      where: { workspaceId: ws.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const outsider = await signUp();
    expect((await accept(outsider.cookie, token)).status).toBe(410);
  });
});