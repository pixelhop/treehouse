import { config } from "dotenv";
import { describe, expect, it } from "vite-plus/test";

config({ path: new URL("../.env", import.meta.url).pathname });

// usePrismaClient reads DATABASE_URL lazily (first call), so a static import is
// fine as long as dotenv has run above before any test calls it.
const { usePrismaClient } = await import("../index");

const db = usePrismaClient();

async function makeOrg() {
  const id = `org_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  return db.organization.create({ data: { id, name: "Test Org" } });
}

describe("treehouse schema", () => {
  it("creates a workspace + file node and reads it back by (workspaceId, path)", async () => {
    const org = await makeOrg();
    const ws = await db.workspace.create({
      data: { organizationId: org.id, name: "Default" },
    });

    const node = await db.fileNode.create({
      data: {
        workspaceId: ws.id,
        path: "proposal.md",
        contentHash: "abc123",
        size: 42,
        contentType: "text/markdown",
        blobKey: `${ws.id}/abc123`,
      },
    });

    // version defaults to 1 on insert
    expect(node.version).toBe(1);

    const found = await db.fileNode.findUnique({
      where: { workspaceId_path: { workspaceId: ws.id, path: "proposal.md" } },
    });
    expect(found?.id).toBe(node.id);
  });

  it("rejects a duplicate path within the same workspace (unique constraint)", async () => {
    const org = await makeOrg();
    const ws = await db.workspace.create({
      data: { organizationId: org.id, name: "Default" },
    });
    const base = {
      workspaceId: ws.id,
      path: "dup.md",
      contentHash: "h",
      size: 1,
      contentType: "text/markdown",
      blobKey: `${ws.id}/h`,
    };
    await db.fileNode.create({ data: base });
    await expect(db.fileNode.create({ data: base })).rejects.toThrow();
  });

  it("records a change event referencing a real workspace", async () => {
    const org = await makeOrg();
    const ws = await db.workspace.create({
      data: { organizationId: org.id, name: "Default" },
    });
    const evt = await db.changeEvent.create({
      data: {
        workspaceId: ws.id,
        path: "proposal.md",
        op: "write",
        version: 1,
        principal: "agent",
        actorId: "user_123",
      },
    });
    expect(evt.principal).toBe("agent");

    const feed = await db.changeEvent.findMany({ where: { workspaceId: ws.id } });
    expect(feed).toHaveLength(1);
  });
});