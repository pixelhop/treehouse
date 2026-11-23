import { describe, expect, it } from "vite-plus/test";
import "./env";

// auth.ts builds the Prisma client at import time, so env must load first. These
// run in-process against the dev DB (no HTTP server needed).
const { auth } = await import("../server/utils/auth");
const { revokeWorkspaceKeysForMember } = await import("../server/utils/workspace");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function makeUser() {
  const email = `rev${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "Rev User" },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!userId) throw new Error("sign-up failed");
  return { userId, email, cookie };
}

/** The org + Default workspace provisioned for a user on sign-up. */
async function orgAndWorkspace(userId: string) {
  const member = await db.member.findFirst({ where: { userId } });
  if (!member) throw new Error("no membership provisioned");
  const ws = await db.workspace.findFirst({ where: { organizationId: member.organizationId } });
  if (!ws) throw new Error("no workspace provisioned");
  return { organizationId: member.organizationId, workspaceId: ws.id };
}

const keyWorks = async (key: string) =>
  auth.api
    .getSession({ headers: new Headers({ "x-api-key": key }) })
    .then((s) => !!s)
    .catch(() => false);

describe("revokeWorkspaceKeysForMember (U4)", () => {
  it("revokes only the removed member's keys for that org's workspaces", async () => {
    const { userId } = await makeUser();
    const { organizationId, workspaceId } = await orgAndWorkspace(userId);

    // A workspace-scoped key in THIS org, and one scoped to an unrelated workspace.
    const scoped = await auth.api.createApiKey({
      body: { userId, name: "th", metadata: { workspaceId, actorType: "human" } },
    });
    const other = await auth.api.createApiKey({
      body: {
        userId,
        name: "th-other",
        metadata: { workspaceId: "ws_unrelated", actorType: "human" },
      },
    });
    expect(await keyWorks(scoped.key)).toBe(true);

    const revoked = await revokeWorkspaceKeysForMember(userId, organizationId);
    expect(revoked).toBe(1);

    // The in-org key no longer authenticates; the unrelated one survives.
    expect(await keyWorks(scoped.key)).toBe(false);
    expect(await keyWorks(other.key)).toBe(true);
  });

  it("is a no-op when the member holds no keys for the org", async () => {
    const { userId } = await makeUser();
    const { organizationId } = await orgAndWorkspace(userId);
    expect(await revokeWorkspaceKeysForMember(userId, organizationId)).toBe(0);
  });
});

describe("member removal revokes workspace keys (U4, end-to-end hook)", () => {
  it("removing a member invalidates their workspace-scoped keys", async () => {
    const owner = await makeUser();
    const { organizationId, workspaceId } = await orgAndWorkspace(owner.userId);

    // A second user joins the owner's org and is issued a workspace-scoped key.
    const member = await makeUser();
    await db.member.create({
      data: {
        id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
        organizationId,
        userId: member.userId,
        role: "member",
      },
    });
    const key = await auth.api.createApiKey({
      body: { userId: member.userId, name: "th", metadata: { workspaceId, actorType: "human" } },
    });
    expect(await keyWorks(key.key)).toBe(true);

    // The owner removes the member — the afterRemoveMember hook must revoke keys.
    await auth.api.removeMember({
      headers: new Headers({ cookie: owner.cookie }),
      body: { memberIdOrEmail: member.email, organizationId },
    });

    expect(await keyWorks(key.key)).toBe(false);
  });
});