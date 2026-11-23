import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

// Local fs storage, encrypted at rest like production.
useTempBlobDir("treehouse-tags-");
process.env.BLOB_KEK = `v1:${randomBytes(32).toString("base64")}`;

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { setNodePrivate } = await import("../server/utils/acl");
const { getLinks } = await import("../server/utils/links");
const { filesWithTag, listTags } = await import("../server/utils/tags");

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-10-30T00:00:00Z";
const ALICE = "u_alice";
const BOB = "u_bob";

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_tags_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

async function put(workspaceId: string, path: string, content: string, actorId = ALICE) {
  const cur = await svc.stat(workspaceId, path, "trusted");
  const res = await svc.write({
    workspaceId,
    path,
    body: new TextEncoder().encode(content),
    baseVersion: cur?.version,
    actor: { principal: "human", actorId, access: asMember(actorId) },
    nowIso: NOW,
  });
  expect(res.ok).toBe(true);
}

const summary = async (workspaceId: string, actorId = ALICE) =>
  (await listTags({ workspaceId, access: asMember(actorId) })).tags.map((t) => [t.tag, t.paths]);

describe("tag index", () => {
  it("lists front-matter and inline tags with the notes carrying them", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "---\ntags: [Planning, product]\n---\nShip it #launch/beta");
    await put(ws.id, "b.md", "Also #planning but not `#code`");
    await put(ws.id, "c.txt", "#not-markdown");
    expect(await summary(ws.id)).toEqual([
      ["launch/beta", ["a.md"]],
      ["Planning", ["a.md", "b.md"]],
      ["product", ["a.md"]],
    ]);
  });

  it("finds notes by tag, case-insensitively and through nesting", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "#project/alpha");
    await put(ws.id, "b.md", "#Project");
    await put(ws.id, "c.md", "#projects");
    const found = (tag: string) =>
      filesWithTag({ workspaceId: ws.id, access: asMember(ALICE), tag });
    expect((await found("#PROJECT"))?.paths).toEqual(["a.md", "b.md"]);
    expect((await found("project/alpha"))?.paths).toEqual(["a.md"]);
    expect(await found("#")).toBeNull();
  });

  it("finds notes under a numeric parent tag", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "#2026/planning");
    const found = await filesWithTag({ workspaceId: ws.id, access: asMember(ALICE), tag: "2026" });
    expect(found?.paths).toEqual(["a.md"]);
  });

  it("follows edits and deletes", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "#draft");
    await put(ws.id, "a.md", "#ready");
    expect(await summary(ws.id)).toEqual([["ready", ["a.md"]]]);
    await svc.remove({
      workspaceId: ws.id,
      path: "a.md",
      baseVersion: 2,
      actor: { principal: "human", actorId: ALICE, access: asMember(ALICE) },
    });
    expect(await summary(ws.id)).toEqual([]);
  });

  it("stores tag names encrypted, never as written", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "#acme-layoffs");
    const row = await db.fileLinks.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(Buffer.from(row.tagNames!).toString("latin1")).not.toContain("acme");
    expect(row.targets.join(" ")).not.toContain("acme");
  });

  it("returns a note's own tags with its links", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "---\ntags: x, y\n---\n#z");
    const links = await getLinks({ workspaceId: ws.id, access: asMember(ALICE), path: "a.md" });
    expect(links?.tags).toEqual(["x", "y", "z"]);
  });
});

describe("tags respect private files", () => {
  it("never lists or counts a private note's tags for anyone but its owner", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "shared.md", "#plan");
    await put(ws.id, "bob/secret.md", "#plan #reorg", BOB);
    await setNodePrivate({ workspaceId: ws.id, path: "bob", kind: "folder", ownerId: BOB });

    expect(await summary(ws.id, ALICE)).toEqual([["plan", ["shared.md"]]]);
    const forAlice = await filesWithTag({
      workspaceId: ws.id,
      access: asMember(ALICE),
      tag: "reorg",
    });
    expect(forAlice?.paths).toEqual([]);
    expect(await summary(ws.id, BOB)).toEqual([
      ["plan", ["bob/secret.md", "shared.md"]],
      ["reorg", ["bob/secret.md"]],
    ]);
  });
});