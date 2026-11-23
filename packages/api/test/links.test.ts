import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

// Local fs storage; never R2 (see useTempBlobDir). Encrypted at rest, like
// production: the index is built from bytes the file service decrypts.
const BLOB_DIR = useTempBlobDir("treehouse-links-");
process.env.BLOB_KEK = `v1:${randomBytes(32).toString("base64")}`;

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { setNodePrivate } = await import("../server/utils/acl");
const { getLinks, moveWithLinks } = await import("../server/utils/links");
const { useBlobStore } = await import("../server/utils/storage");
const { catchUpLinkIndex, linkIndexKeyId, linkKeyHash } =
  await import("../server/utils/link-index");

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-10-29T00:00:00Z";
const ALICE = "u_alice";
const BOB = "u_bob";

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_links_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

const enc = (s: string) => new TextEncoder().encode(s);

async function put(workspaceId: string, path: string, content: string, actorId = ALICE) {
  const cur = await svc.stat(workspaceId, path, "trusted");
  const res = await svc.write({
    workspaceId,
    path,
    body: enc(content),
    baseVersion: cur?.version,
    actor: { principal: "human", actorId, access: asMember(actorId) },
    nowIso: NOW,
  });
  expect(res.ok).toBe(true);
  return res.version as number;
}

async function text(workspaceId: string, path: string): Promise<string> {
  const r = await svc.read(workspaceId, path, "trusted");
  if (r.status !== "ok") throw new Error(`missing ${path}`);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(r.body);
}

/** Flip a byte of a file's stored (encrypted) blob, so reading it fails authentication. */
async function corrupt(workspaceId: string, path: string) {
  const node = await db.fileNode.findUniqueOrThrow({
    where: { workspaceId_path: { workspaceId, path } },
  });
  const blobPath = join(BLOB_DIR, node.blobKey);
  const bytes = await readFile(blobPath);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
  await writeFile(blobPath, bytes);
}

const backlinks = async (workspaceId: string, path: string, actorId = ALICE) =>
  (await getLinks({ workspaceId, access: asMember(actorId), path }))?.backlinks;

describe("backlink index", () => {
  it("lists notes linking by wikilink and by relative markdown link", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Projects/Alpha.md", "# Alpha");
    await put(ws.id, "daily/2026-10-29.md", "Worked on [[Alpha|the alpha]] today.");
    await put(ws.id, "Projects/index.md", "- [Alpha](Alpha.md)\n- [[Missing]]");
    await put(ws.id, "unrelated.md", "Nothing here. `[[Alpha]]` is code.");

    expect(await backlinks(ws.id, "Projects/Alpha.md")).toEqual([
      "Projects/index.md",
      "daily/2026-10-29.md",
    ]);
  });

  it("keys the hashes with a secret a database copy doesn't hold", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "[[Plan]]");
    const row = await db.fileLinks.findUniqueOrThrow({
      where: { workspaceId_sourcePath: { workspaceId: ws.id, sourcePath: "a.md" } },
    });
    const unkeyed = createHash("sha256").update(`${ws.id}\0w:plan`).digest("hex").slice(0, 40);
    expect(row.targets).toEqual([linkKeyHash(ws.id, "w:plan")]);
    expect(row.targets).not.toContain(unkeyed);
    expect(row.keyId).toBe(linkIndexKeyId());
    expect(row.keyId).toMatch(/^v2\/kek:/);
  });

  it("rebuilds rows made under an older key", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    await put(ws.id, "src.md", "[[Target]]");
    await db.fileLinks.updateMany({
      where: { workspaceId: ws.id },
      data: { keyId: "kek:retired", targets: ["stale"] },
    });
    expect(await backlinks(ws.id, "Target.md")).toEqual(["src.md"]);
  });

  it("keeps a note's links when the same bytes are sent again under another type", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    await put(ws.id, "src.md", "[[Target]]");
    const res = await svc.write({
      workspaceId: ws.id,
      path: "src.md",
      body: enc("[[Target]]"),
      contentType: "text/plain",
      actor: { principal: "human", actorId: ALICE, access: asMember(ALICE) },
      nowIso: NOW,
    });
    expect(res).toMatchObject({ ok: true, unchanged: true });
    expect(await backlinks(ws.id, "Target.md")).toEqual(["src.md"]);
  });

  it("marks an unreadable note unscanned, so indexing can finish, and retries it later", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    await put(ws.id, "broken.md", "[[Target]]");
    await corrupt(ws.id, "broken.md");
    await db.fileLinks.deleteMany({ where: { workspaceId: ws.id } });
    expect(await catchUpLinkIndex(ws.id)).toBe(true);
    expect(await catchUpLinkIndex(ws.id)).toBe(true);
    const row = await db.fileLinks.findUniqueOrThrow({
      where: { workspaceId_sourcePath: { workspaceId: ws.id, sourcePath: "broken.md" } },
    });
    expect(row).toMatchObject({ scanned: false, targets: [] });

    // Readable again (the same flip undoes it), and the retry delay has passed.
    await corrupt(ws.id, "broken.md");
    await db.$executeRaw`
      UPDATE file_links SET "updatedAt" = now() - interval '11 minutes'
      WHERE "workspaceId" = ${ws.id}`;
    expect(await backlinks(ws.id, "Target.md")).toEqual(["broken.md"]);
  });

  it("finishes indexing when .md files are stored as plain text", async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 3; i++) {
      const res = await svc.write({
        workspaceId: ws.id,
        path: `plain${i}.md`,
        body: enc(`[[x${i}]]`),
        contentType: "text/plain",
        actor: { principal: "human", actorId: ALICE, access: asMember(ALICE) },
        nowIso: NOW,
      });
      expect(res.ok).toBe(true);
    }
    await db.fileLinks.deleteMany({ where: { workspaceId: ws.id } });
    // One file per pass: three passes and it's done, rather than reselecting forever.
    for (let i = 0; i < 3; i++) await catchUpLinkIndex(ws.id, 1);
    expect(await catchUpLinkIndex(ws.id, 1)).toBe(true);
  });

  it("indexes a note brought back by recovery straight away", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    await put(ws.id, "src.md", "[[Target]]");
    const { contentHash } = await db.fileNode.findUniqueOrThrow({
      where: { workspaceId_path: { workspaceId: ws.id, path: "src.md" } },
    });
    const actor = { principal: "human" as const, actorId: ALICE, access: asMember(ALICE) };
    await svc.remove({ workspaceId: ws.id, path: "src.md", baseVersion: 1, actor });
    const res = await svc.restoreContent({
      workspaceId: ws.id,
      path: "src.md",
      contentHash,
      expect: "absent",
      actor,
    });
    expect(res.status).toBe("ok");
    const row = await db.fileLinks.findUnique({
      where: { workspaceId_sourcePath: { workspaceId: ws.id, sourcePath: "src.md" } },
    });
    expect(row?.contentHash).toBe(contentHash);
  });

  it("stores link targets hashed, never as written", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "See [[Secret Project Name]] and [x](plans/launch.md)");
    const row = await db.fileLinks.findUniqueOrThrow({
      where: { workspaceId_sourcePath: { workspaceId: ws.id, sourcePath: "a.md" } },
    });
    expect(row.targets).toHaveLength(2);
    expect(JSON.stringify(row)).not.toMatch(/secret|launch/i);
  });

  it("follows edits, deletes and moves of the linking note", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    const v = await put(ws.id, "src.md", "[[Target]]");
    expect(await backlinks(ws.id, "Target.md")).toEqual(["src.md"]);

    await put(ws.id, "src.md", "no longer linking");
    expect(await backlinks(ws.id, "Target.md")).toEqual([]);

    await put(ws.id, "src.md", "[up](../Target.md) reaches nothing from the root");
    expect(await backlinks(ws.id, "Target.md")).toEqual([]);
    // Moving the source down a folder makes its relative link resolve.
    await svc.move({
      workspaceId: ws.id,
      from: "src.md",
      to: "sub/src.md",
      actor: { principal: "human", actorId: ALICE, access: asMember(ALICE) },
    });
    expect(await backlinks(ws.id, "Target.md")).toEqual(["sub/src.md"]);

    const cur = await svc.stat(ws.id, "sub/src.md", "trusted");
    await svc.remove({
      workspaceId: ws.id,
      path: "sub/src.md",
      baseVersion: cur!.version,
      actor: { principal: "human", actorId: ALICE, access: asMember(ALICE) },
    });
    expect(await backlinks(ws.id, "Target.md")).toEqual([]);
    expect(v).toBe(1);
  });

  it("only counts a name match when the name resolves to this file", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Plan.md", "root plan");
    await put(ws.id, "deep/Plan.md", "deep plan");
    await put(ws.id, "a.md", "[[Plan]]");
    await put(ws.id, "b.md", "[[deep/Plan]]");
    expect(await backlinks(ws.id, "Plan.md")).toEqual(["a.md"]);
    expect(await backlinks(ws.id, "deep/Plan.md")).toEqual(["b.md"]);
  });

  it("indexes notes written before the index existed, and says when it is done", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    for (let i = 0; i < 5; i++) await put(ws.id, `n${i}.md`, "[[Target]]");
    await db.fileLinks.deleteMany({ where: { workspaceId: ws.id } });

    expect(await catchUpLinkIndex(ws.id, 3)).toBe(false);
    const res = await getLinks({ workspaceId: ws.id, access: asMember(ALICE), path: "Target.md" });
    expect(res).toMatchObject({ complete: true });
    expect(res?.backlinks).toEqual(["n0.md", "n1.md", "n2.md", "n3.md", "n4.md"]);
  });

  it("resolves the note's own links for an agent", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "docs/Guide.md", "g");
    await put(ws.id, "docs/here.md", "[[Guide#Setup|setup]] [[Ghost]] [x](Guide.md) [[#Local]]");
    const res = await getLinks({
      workspaceId: ws.id,
      access: asMember(ALICE),
      path: "docs/here.md",
      outgoing: true,
    });
    expect(res?.outgoing).toEqual([
      { kind: "wikilink", target: "Guide", path: "docs/Guide.md" },
      { kind: "wikilink", target: "Ghost", path: null },
      { kind: "markdown", target: "Guide.md", path: "docs/Guide.md" },
    ]);
  });
});

describe("backlinks respect private files", () => {
  it("never lists a private note to anyone but its owner", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Shared.md", "s");
    await put(ws.id, "bob/diary.md", "Thinking about [[Shared]]", BOB);
    await setNodePrivate({ workspaceId: ws.id, path: "bob", kind: "folder", ownerId: BOB });

    expect(await backlinks(ws.id, "Shared.md", ALICE)).toEqual([]);
    expect(await backlinks(ws.id, "Shared.md", BOB)).toEqual(["bob/diary.md"]);
  });

  it("treats a private target as not found", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "bob/secret.md", "s", BOB);
    await setNodePrivate({ workspaceId: ws.id, path: "bob/secret.md", kind: "file", ownerId: BOB });
    expect(
      await getLinks({ workspaceId: ws.id, access: asMember(ALICE), path: "bob/secret.md" }),
    ).toBeNull();
  });

  it("doesn't let a hidden same-named note change what a link reaches", async () => {
    // Bob's private Plan.md is shallower, so for Bob [[Plan]] reaches it. Alice
    // can't see it, so for her the same link reaches deep/Plan.md — and the
    // backlink she sees must follow her view, or its absence would reveal Bob's.
    const ws = await freshWorkspace();
    await put(ws.id, "deep/Plan.md", "p");
    await put(ws.id, "Plan.md", "bob's", BOB);
    await setNodePrivate({ workspaceId: ws.id, path: "Plan.md", kind: "file", ownerId: BOB });
    await put(ws.id, "notes.md", "[[Plan]]");

    expect(await backlinks(ws.id, "deep/Plan.md", ALICE)).toEqual(["notes.md"]);
    expect(await backlinks(ws.id, "deep/Plan.md", BOB)).toEqual([]);
    expect(await backlinks(ws.id, "Plan.md", BOB)).toEqual(["notes.md"]);
  });
});

describe("moveWithLinks", () => {
  const actor = { principal: "human" as const, actorId: ALICE, access: asMember(ALICE) };

  it("rewrites links in linking notes and in the moved note, attributed to the mover", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "notes/Old Name.md", "Self: [[Old Name#Top]]. Sibling: [o](Other.md).");
    await put(ws.id, "notes/Other.md", "See [[Old Name|the doc]] and [it](Old%20Name.md#part).");
    await put(ws.id, "index.md", "- [[notes/Old Name]]\n- [[Other]]");

    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "notes/Old Name.md",
      to: "archive/New Name.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({ status: "ok", version: 2 });
    expect(res.links?.updated.sort()).toEqual([
      "archive/New Name.md",
      "index.md",
      "notes/Other.md",
    ]);
    expect(res.links?.failed).toEqual([]);

    expect(await text(ws.id, "archive/New Name.md")).toBe(
      "Self: [[New Name#Top]]. Sibling: [o](../notes/Other.md).",
    );
    expect(await text(ws.id, "notes/Other.md")).toBe(
      "See [[New Name|the doc]] and [it](../archive/New%20Name.md#part).",
    );
    expect(await text(ws.id, "index.md")).toBe("- [[New Name]]\n- [[Other]]");

    const writes = await db.changeEvent.findMany({
      where: { workspaceId: ws.id, path: "index.md", op: "write" },
      orderBy: { seq: "asc" },
    });
    expect(writes.at(-1)).toMatchObject({ actorId: ALICE, version: 2 });
    expect(await backlinks(ws.id, "archive/New Name.md")).toEqual(["index.md", "notes/Other.md"]);
  });

  it("leaves notes alone when the move doesn't break their links", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a/Plan.md", "p");
    await put(ws.id, "index.md", "[[Plan]]");
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "a/Plan.md",
      to: "b/Plan.md",
      actor,
      updateLinks: true,
    });
    expect(res.links).toEqual({ updated: [], failed: [] });
    expect((await svc.stat(ws.id, "index.md", "trusted"))?.version).toBe(1);
  });

  it("does not touch notes the mover can't read", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "bob/mine.md", "[[Doc]]", BOB);
    await setNodePrivate({ workspaceId: ws.id, path: "bob", kind: "folder", ownerId: BOB });
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res.links).toEqual({ updated: [], failed: [] });
    expect(await text(ws.id, "bob/mine.md")).toBe("[[Doc]]");
  });

  it("only moves when updateLinks is off", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "src.md", "[[Doc]]");
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: false,
    });
    expect(res).toEqual({ status: "ok", version: 1 });
    expect(await text(ws.id, "src.md")).toBe("[[Doc]]");
  });

  it("refuses to rename while notes are still unindexed, and moves nothing", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    for (let i = 0; i < 3; i++) await put(ws.id, `n${i}.md`, "[[Doc]]");
    await db.fileLinks.deleteMany({ where: { workspaceId: ws.id } });

    const tight = { ms: 0, batch: 1 };
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
      indexBudget: tight,
    });
    expect(res).toEqual({ status: "links_pending" });
    expect(await svc.stat(ws.id, "Doc.md", "trusted")).not.toBeNull();

    // Each attempt indexes more, so retrying gets there, and no link is lost.
    let retry = res;
    for (let i = 0; i < 5 && retry.status === "links_pending"; i++) {
      retry = await moveWithLinks({
        workspaceId: ws.id,
        from: "Doc.md",
        to: "Renamed.md",
        actor,
        updateLinks: true,
        indexBudget: tight,
      });
    }
    expect(retry).toMatchObject({ status: "ok", links: { failed: [] } });
    for (let i = 0; i < 3; i++) expect(await text(ws.id, `n${i}.md`)).toBe("[[Renamed]]");
  });

  it("keeps going, and reports the note, when one can't be read", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    // Distinct contents: blobs are content-addressed, so equal notes share one.
    await put(ws.id, "a.md", "a [[Doc]]");
    await put(ws.id, "b.md", "b [[Doc]]");
    await put(ws.id, "c.md", "c [[Doc]]");
    await corrupt(ws.id, "b.md");

    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({
      status: "ok",
      links: { updated: ["a.md", "c.md"], failed: ["b.md"] },
    });
    expect(await text(ws.id, "c.md")).toBe("c [[Renamed]]");
  });

  it("reports notes it couldn't check, but only ones the mover can read", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "a.md", "a [[Doc]]");
    await put(ws.id, "unknown.md", "u [[Doc]]");
    await put(ws.id, "hidden.md", "h [[Doc]]", BOB);
    await setNodePrivate({ workspaceId: ws.id, path: "hidden.md", kind: "file", ownerId: BOB });
    await db.fileLinks.updateMany({
      where: { workspaceId: ws.id, sourcePath: { in: ["unknown.md", "hidden.md"] } },
      data: { scanned: false, targets: [] },
    });

    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({
      status: "ok",
      links: { updated: ["a.md"], failed: ["unknown.md"] },
    });
  });

  it("never writes a private file's new name into a note others can read", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "deep/Plan.md", "Bob's plan");
    await put(ws.id, "Plan.md", "Alice's private plan");
    await setNodePrivate({ workspaceId: ws.id, path: "Plan.md", kind: "file", ownerId: ALICE });
    await put(ws.id, "notes.md", "See [[Plan]]");
    await put(ws.id, "mine.md", "My [[Plan]]");
    await setNodePrivate({ workspaceId: ws.id, path: "mine.md", kind: "file", ownerId: ALICE });

    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Plan.md",
      to: "Secret acquisition.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({ status: "ok", links: { failed: ["notes.md"] } });
    expect(await text(ws.id, "notes.md")).toBe("See [[Plan]]");
    // Alice's own private note follows the file.
    expect(await text(ws.id, "mine.md")).toBe("My [[Secret acquisition]]");
    expect(await backlinks(ws.id, "deep/Plan.md", BOB)).toEqual(["notes.md"]);
  });

  it("still rewrites shared notes for a shared file", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "a.md", "[[Doc]]");
    await put(ws.id, "secret.md", "s");
    await setNodePrivate({ workspaceId: ws.id, path: "secret.md", kind: "file", ownerId: ALICE });
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({ status: "ok", links: { updated: ["a.md"], failed: [] } });
  });

  it("doesn't rename while a note couldn't be written to the index", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "a.md", "[[Doc]]");
    await db.fileLinks.deleteMany({ where: { workspaceId: ws.id } });
    const down = vi.spyOn(db, "$executeRaw").mockRejectedValue(new Error("database down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
      indexBudget: { ms: 0, batch: 10 },
    });
    down.mockRestore();
    quiet.mockRestore();
    expect(res).toEqual({ status: "links_pending" });
    expect(await svc.stat(ws.id, "Doc.md", "trusted")).not.toBeNull();
  });

  it("judges a note by its own record, not the blob it shares with another file", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Target.md", "t");
    await put(ws.id, "source.md", "[[Target]]");
    // Identical bytes share a blob, and this write changes that blob's type.
    await svc.write({
      workspaceId: ws.id,
      path: "source.txt",
      body: enc("[[Target]]"),
      contentType: "text/plain",
      actor,
      nowIso: NOW,
    });
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Target.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({ status: "ok", links: { updated: ["source.md"], failed: [] } });
    expect(await text(ws.id, "source.md")).toBe("[[Renamed]]");
    expect((await svc.stat(ws.id, "source.md", "trusted"))?.contentType).toMatch(/^text\/markdown/);
  });

  it("doesn't read a moved file that can't hold links", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "video.mp4",
      body: enc("not really a video"),
      contentType: "video/mp4",
      actor,
      nowIso: NOW,
    });
    const reads = vi.spyOn(useBlobStore(), "get");
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "video.mp4",
      to: "clip.mp4",
      actor,
      updateLinks: true,
    });
    const reached = reads.mock.calls.length;
    reads.mockRestore();
    expect(res).toMatchObject({ status: "ok", links: { failed: [] } });
    expect(reached).toBe(0);
  });

  it("reports a moved note too big to scan, without reading it", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "big.md", "x".repeat(2 * 1024 * 1024 + 1));
    const reads = vi.spyOn(useBlobStore(), "get");
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "big.md",
      to: "huge.md",
      actor,
      updateLinks: true,
    });
    const reached = reads.mock.calls.length;
    reads.mockRestore();
    expect(res).toMatchObject({ status: "ok", links: { failed: ["huge.md"] } });
    expect(reached).toBe(0);
  });

  it("reports a note its scan couldn't finish, not trusting the partial result", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "hostile.md", `${"[".repeat(200_000)}\n\n[[Doc]]`);
    const row = await db.fileLinks.findUniqueOrThrow({
      where: { workspaceId_sourcePath: { workspaceId: ws.id, sourcePath: "hostile.md" } },
    });
    expect(row.scanned).toBe(false);

    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res).toMatchObject({ status: "ok", links: { failed: ["hostile.md"] } });
  });

  it("reports a link the new name can't be written into", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    await put(ws.id, "src.md", "[[Doc]] and [md](Doc.md)");
    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Doc #2.md",
      actor,
      updateLinks: true,
    });
    expect(res.links).toEqual({ updated: ["src.md"], failed: ["src.md"] });
    expect(await text(ws.id, "src.md")).toBe("[[Doc]] and [md](Doc%20%232.md)");
  });

  it("keeps bytes it can't decode exactly as they were", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "Doc.md", "d");
    const bom = "﻿[[Doc]]\r\nline two";
    await put(ws.id, "bom.md", bom);
    const latin1 = new Uint8Array([...enc("[[Doc]] caf"), 0xe9]);
    await svc.write({ workspaceId: ws.id, path: "latin1.md", body: latin1, actor, nowIso: NOW });

    const res = await moveWithLinks({
      workspaceId: ws.id,
      from: "Doc.md",
      to: "Renamed.md",
      actor,
      updateLinks: true,
    });
    expect(res.links?.updated).toEqual(["bom.md"]);
    expect(res.links?.failed).toEqual(["latin1.md"]);
    expect(await text(ws.id, "bom.md")).toBe("﻿[[Renamed]]\r\nline two");
    const raw = await svc.read(ws.id, "latin1.md", "trusted");
    expect(raw.status === "ok" && [...raw.body]).toEqual([...latin1]);
  });
});

describe("write ifStale: fail", () => {
  it("writes nothing and keeps no conflicted copy", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "x.md", "one");
    await put(ws.id, "x.md", "two");
    const res = await svc.write({
      workspaceId: ws.id,
      path: "x.md",
      body: enc("stale"),
      baseVersion: 1,
      actor: { principal: "human", actorId: ALICE, access: asMember(ALICE) },
      nowIso: NOW,
      ifStale: "fail",
    });
    expect(res).toEqual({ ok: false, stale: true });
    expect(await text(ws.id, "x.md")).toBe("two");
    expect((await svc.list(ws.id, "", "trusted")).map((e) => e.path)).toEqual(["x.md"]);
  });
});