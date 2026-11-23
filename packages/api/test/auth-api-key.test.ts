import { describe, expect, it } from "vite-plus/test";
import "./env";

// auth.ts builds the Prisma client at import time, so env must load first.
const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function makeUser() {
  const email = `u${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "Test User" },
  });
  return res.user;
}

describe("api-key auth", () => {
  it("authenticates a request via the x-api-key header and exposes key metadata", async () => {
    const user = await makeUser();

    const created = await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: "agent-key",
        metadata: { workspaceId: "ws_test", actorType: "agent" },
      },
    });
    expect(created.key).toBeTruthy();

    const session = await auth.api.getSession({
      headers: new Headers({ "x-api-key": created.key }),
    });

    expect(session?.user.id).toBe(user.id);
    // metadata round-trips so the file-service can scope + attribute by key
    expect(created.metadata).toMatchObject({ workspaceId: "ws_test", actorType: "agent" });
  });

  it("provisions a personal workspace on sign-up", async () => {
    const user = await makeUser();
    // The user-create hook should have made them the owner of the workspace's
    // hidden organization...
    const member = await db.member.findFirst({ where: { userId: user.id } });
    expect(member?.role).toBe("owner");
    // ...of a workspace named after them (not "Default" — the switcher is flat,
    // so identical names would be indistinguishable), so onboarding/CLI-linking
    // has a target.
    const ws = await db.workspace.findFirst({
      where: { organizationId: member?.organizationId },
    });
    expect(ws?.name).toBe("Test User's Workspace");

    // ...seeded with the starter kit, so a new signup never lands on a blank
    // workspace. Sign-up is the highest-traffic creation path and the one most
    // likely to be missed in a refactor of provisionForNewUser.
    const { useFileService } = await import("../server/utils/files");
    const seeded = (await useFileService().list(ws?.id ?? "", "", "trusted"))
      .map((e) => e.path)
      .sort();
    expect(seeded).toEqual(["AGENTS.md", "README.md"]);
  });

  it("throws on an unknown key (route layer maps this to 401)", async () => {
    // better-auth raises an APIError for a present-but-invalid x-api-key header
    // rather than returning a null session — U4 routes catch this and return 401.
    await expect(
      auth.api.getSession({
        headers: new Headers({ "x-api-key": "th_definitely_not_a_real_key" }),
      }),
    ).rejects.toThrow(/api key/i);
  });

  it("stops authenticating a key after it is revoked", async () => {
    const user = await makeUser();
    const created = await auth.api.createApiKey({
      body: { userId: user.id, name: "revoke-me", metadata: { actorType: "human" } },
    });

    const before = await auth.api.getSession({
      headers: new Headers({ "x-api-key": created.key }),
    });
    expect(before?.user.id).toBe(user.id);

    await auth.api.deleteApiKey({
      body: { keyId: created.id },
      headers: new Headers({ "x-api-key": created.key }),
    });

    await expect(
      auth.api.getSession({ headers: new Headers({ "x-api-key": created.key }) }),
    ).rejects.toThrow(/api key/i);
  });
});