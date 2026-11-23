import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

useTempBlobDir("treehouse-details-");

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { listFileDetails, isUnseen, NEW_WINDOW_MS, withFileDetails } =
  await import("../server/utils/file-details");

const db = usePrismaClient();
const svc = useFileService();
const NOW = new Date().toISOString();
const enc = (s: string) => new TextEncoder().encode(s);

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_fd_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

describe("file details", () => {
  it("a move keeps the file's created time and records the mover", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "a.md",
      body: enc("body"),
      actor: {
        principal: "agent",
        actorId: "u1",
        actorLabel: "Claude Code",
        access: asMember("u1"),
      },
      nowIso: NOW,
    });
    const before = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path: "a.md" } },
    });
    await new Promise((r) => setTimeout(r, 20));
    await svc.move({
      workspaceId: ws.id,
      from: "a.md",
      to: "docs/b.md",
      actor: { principal: "human", actorId: "u2", access: asMember("u2") },
    });
    const after = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path: "docs/b.md" } },
    });
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    const details = await listFileDetails(ws.id, "u2");
    expect(details.get("docs/b.md")).toMatchObject({
      createdAt: before.createdAt.toISOString(),
      modifiedBy: { principal: "human", actorId: "u2" },
      unseen: false,
    });
  });

  it("marks an agent's change as new until the reader has seen those bytes", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "plan.md",
      body: enc("v1"),
      actor: {
        principal: "agent",
        actorId: "u1",
        actorLabel: "Claude Code",
        access: asMember("u1"),
      },
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws.id,
      path: "mine.md",
      body: enc("mine"),
      actor: { principal: "human", actorId: "u1", access: asMember("u1") },
      nowIso: NOW,
    });

    let details = await listFileDetails(ws.id, "u1");
    // An agent on your own key still counts: that's the change you haven't seen.
    expect(details.get("plan.md")).toMatchObject({
      unseen: true,
      modifiedBy: { principal: "agent", actorLabel: "Claude Code" },
    });
    // Your own edit in the app never does.
    expect(details.get("mine.md")?.unseen).toBe(false);
    // Someone else's edit is new to another member.
    expect((await listFileDetails(ws.id, "u9")).get("mine.md")?.unseen).toBe(true);

    const node = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path: "plan.md" } },
    });
    await db.fileReadState.create({
      data: {
        userId: "u1",
        workspaceId: ws.id,
        path: "plan.md",
        lastSeenVersion: node.version,
        lastSeenContentHash: node.contentHash,
      },
    });
    details = await listFileDetails(ws.id, "u1");
    expect(details.get("plan.md")?.unseen).toBe(false);

    // A later write makes it new again.
    await svc.write({
      workspaceId: ws.id,
      path: "plan.md",
      body: enc("v2"),
      baseVersion: node.version,
      actor: {
        principal: "agent",
        actorId: "u1",
        actorLabel: "Claude Code",
        access: asMember("u1"),
      },
      nowIso: NOW,
    });
    details = await listFileDetails(ws.id, "u1");
    expect(details.get("plan.md")?.unseen).toBe(true);
  });

  it("merges details only when asked, and only onto the entries it is given", async () => {
    const ws = await freshWorkspace();
    for (const path of ["seen.md", "hidden.md"]) {
      await svc.write({
        workspaceId: ws.id,
        path,
        body: enc(path),
        actor: { principal: "agent", actorId: "u1", access: asMember("u1") },
        nowIso: NOW,
      });
    }
    const listed = [{ path: "seen.md" }];
    expect(await withFileDetails(listed, ws.id, "u1", false)).toBe(listed);
    const merged = await withFileDetails(listed, ws.id, "u1", true);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ path: "seen.md", unseen: true });
  });

  it("the starter kit is never new: nobody made it", () => {
    const row = { contentHash: "h", seenHash: null, principal: "agent", actorId: null };
    expect(isUnseen({ ...row, updatedAt: new Date() }, "u1")).toBe(false);
  });

  it("an old change is not new, however unseen", () => {
    const row = {
      contentHash: "h2",
      seenHash: "h1",
      principal: "agent",
      actorId: "u1",
    };
    const now = Date.now();
    expect(isUnseen({ ...row, updatedAt: new Date(now - 1000) }, "u1", now)).toBe(true);
    expect(isUnseen({ ...row, updatedAt: new Date(now - NEW_WINDOW_MS - 1000) }, "u1", now)).toBe(
      false,
    );
  });
});