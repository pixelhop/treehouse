import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// Route-level integration test for the per-workspace members panel against a
// RUNNING api dev server (start with `pnpm --filter api dev`, or nitro on :3001).
// Gated on reachability so `vp test` stays green without a server.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
// Under REQUIRE_SERVER=1 this THROWS instead of returning false, so a suite that
// exists to prove an authorization boundary fails rather than skipping to green
// — including when the server disappears for only part of a run. It also carries
// a deadline, so a peer that connects and then says nothing cannot hang the gate.
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { createWorkspaceWithOrg } = await import("../server/utils/workspace");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function signUp(label: string) {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const email = `mrt${label}${stamp}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: `Mrt ${label}` },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!cookie || !userId) throw new Error(`sign-up failed (${res.status})`);
  return { cookie, userId, email, stamp };
}

/** Add `userId` to the workspace's org with the given role (what accept does). */
async function join(organizationId: string, userId: string, role: string) {
  await db.member.create({
    data: {
      id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
      organizationId,
      userId,
      role,
    },
  });
}

const getMembers = (cookie: string, workspaceId: string) =>
  fetch(`${BASE}/api/workspaces/${workspaceId}/members`, { headers: { cookie } });
const removeMember = (cookie: string, workspaceId: string, userId: string) =>
  fetch(`${BASE}/api/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
    headers: { cookie },
  });
const keyWorks = (key: string) =>
  auth.api
    .getSession({ headers: new Headers({ "x-api-key": key }) })
    .then((s) => !!s)
    .catch(() => false);

describe.skipIf(!serverUp)("workspace members (HTTP)", () => {
  it("lists members with their role, and never their email", async () => {
    const owner = await signUp("own");
    const guest = await signUp("gst");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Members WS" });
    await join(ws.organizationId, guest.userId, "member");

    const res = await getMembers(owner.cookie, ws.id);
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as {
      members: { id: string; name: string; image: string | null; role: string }[];
    };
    const byId = new Map(members.map((m) => [m.id, m]));
    expect(byId.get(owner.userId)?.role).toBe("owner");
    expect(byId.get(guest.userId)?.role).toBe("member");
    for (const m of members) expect(Object.keys(m).sort()).toEqual(["id", "image", "name", "role"]);
  });

  it("an owner removes a member, revoking that member's workspace key", async () => {
    const owner = await signUp("own");
    const guest = await signUp("gst");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Revoke WS" });
    await join(ws.organizationId, guest.userId, "member");

    // The guest's sync credential for THIS workspace, plus one for an unrelated
    // workspace that must survive.
    const scoped = await auth.api.createApiKey({
      body: {
        userId: guest.userId,
        name: "th",
        metadata: { workspaceId: ws.id, actorType: "human" },
      },
    });
    const elsewhere = await auth.api.createApiKey({
      body: {
        userId: guest.userId,
        name: "th-other",
        metadata: { workspaceId: "ws_unrelated", actorType: "human" },
      },
    });
    expect(await keyWorks(scoped.key)).toBe(true);

    const res = await removeMember(owner.cookie, ws.id, guest.userId);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    // Membership gone, workspace no longer listed, route access refused.
    expect(
      await db.member.findFirst({
        where: { organizationId: ws.organizationId, userId: guest.userId },
      }),
    ).toBeNull();
    const list = (await (
      await fetch(`${BASE}/api/workspaces`, { headers: { cookie: guest.cookie } })
    ).json()) as { workspaces: { id: string }[] };
    expect(list.workspaces.map((w) => w.id)).not.toContain(ws.id);
    expect(
      (await fetch(`${BASE}/api/workspaces/${ws.id}/list`, { headers: { cookie: guest.cookie } }))
        .status,
    ).toBe(403);

    // The removal hook revoked the key for THIS workspace only.
    expect(await keyWorks(scoped.key)).toBe(false);
    expect(await keyWorks(elsewhere.key)).toBe(true);
  });

  it("a plain member cannot remove anyone (403)", async () => {
    const owner = await signUp("own");
    const guest = await signUp("gst");
    const other = await signUp("oth");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "NoPerm WS" });
    await join(ws.organizationId, guest.userId, "member");
    await join(ws.organizationId, other.userId, "member");

    expect((await removeMember(guest.cookie, ws.id, other.userId)).status).toBe(403);
    expect(
      await db.member.findFirst({
        where: { organizationId: ws.organizationId, userId: other.userId },
      }),
    ).not.toBeNull();
  });

  it("an admin cannot remove an owner (403)", async () => {
    const owner = await signUp("own");
    const admin = await signUp("adm");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Admin WS" });
    await join(ws.organizationId, admin.userId, "admin");

    expect((await removeMember(admin.cookie, ws.id, owner.userId)).status).toBe(403);
  });

  it("the last owner cannot be removed (409)", async () => {
    const owner = await signUp("own");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "LastOwner WS" });
    // A workspace with no owner could never be administered again.
    expect((await removeMember(owner.cookie, ws.id, owner.userId)).status).toBe(409);
    expect(
      await db.member.findFirst({
        where: { organizationId: ws.organizationId, userId: owner.userId },
      }),
    ).not.toBeNull();
  });

  it("a non-member cannot even see the member list (403)", async () => {
    const owner = await signUp("own");
    const outsider = await signUp("out");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Closed WS" });
    expect((await getMembers(outsider.cookie, ws.id)).status).toBe(403);
    expect((await removeMember(outsider.cookie, ws.id, owner.userId)).status).toBe(403);
  });

  it("removing someone who isn't a member is a 404", async () => {
    const owner = await signUp("own");
    const stranger = await signUp("str");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Stranger WS" });
    expect((await removeMember(owner.cookie, ws.id, stranger.userId)).status).toBe(404);
  });

  it("an API key cannot remove a member, even one scoped to the workspace (403)", async () => {
    const owner = await signUp("own");
    const guest = await signUp("gst");
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "KeyGuard WS" });
    await join(ws.organizationId, guest.userId, "member");
    const key = await auth.api.createApiKey({
      body: {
        userId: owner.userId,
        name: "th",
        metadata: { workspaceId: ws.id, actorType: "agent" },
      },
    });

    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/members/${guest.userId}`, {
      method: "DELETE",
      headers: { "x-api-key": key.key },
    });
    expect(res.status).toBe(403);
    expect(
      await db.member.findFirst({
        where: { organizationId: ws.organizationId, userId: guest.userId },
      }),
    ).not.toBeNull();
  });
});