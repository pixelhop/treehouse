import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

// The file service's partial edit (`edit()`, behind the edit_file MCP tool).
// Local fs storage; never R2 (see useTempBlobDir).
useTempBlobDir("treehouse-edit-");

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { setNodePrivate } = await import("../server/utils/acl");

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-10-29T12:00:00.000Z";
const AGENT = {
  principal: "agent" as const,
  actorId: "user-agent",
  access: asMember("user-agent"),
};
const HUMAN = {
  principal: "human" as const,
  actorId: "user-human",
  access: asMember("user-human"),
};

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function wsWithFile(path: string, content: string | Uint8Array) {
  const org = await db.organization.create({
    data: { id: `org_edit_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const body = typeof content === "string" ? enc(content) : content;
  await svc.write({ workspaceId: ws.id, path, body, actor: HUMAN, nowIso: NOW });
  return ws.id;
}

async function text(workspaceId: string, path: string) {
  const r = await svc.read(workspaceId, path, "trusted");
  if (r.status !== "ok") throw new Error(`read ${path}: ${r.status}`);
  return { text: dec(r.body), version: r.version };
}

const edit = (
  workspaceId: string,
  path: string,
  baseVersion: number,
  edits: { oldString: string; newString: string; replaceAll?: boolean }[],
) => svc.edit({ workspaceId, path, edits, baseVersion, actor: AGENT, nowIso: NOW });

describe("file service edit()", () => {
  it("applies an edit as a new version, attributed like any write", async () => {
    const ws = await wsWithFile("notes.md", "# Notes\n\nStatus: draft\n");
    const res = await edit(ws, "notes.md", 1, [{ oldString: "draft", newString: "final" }]);
    expect(res).toMatchObject({ status: "applied", appliedTo: 1, replacements: 1 });
    if (res.status === "applied") expect(res.write).toMatchObject({ ok: true, version: 2 });
    expect(await text(ws, "notes.md")).toEqual({ text: "# Notes\n\nStatus: final\n", version: 2 });

    const last = await db.changeEvent.findFirst({
      where: { workspaceId: ws, path: "notes.md" },
      orderBy: { seq: "desc" },
    });
    expect(last).toMatchObject({ op: "write", version: 2, principal: "agent" });
  });

  it("reports a missing oldString and writes nothing", async () => {
    const ws = await wsWithFile("a.md", "hello");
    const res = await edit(ws, "a.md", 1, [{ oldString: "goodbye", newString: "x" }]);
    expect(res).toEqual({
      status: "edit_failed",
      failure: { ok: false, reason: "not_found", index: 0 },
      currentVersion: 1,
    });
    expect(await text(ws, "a.md")).toEqual({ text: "hello", version: 1 });
  });

  it("refuses an ambiguous oldString unless replaceAll is set", async () => {
    const ws = await wsWithFile("todo.md", "- [ ] a\n- [ ] b\n");
    const ambiguous = await edit(ws, "todo.md", 1, [{ oldString: "- [ ]", newString: "- [x]" }]);
    expect(ambiguous).toMatchObject({
      status: "edit_failed",
      failure: { reason: "ambiguous", matches: 2 },
      currentVersion: 1,
    });

    const all = await edit(ws, "todo.md", 1, [
      { oldString: "- [ ]", newString: "- [x]", replaceAll: true },
    ]);
    expect(all).toMatchObject({ status: "applied", replacements: 2 });
    expect((await text(ws, "todo.md")).text).toBe("- [x] a\n- [x] b\n");
  });

  it("applies several edits atomically: one miss and none land", async () => {
    const ws = await wsWithFile("m.md", "one two three");
    const miss = await edit(ws, "m.md", 1, [
      { oldString: "one", newString: "1" },
      { oldString: "four", newString: "4" },
    ]);
    expect(miss).toMatchObject({ status: "edit_failed", failure: { index: 1 } });
    expect(await text(ws, "m.md")).toEqual({ text: "one two three", version: 1 });

    const hit = await edit(ws, "m.md", 1, [
      { oldString: "one", newString: "1" },
      { oldString: "three", newString: "3" },
    ]);
    expect(hit).toMatchObject({ status: "applied", replacements: 2 });
    expect(await text(ws, "m.md")).toEqual({ text: "1 two 3", version: 2 });
  });

  it("stale base, targeted text unchanged: rebases onto the head (no conflicted copy)", async () => {
    const ws = await wsWithFile("doc.md", "Intro.\n\nBody: old.\n");
    // A person edits a different part of the file: v1 -> v2.
    await svc.write({
      workspaceId: ws,
      path: "doc.md",
      body: enc("Intro, revised.\n\nBody: old.\n"),
      baseVersion: 1,
      actor: HUMAN,
      nowIso: NOW,
    });

    const res = await edit(ws, "doc.md", 1, [{ oldString: "Body: old.", newString: "Body: new." }]);
    expect(res).toMatchObject({ status: "applied", appliedTo: 2 });
    if (res.status === "applied") expect(res.write).toMatchObject({ ok: true, version: 3 });
    // Both changes survive.
    expect(await text(ws, "doc.md")).toEqual({
      text: "Intro, revised.\n\nBody: new.\n",
      version: 3,
    });
    const copies = await db.fileNode.count({
      where: { workspaceId: ws, path: { contains: "conflicted copy" } },
    });
    expect(copies).toBe(0);
  });

  it("stale base, targeted text changed: keeps the edit as a conflicted copy", async () => {
    const ws = await wsWithFile("doc.md", "Status: draft\n");
    await svc.write({
      workspaceId: ws,
      path: "doc.md",
      body: enc("Status: in review\n"),
      baseVersion: 1,
      actor: HUMAN,
      nowIso: NOW,
    });

    const res = await edit(ws, "doc.md", 1, [{ oldString: "draft", newString: "final" }]);
    expect(res).toMatchObject({ status: "applied", appliedTo: 1 });
    if (res.status !== "applied") throw new Error("expected applied");
    expect(res.write.ok).toBe(false);
    expect(res.write.conflict?.currentVersion).toBe(2);
    const copyPath = res.write.conflict?.conflictCopyPath ?? "";
    expect(copyPath).toContain("conflicted copy");
    // The person's version is untouched; the agent's edit, applied to the
    // version it read, is in the copy.
    expect(await text(ws, "doc.md")).toEqual({ text: "Status: in review\n", version: 2 });
    expect((await text(ws, copyPath)).text).toBe("Status: final\n");
  });

  it("stale base where the edit never applied: refused against the current version", async () => {
    const ws = await wsWithFile("doc.md", "alpha\n");
    await svc.write({
      workspaceId: ws,
      path: "doc.md",
      body: enc("beta\n"),
      baseVersion: 1,
      actor: HUMAN,
      nowIso: NOW,
    });
    const res = await edit(ws, "doc.md", 1, [{ oldString: "gamma", newString: "x" }]);
    expect(res).toMatchObject({
      status: "edit_failed",
      failure: { reason: "not_found" },
      currentVersion: 2,
    });
    expect(await db.fileNode.count({ where: { workspaceId: ws } })).toBe(1);
  });

  it("a retried edit that already landed is not applied twice", async () => {
    const ws = await wsWithFile("team.md", "Owner: Sam\n");
    // newString contains oldString, so a naive rebase would match again.
    const insert = [{ oldString: "Owner: Sam", newString: "Owner: Sam and Alex" }];
    const first = await edit(ws, "team.md", 1, insert);
    if (first.status === "applied") expect(first.write).toMatchObject({ ok: true, version: 2 });

    // The reply was lost; the agent retries with the version it read.
    const retry = await edit(ws, "team.md", 1, insert);
    expect(retry).toMatchObject({ status: "applied", write: { ok: true, version: 2 } });
    expect(await text(ws, "team.md")).toEqual({ text: "Owner: Sam and Alex\n", version: 2 });
  });

  it("a retry of an edit that was rebased is not applied twice either", async () => {
    const ws = await wsWithFile("team.md", "Intro\nOwner: Sam\n");
    // A person changes only the intro: v1 -> v2.
    await svc.write({
      workspaceId: ws,
      path: "team.md",
      body: enc("Intro, revised\nOwner: Sam\n"),
      baseVersion: 1,
      actor: HUMAN,
      nowIso: NOW,
    });
    const insert = [{ oldString: "Owner: Sam", newString: "Owner: Sam and Alex" }];
    const first = await edit(ws, "team.md", 1, insert);
    expect(first).toMatchObject({ status: "applied", appliedTo: 2 });

    // The reply was lost; the agent retries with the version it read (1). It
    // is recognised, and still reports the rebase onto v2.
    const retry = await edit(ws, "team.md", 1, insert);
    expect(retry).toMatchObject({
      status: "applied",
      appliedTo: 2,
      write: { ok: true, version: 3 },
    });
    expect(await text(ws, "team.md")).toEqual({
      text: "Intro, revised\nOwner: Sam and Alex\n",
      version: 3,
    });
  });

  it("a retry that can't be checked against the actor's own write is refused", async () => {
    // A conflicted copy's version 1 is recorded without a content pointer.
    const ws = await wsWithFile("team.md", "Owner: Sam\n");
    await svc.write({
      workspaceId: ws,
      path: "team.md",
      body: enc("Owner: Robin\n"),
      baseVersion: 1,
      actor: HUMAN,
      nowIso: NOW,
    });
    const stale = await svc.write({
      workspaceId: ws,
      path: "team.md",
      body: enc("Owner: Sam\nNote\n"),
      baseVersion: 1,
      actor: AGENT,
      nowIso: NOW,
    });
    const copy = stale.conflict?.conflictCopyPath ?? "";
    expect(copy).toContain("conflicted copy");

    const insert = [{ oldString: "Owner: Sam", newString: "Owner: Sam and Alex" }];
    expect(await edit(ws, copy, 1, insert)).toMatchObject({
      status: "applied",
      write: { ok: true, version: 2 },
    });
    // The agent's own v2 can't be checked (v1 of a copy has no stored
    // content), so the retry is refused rather than risked twice.
    expect(await edit(ws, copy, 1, insert)).toEqual({
      status: "unverifiable",
      currentVersion: 2,
    });
    expect(await text(ws, copy)).toEqual({ text: "Owner: Sam and Alex\nNote\n", version: 2 });
  });

  it("a file deleted since it was read is not found, and not recreated", async () => {
    const ws = await wsWithFile("team.md", "Owner: Sam\n");
    await svc.remove({ workspaceId: ws, path: "team.md", baseVersion: 1, actor: HUMAN });
    const insert = [{ oldString: "Owner: Sam", newString: "Owner: Sam and Alex" }];
    // Recreating it at version 1 would make a retry of this edit look current
    // and apply it twice; it is refused every time instead.
    expect(await edit(ws, "team.md", 1, insert)).toEqual({ status: "not_found" });
    expect(await edit(ws, "team.md", 1, insert)).toEqual({ status: "not_found" });
    expect((await svc.read(ws, "team.md", "trusted")).status).toBe("not_found");
  });

  it("a retry is recognised even after someone else has written since", async () => {
    const ws = await wsWithFile("team.md", "Intro\nOwner: Sam\n");
    const insert = [{ oldString: "Owner: Sam", newString: "Owner: Sam and Alex" }];
    expect(await edit(ws, "team.md", 1, insert)).toMatchObject({
      status: "applied",
      write: { version: 2 },
    });
    // The reply was lost, and a person edits the intro before the retry.
    await svc.write({
      workspaceId: ws,
      path: "team.md",
      body: enc("Intro, revised\nOwner: Sam and Alex\n"),
      baseVersion: 2,
      actor: HUMAN,
      nowIso: NOW,
    });
    const retry = await edit(ws, "team.md", 1, insert);
    expect(retry).toMatchObject({
      status: "applied",
      appliedTo: 1,
      write: { ok: true, version: 3 },
    });
    expect(await text(ws, "team.md")).toEqual({
      text: "Intro, revised\nOwner: Sam and Alex\n",
      version: 3,
    });
  });

  it("someone else's identical-looking edit is not mistaken for this caller's retry", async () => {
    const ws = await wsWithFile("team.md", "Intro\nOwner: Sam\n");
    const insert = [{ oldString: "Owner: Sam", newString: "Owner: Sam and Alex" }];
    // A person makes the same change, then edits the intro.
    await svc.write({
      workspaceId: ws,
      path: "team.md",
      body: enc("Intro\nOwner: Sam and Alex\n"),
      baseVersion: 1,
      actor: HUMAN,
      nowIso: NOW,
    });
    await svc.write({
      workspaceId: ws,
      path: "team.md",
      body: enc("Intro, revised\nOwner: Sam and Alex\n"),
      baseVersion: 2,
      actor: HUMAN,
      nowIso: NOW,
    });
    // Not the agent's own write, so its stale edit is a fresh one and rebases
    // (what the agent asked for, applied to what's there now).
    expect(await edit(ws, "team.md", 1, insert)).toMatchObject({
      status: "applied",
      appliedTo: 3,
    });
  });

  it("an edit losing to a delete mid-flight never recreates the file", async () => {
    const ws = await wsWithFile("gone.md", "Owner: Sam\n");
    await svc.remove({ workspaceId: ws, path: "gone.md", baseVersion: 1, actor: HUMAN });
    // What edit() commits with: an update-only write against the version it read.
    const res = await svc.write({
      workspaceId: ws,
      path: "gone.md",
      body: enc("Owner: Sam and Alex\n"),
      baseVersion: 1,
      updateOnly: true,
      actor: AGENT,
      nowIso: NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.conflict?.conflictCopyPath).toContain("conflicted copy");
    expect((await svc.read(ws, "gone.md", "trusted")).status).toBe("not_found");
  });

  it("keeps the stored content type of the file it edits", async () => {
    const org = await db.organization.create({
      data: { id: `org_edit_ct_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
    });
    const { id: ws } = await db.workspace.create({
      data: { organizationId: org.id, name: "Default" },
    });
    await svc.write({
      workspaceId: ws,
      path: "README",
      body: enc("Hello world\n"),
      contentType: "text/plain",
      actor: HUMAN,
      nowIso: NOW,
    });
    await edit(ws, "README", 1, [{ oldString: "world", newString: "there" }]);
    expect(await svc.stat(ws, "README", "trusted")).toMatchObject({
      version: 2,
      contentType: "text/plain",
    });
  });

  it("a deliberate repeat against the current version still applies", async () => {
    const ws = await wsWithFile("log.md", "x");
    const append = [{ oldString: "x", newString: "xx" }];
    await edit(ws, "log.md", 1, append);
    // Current base, so not a retry: the caller means it again.
    const again = await edit(ws, "log.md", 2, [{ oldString: "xx", newString: "xxx" }]);
    expect(again).toMatchObject({ status: "applied", write: { version: 3 } });
    expect((await text(ws, "log.md")).text).toBe("xxx");
  });

  it("refuses an edit that would outgrow the per-file limit, before building it", async () => {
    const ws = await wsWithFile("grow.md", "a");
    const original = process.env.MAX_FILE_BYTES;
    process.env.MAX_FILE_BYTES = "64";
    try {
      const doubling = Array.from({ length: 28 }, () => ({
        oldString: "a",
        newString: "aa",
        replaceAll: true,
      }));
      const res = await edit(ws, "grow.md", 1, doubling);
      expect(res).toMatchObject({
        status: "edit_failed",
        failure: { reason: "too_large", index: 6, limit: 64 },
        currentVersion: 1,
      });
    } finally {
      if (original === undefined) delete process.env.MAX_FILE_BYTES;
      else process.env.MAX_FILE_BYTES = original;
    }
    expect(await text(ws, "grow.md")).toEqual({ text: "a", version: 1 });
  });

  it("rejects a binary file without touching it", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const ws = await wsWithFile("logo.png", png);
    const res = await edit(ws, "logo.png", 1, [{ oldString: "PNG", newString: "JPG" }]);
    expect(res).toEqual({ status: "binary" });
    expect((await text(ws, "logo.png")).version).toBe(1);
  });

  it("an unknown path is not_found", async () => {
    const ws = await wsWithFile("a.md", "x");
    expect(await edit(ws, "nope.md", 1, [{ oldString: "x", newString: "y" }])).toEqual({
      status: "not_found",
    });
  });

  it("a private file someone else owns is not_found, and untouched", async () => {
    const ws = await wsWithFile("journal/today.md", "secret");
    await setNodePrivate({
      workspaceId: ws,
      path: "journal",
      kind: "folder",
      ownerId: HUMAN.actorId,
    });
    expect(
      await edit(ws, "journal/today.md", 1, [{ oldString: "secret", newString: "leaked" }]),
    ).toEqual({ status: "not_found" });
    expect((await text(ws, "journal/today.md")).text).toBe("secret");
  });
});