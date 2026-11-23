import { describe, expect, it } from "vite-plus/test";
import "./env";

// Membership-based workspace access: a user reaches exactly the workspaces whose
// (hidden) organization they are a member of — never "everything in the active
// org". Runs in-process against the dev DB (no HTTP server needed), so these
// assertions are part of the default `vp test` run.
const { auth } = await import("../server/utils/auth");
const { createWorkspaceWithOrg, workspacesForUser, authorizeWorkspace } =
  await import("../server/utils/workspace");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function makeUser(): Promise<{ userId: string; name: string }> {
  const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const name = `Mem ${stamp}`;
  const res = await auth.api.signUpEmail({
    body: { email: `mem${stamp}@example.test`, password: "correct-horse-battery", name },
    asResponse: true,
  });
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!userId) throw new Error(`sign-up failed (${res.status})`);
  return { userId, name };
}

const cookieCtx = (userId: string) => ({ userId, principal: "human" as const });

describe("workspacesForUser", () => {
  it("returns the one workspace provisioned at signup, named after the user", async () => {
    const { userId, name } = await makeUser();
    const list = await workspacesForUser(userId);
    expect(list.length).toBe(1);
    // Not "Default": the switcher is flat now, so every workspace needs a name
    // that distinguishes it.
    expect(list[0]?.name).toBe(`${name}'s Workspace`);
    // Signup provisions through the same shared helper, so the workspace owns
    // exactly one organization and is its only inhabitant.
    const siblings = await db.workspace.count({
      where: { organizationId: list[0]?.organizationId },
    });
    expect(siblings).toBe(1);
  });

  it("unions workspaces across DIFFERENT organizations, oldest first", async () => {
    const { userId } = await makeUser();
    const a = await createWorkspaceWithOrg({ userId, name: "Alpha" });
    const b = await createWorkspaceWithOrg({ userId, name: "Beta" });

    const ids = (await workspacesForUser(userId)).map((w) => w.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // Three distinct orgs (signup + two creations), one workspace each.
    const orgIds = new Set((await workspacesForUser(userId)).map((w) => w.organizationId));
    expect(orgIds.size).toBe(3);
  });

  it("still lists SIBLING workspaces sharing one organization (pre-migration shape)", async () => {
    // The old data shape: one org, several workspaces. Membership of that org
    // must still reach all of them, so Milestone 1 is safe to deploy before the
    // Milestone 3 split migration runs.
    const { userId } = await makeUser();
    const first = await createWorkspaceWithOrg({ userId, name: "Shared" });
    const sibling = await db.workspace.create({
      data: { organizationId: first.organizationId, name: "Sibling" },
    });
    const ids = (await workspacesForUser(userId)).map((w) => w.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(sibling.id);
  });

  it("omits workspaces the user is not a member of", async () => {
    const owner = await makeUser();
    const outsider = await makeUser();
    const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Private" });
    const ids = (await workspacesForUser(outsider.userId)).map((w) => w.id);
    expect(ids).not.toContain(ws.id);
  });
});

describe("createWorkspaceWithOrg (one hidden org per workspace)", () => {
  it("mints a distinct org per workspace with the creator as owner", async () => {
    const { userId } = await makeUser();
    const one = await createWorkspaceWithOrg({ userId, name: "One" });
    const two = await createWorkspaceWithOrg({ userId, name: "Two" });
    expect(one.organizationId).not.toBe(two.organizationId);

    for (const ws of [one, two]) {
      const m = await db.member.findFirst({
        where: { organizationId: ws.organizationId, userId },
      });
      expect(m?.role).toBe("owner");
      const orgWorkspaces = await db.workspace.findMany({
        where: { organizationId: ws.organizationId },
      });
      expect(orgWorkspaces.length).toBe(1); // strictly 1:1
    }
  });

  it("seeds the new workspace with files", async () => {
    const { userId } = await makeUser();
    const ws = await createWorkspaceWithOrg({ userId, name: "Seeded" });
    const files = await db.fileNode.count({ where: { workspaceId: ws.id } });
    expect(files).toBeGreaterThan(0);
  });

  it("tolerates two workspaces with the SAME name (org slug is unique)", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const one = await createWorkspaceWithOrg({ userId: a.userId, name: "Team Notes" });
    const two = await createWorkspaceWithOrg({ userId: b.userId, name: "Team Notes" });
    expect(one.id).not.toBe(two.id);
  });

  it("carries icon and colour through", async () => {
    const { userId } = await makeUser();
    const ws = await createWorkspaceWithOrg({
      userId,
      name: "Pretty",
      icon: "🌳",
      color: "emerald",
    });
    expect(ws.icon).toBe("🌳");
    expect(ws.color).toBe("emerald");
  });
});

describe("cross-workspace isolation", () => {
  it("a member of workspace 1 gets 403 on the same owner's workspace 2", async () => {
    const owner = await makeUser();
    const guest = await makeUser();
    const first = await createWorkspaceWithOrg({ userId: owner.userId, name: "Shared With Guest" });
    const second = await createWorkspaceWithOrg({ userId: owner.userId, name: "Owner Only" });

    // The guest joins ONLY the first workspace's org (what invite-accept does).
    await db.member.create({
      data: {
        id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
        organizationId: first.organizationId,
        userId: guest.userId,
        role: "member",
      },
    });

    await expect(authorizeWorkspace(cookieCtx(guest.userId), first.id)).resolves.toMatchObject({
      id: first.id,
    });
    await expect(authorizeWorkspace(cookieCtx(guest.userId), second.id)).rejects.toMatchObject({
      statusCode: 403,
    });

    const guestIds = (await workspacesForUser(guest.userId)).map((w) => w.id);
    expect(guestIds).toContain(first.id);
    expect(guestIds).not.toContain(second.id);
  });
});