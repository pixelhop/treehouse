import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

useTempBlobDir("treehouse-recovery-");

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
type Actor = import("../server/utils/files").Actor;
const {
  setNodeAccess,
  setNodePrivate,
  clearNodePrivate,
  moveFolderMetadata,
  listWorkspaceAcls,
  canRead,
  canWrite,
} = await import("../server/utils/acl");
const { recoveryActionKey } = await import("shared");
const { useBlobStore } = await import("../server/utils/storage");
const { feedEvent } = await import("../server/utils/change-feed");
const {
  listTrash,
  planPointInTime,
  planTrashRestore,
  applyPlan,
  fitToLimits,
  onlyApproved,
  previewOf,
  privateOwnerAt,
} = await import("../server/utils/recovery");

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-10-29T00:00:00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const alice = {
  principal: "human" as const,
  actorId: "alice",
  access: asMember("alice"),
};
const bob = {
  principal: "human" as const,
  actorId: "bob",
  access: asMember("bob"),
};
const agent = {
  principal: "agent" as const,
  actorId: "alice",
  access: asMember("alice"),
  actorKeyId: "key_1",
  actorLabel: "Claude Code",
};

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

async function put(workspaceId: string, path: string, body: string, actor: Actor = alice) {
  const head = await svc.stat(workspaceId, path, "trusted");
  const res = await svc.write({
    workspaceId,
    path,
    body: enc(body),
    baseVersion: head?.version,
    actor,
    nowIso: NOW,
  });
  expect(res.ok).toBe(true);
  return res.version!;
}

async function del(workspaceId: string, path: string, actor: Actor = alice) {
  const head = await svc.stat(workspaceId, path, "trusted");
  const res = await svc.remove({ workspaceId, path, baseVersion: head!.version, actor });
  expect(res.status).toBe("ok");
}

async function restoreFromTrash(
  workspaceId: string,
  userId: string,
  paths: string[],
  actor: Actor = alice,
) {
  const plan = await fitToLimits(
    workspaceId,
    await planTrashRestore({ workspaceId, subject: asMember(userId), paths }),
  );
  return applyPlan({ workspaceId, plan, actor, meta: { kind: "trash" } });
}

afterEach(() => {
  delete process.env.DEFAULT_WORKSPACE_FILE_LIMIT;
  delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
});

describe("move pairing", () => {
  it("records each end of a move on the other's event", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "hi");
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "b.md", actor: alice });
    const events = await db.changeEvent.findMany({
      where: { workspaceId: ws.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => [e.op, e.path, e.relatedPath])).toEqual([
      ["write", "a.md", null],
      ["delete", "a.md", "b.md"],
      ["move", "b.md", "a.md"],
    ]);
  });
});

describe("move pairing backfill", () => {
  it("pairs moves recorded before the column existed", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "hi");
    await put(ws.id, "x.md", "x");
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "b.md", actor: agent });
    await del(ws.id, "x.md");
    // Two moves of identical content by one actor, interleaved within the same
    // moment: which delete belongs to which move can't be told, so neither is
    // paired rather than risk recording the wrong lineage.
    const same = new Date("2026-01-01T00:00:00.000Z");
    const ev = (path: string, op: string, contentHash: string | null) => ({
      workspaceId: ws.id,
      path,
      op,
      version: 1,
      principal: "agent",
      actorId: "alice",
      contentHash,
      createdAt: same,
    });
    await db.changeEvent.createMany({
      data: [ev("p.md", "write", "same"), ev("q.md", "write", "same")].map((e) => ({
        ...e,
        createdAt: new Date("2025-12-31T00:00:00.000Z"),
      })),
    });
    await db.changeEvent.createMany({
      data: [ev("q.md", "delete", null), ev("p.md", "delete", null)],
    });
    await db.changeEvent.createMany({
      data: [ev("q2.md", "move", "same"), ev("p2.md", "move", "same")],
    });
    // A move whose real source never recorded its content (a/.keep, from
    // before content pointers), next to a deletion of the same bytes that did:
    // b/.keep must not be taken for the move's source and hidden.
    const later = new Date("2026-01-02T00:00:00.000Z");
    await db.changeEvent.createMany({
      data: [ev("a/.keep", "write", null), ev("b/.keep", "write", "empty")].map((e) => ({
        ...e,
        createdAt: new Date("2025-12-31T00:00:00.000Z"),
      })),
    });
    await db.changeEvent.createMany({
      data: [ev("b/.keep", "delete", null), ev("a/.keep", "delete", null)].map((e) => ({
        ...e,
        createdAt: later,
      })),
    });
    await db.changeEvent.create({ data: { ...ev("c/.keep", "move", "empty"), createdAt: later } });
    // A move whose real source is far behind it in the feed, because other
    // workspaces wrote in between (seq is global), next to a later deletion
    // of the same bytes by the same actor. Neither may be paired.
    const other = await freshWorkspace();
    const soon = new Date("2026-01-03T00:00:00.000Z");
    await db.changeEvent.createMany({
      data: [ev("x/.keep", "write", "empty"), ev("y/.keep", "write", "empty")].map((e) => ({
        ...e,
        createdAt: new Date("2025-12-31T00:00:00.000Z"),
      })),
    });
    await db.changeEvent.create({ data: { ...ev("x/.keep", "delete", null), createdAt: soon } });
    await db.changeEvent.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        ...ev(`noise-${i}.md`, "write", "n"),
        workspaceId: other.id,
        createdAt: soon,
      })),
    });
    await db.changeEvent.create({ data: { ...ev("y/.keep", "delete", null), createdAt: soon } });
    await db.changeEvent.create({ data: { ...ev("z/.keep", "move", "empty"), createdAt: soon } });
    await db.changeEvent.updateMany({ where: { workspaceId: ws.id }, data: { relatedPath: null } });

    const sql = readFileSync(
      new URL(
        "../../db/prisma/migrations/20261029202445_recovery_operations/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf('CREATE TEMP TABLE "_move_window"'));
    for (const stmt of backfill
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.$executeRawUnsafe(stmt);
    }
    const events = await db.changeEvent.findMany({
      where: { workspaceId: ws.id, op: { in: ["delete", "move"] } },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => [e.op, e.path, e.relatedPath])).toEqual([
      ["delete", "a.md", "b.md"],
      ["move", "b.md", "a.md"],
      ["delete", "x.md", null],
      ["delete", "q.md", null],
      ["delete", "p.md", null],
      ["move", "q2.md", null],
      ["move", "p2.md", null],
      ["delete", "b/.keep", null],
      ["delete", "a/.keep", null],
      ["move", "c/.keep", null],
      ["delete", "x/.keep", null],
      ["delete", "y/.keep", null],
      ["move", "z/.keep", null],
    ]);
  });
});

describe("trash", () => {
  it("lists deleted files, newest first, but not renamed ones", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "notes/one.md", "1");
    await put(ws.id, "notes/two.md", "2");
    await put(ws.id, "moved.md", "m");
    await del(ws.id, "notes/one.md");
    await del(ws.id, "notes/two.md", agent);
    await svc.move({ workspaceId: ws.id, from: "moved.md", to: "elsewhere.md", actor: alice });

    const { items, nextBefore } = await listTrash({
      workspaceId: ws.id,
      subject: asMember("alice"),
    });
    expect(items.map((i) => i.path)).toEqual(["notes/two.md", "notes/one.md"]);
    expect(items[0]).toMatchObject({
      principal: "agent",
      actorLabel: "Claude Code",
      restorable: true,
    });
    expect(nextBefore).toBeNull();
  });

  it("pages, and limits to a folder without matching its siblings", async () => {
    const ws = await freshWorkspace();
    for (const p of ["docs/a.md", "docs/b.md", "docs/c.md", "docs2/x.md"]) {
      await put(ws.id, p, p);
      await del(ws.id, p);
    }
    const first = await listTrash({
      workspaceId: ws.id,
      subject: asMember("alice"),
      prefix: "docs",
      limit: 2,
    });
    expect(first.items.map((i) => i.path)).toEqual(["docs/c.md", "docs/b.md"]);
    const second = await listTrash({
      workspaceId: ws.id,
      subject: asMember("alice"),
      prefix: "docs",
      limit: 2,
      before: first.nextBefore!,
    });
    expect(second.items.map((i) => i.path)).toEqual(["docs/a.md"]);
  });

  it("drops a path once it is recreated, and shows only its latest deletion", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "v1");
    await del(ws.id, "a.md");
    await put(ws.id, "a.md", "again");
    expect((await listTrash({ workspaceId: ws.id, subject: asMember("alice") })).items).toEqual([]);
    await del(ws.id, "a.md");
    const { items } = await listTrash({ workspaceId: ws.id, subject: asMember("alice") });
    expect(items).toHaveLength(1);
  });

  it("restores the content from just before the deletion, as one operation", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "first");
    await put(ws.id, "a.md", "second");
    await put(ws.id, "b.md", "bee");
    await del(ws.id, "a.md");
    await del(ws.id, "b.md");

    const outcome = await restoreFromTrash(ws.id, "alice", ["a.md", "b.md"]);
    expect(outcome.applied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "recreate", path: "a.md" }),
        expect.objectContaining({ kind: "recreate", path: "b.md" }),
      ]),
    );
    expect(outcome.applied).toHaveLength(2);
    expect(outcome.skipped).toEqual([]);
    const read = await svc.read(ws.id, "a.md", "trusted");
    expect(read.status === "ok" && dec(read.body)).toBe("second");

    const events = await db.changeEvent.findMany({
      where: { workspaceId: ws.id, op: "restore" },
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.operationId === outcome.operationId)).toBe(true);
    const op = await db.recoveryOperation.findUnique({ where: { id: outcome.operationId! } });
    expect(op).toMatchObject({ kind: "trash", applied: 2, skipped: 0, failed: 0 });
    expect(op?.completedAt).not.toBeNull();
    expect((await listTrash({ workspaceId: ws.id, subject: asMember("alice") })).items).toEqual([]);
  });

  it("brings back a deleted conflicted copy", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "p.md", "base");
    await put(ws.id, "p.md", "theirs");
    const stale = await svc.write({
      workspaceId: ws.id,
      path: "p.md",
      body: enc("mine"),
      baseVersion: 1,
      actor: alice,
      nowIso: NOW,
    });
    const copy = stale.conflict!.conflictCopyPath;
    await del(ws.id, copy);
    const { items } = await listTrash({ workspaceId: ws.id, subject: asMember("alice") });
    expect(items[0]).toMatchObject({ path: copy, restorable: true });
    await restoreFromTrash(ws.id, "alice", [copy]);
    const read = await svc.read(ws.id, copy, "trusted");
    expect(read.status === "ok" && dec(read.body)).toBe("mine");
  });

  it("reports content that was never recorded as unavailable, and still restores the rest", async () => {
    const ws = await freshWorkspace();
    // An event from before content pointers existed: no hash to restore from.
    await db.changeEvent.createMany({
      data: [
        { workspaceId: ws.id, path: "old.md", op: "write", version: 1, principal: "human" },
        { workspaceId: ws.id, path: "old.md", op: "delete", version: 1, principal: "human" },
      ],
    });
    await put(ws.id, "new.md", "n");
    await del(ws.id, "new.md");
    const { items } = await listTrash({ workspaceId: ws.id, subject: asMember("alice") });
    expect(items.find((i) => i.path === "old.md")?.restorable).toBe(false);

    const outcome = await restoreFromTrash(ws.id, "alice", ["old.md", "new.md", "never.md"]);
    expect(outcome.applied.map((a) => a.path)).toEqual(["new.md"]);
    expect(outcome.skipped).toEqual(
      expect.arrayContaining([
        { path: "old.md", reason: "unavailable" },
        { path: "never.md", reason: "not_in_trash" },
      ]),
    );
  });

  it("skips a path recreated between the plan and the apply", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "old");
    await del(ws.id, "a.md");
    const plan = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["a.md"],
    });
    await put(ws.id, "a.md", "someone else's new file", bob);
    const outcome = await applyPlan({
      workspaceId: ws.id,
      plan,
      actor: alice,
      meta: { kind: "trash" },
    });
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ path: "a.md", reason: "changed" }]);
    const read = await svc.read(ws.id, "a.md", "trusted");
    expect(read.status === "ok" && dec(read.body)).toBe("someone else's new file");
  });

  it("leaves alone a path recreated and deleted again while the apply runs", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "OLD");
    await del(ws.id, "a.md");
    const plan = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["a.md"],
    });
    // Between planning and the write: someone else's NEW, deleted again.
    await put(ws.id, "a.md", "NEW", agent);
    await del(ws.id, "a.md", agent);
    const outcome = await applyPlan({
      workspaceId: ws.id,
      plan,
      actor: alice,
      meta: { kind: "trash" },
    });
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ path: "a.md", reason: "changed" }]);
    expect(await svc.stat(ws.id, "a.md", "trusted")).toBeNull();
  });

  it("applies only what the confirmed preview showed, even if more fits by then", async () => {
    const ws = await freshWorkspace();
    for (const p of ["a.md", "b.md"]) await put(ws.id, p, p);
    for (const p of ["a.md", "b.md"]) await del(ws.id, p);
    await put(ws.id, "live.md", "l");
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "2";
    const plan = () =>
      planTrashRestore({ workspaceId: ws.id, subject: asMember("alice"), paths: ["a.md", "b.md"] });
    const preview = previewOf(await fitToLimits(ws.id, await plan()));
    expect(preview.actions.map((a) => a.path)).toEqual(["a.md"]);
    expect(preview.skipped).toEqual([{ path: "b.md", reason: "file_limit" }]);

    await del(ws.id, "live.md");
    const approved = new Set(preview.actions.map(recoveryActionKey));
    const bound = await fitToLimits(ws.id, onlyApproved(await plan(), approved));
    expect(bound.actions.map((a) => a.path)).toEqual(["a.md"]);
    expect(bound.skipped).toEqual([{ path: "b.md", reason: "not_previewed" }]);
  });

  it("restores what fits under the file limit and reports the rest", async () => {
    const ws = await freshWorkspace();
    for (const p of ["a.md", "b.md", "c.md"]) await put(ws.id, p, p);
    for (const p of ["a.md", "b.md", "c.md"]) await del(ws.id, p);
    await put(ws.id, "keep.md", "k");
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "3";

    const preview = previewOf(
      await fitToLimits(
        ws.id,
        await planTrashRestore({
          workspaceId: ws.id,
          subject: asMember("alice"),
          paths: ["a.md", "b.md", "c.md"],
        }),
      ),
    );
    expect(preview.actions).toHaveLength(2);
    expect(preview.skipped).toEqual([{ path: "c.md", reason: "file_limit" }]);

    const outcome = await restoreFromTrash(ws.id, "alice", ["a.md", "b.md", "c.md"]);
    expect(outcome.applied).toHaveLength(2);
    expect(outcome.skipped.map((s) => s.reason)).toEqual(["file_limit"]);
    expect(await svc.fileCount(ws.id)).toBe(3);
  });

  it("is enforced by the file service too, not just the preview", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "aaaa");
    await del(ws.id, "a.md");
    const plan = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["a.md"],
    });
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "2";
    const outcome = await applyPlan({
      workspaceId: ws.id,
      plan,
      actor: alice,
      meta: { kind: "trash" },
    });
    expect(outcome.skipped).toEqual([{ path: "a.md", reason: "storage_limit" }]);
  });
});

describe("restored versions", () => {
  it("continue a path's version numbers, so no client mistakes them for one it has", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "AAA");
    await put(ws.id, "a.md", "BBB");
    await del(ws.id, "a.md");
    const outcome = await restoreFromTrash(ws.id, "alice", ["a.md"]);
    expect(outcome.applied).toHaveLength(1);
    expect((await svc.stat(ws.id, "a.md", "trusted"))?.version).toBe(3);
    const ev = await db.changeEvent.findFirst({ where: { workspaceId: ws.id, op: "restore" } });
    expect(ev).toMatchObject({ version: 3, privateTo: "" });
  });

  it("previewed, then deleted again with other content: left alone", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "original");
    await del(ws.id, "a.md");
    const preview = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["a.md"],
    });
    await put(ws.id, "a.md", "the agent's replacement", agent);
    await del(ws.id, "a.md", agent);
    const plan = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["a.md"],
      previewHead: preview.head,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([{ path: "a.md", reason: "changed" }]);
  });
});

describe("trash and privacy", () => {
  it("keeps hiding a file deleted in a private folder that was renamed, then shared", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/secret.md", "the secret");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    // A folder rename, as the app does it: the folder's ACL, then each file.
    await moveFolderMetadata(ws.id, "old", "new");
    await svc.move({
      workspaceId: ws.id,
      from: "old/secret.md",
      to: "new/secret.md",
      actor: alice,
    });
    await del(ws.id, "new/secret.md");
    await clearNodePrivate(ws.id, "new", alice);

    expect((await listTrash({ workspaceId: ws.id, subject: asMember("bob") })).items).toEqual([]);
    const outcome = await restoreFromTrash(ws.id, "bob", ["new/secret.md"], bob);
    expect(outcome.skipped).toEqual([{ path: "new/secret.md", reason: "not_in_trash" }]);
    expect(
      (await listTrash({ workspaceId: ws.id, subject: asMember("alice") })).items,
    ).toHaveLength(1);
  });

  it("brings a file back still private when its private folder was renamed away", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/secret.md", "the secret");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await del(ws.id, "old/secret.md");
    await moveFolderMetadata(ws.id, "old", "new");

    const outcome = await restoreFromTrash(ws.id, "alice", ["old/secret.md"]);
    expect(outcome.applied).toHaveLength(1);
    expect((await svc.read(ws.id, "old/secret.md", asMember("alice"))).status).toBe("ok");
    expect((await svc.read(ws.id, "old/secret.md", asMember("bob"))).status).toBe("not_found");
  });

  it("records a moved private file's privacy on both of its move events", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "mine.md", "m");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "mine.md",
      kind: "file",
      ownerId: "alice",
      actor: alice,
    });
    await svc.move({ workspaceId: ws.id, from: "mine.md", to: "renamed.md", actor: alice });
    const events = await db.changeEvent.findMany({
      where: { workspaceId: ws.id, op: { in: ["delete", "move"] } },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.privateTo)).toEqual(["alice", "alice"]);
  });

  it("never names a move's destination to someone who can't see it", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "public.md", "p");
    await put(ws.id, "Private/.keep", "");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "Private",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await svc.move({
      workspaceId: ws.id,
      from: "public.md",
      to: "Private/acquisition.md",
      actor: alice,
    });
    const left = await db.changeEvent.findFirstOrThrow({
      where: { workspaceId: ws.id, path: "public.md", op: "delete" },
    });
    const acls = await listWorkspaceAcls(ws.id);
    expect(feedEvent(left, acls, asMember("bob")).relatedPath).toBeNull();
    expect(feedEvent(left, acls, asMember("alice")).relatedPath).toBe("Private/acquisition.md");
    expect(feedEvent(left, acls, asMember("bob"))).not.toHaveProperty("privateTo");
  });

  it("hides another member's deleted private file, and refuses to restore it", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "mine/secret.md", "s");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "mine",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await del(ws.id, "mine/secret.md");

    expect(
      (await listTrash({ workspaceId: ws.id, subject: asMember("alice") })).items,
    ).toHaveLength(1);
    expect((await listTrash({ workspaceId: ws.id, subject: asMember("bob") })).items).toEqual([]);
    const outcome = await restoreFromTrash(ws.id, "bob", ["mine/secret.md"], bob);
    expect(outcome).toMatchObject({
      operationId: null,
      applied: [],
      skipped: [{ path: "mine/secret.md", reason: "not_in_trash" }],
    });
  });

  it("brings a file back private to its owner when its private folder was renamed away", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/secret.md", "the secret");
    await put(ws.id, "old/other.md", "o");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await del(ws.id, "old/secret.md");
    await moveFolderMetadata(ws.id, "old", "new");
    await svc.move({ workspaceId: ws.id, from: "old/other.md", to: "new/other.md", actor: alice });

    const outcome = await restoreFromTrash(ws.id, "alice", ["old/secret.md"]);
    expect(outcome.applied).toHaveLength(1);
    const acls = await listWorkspaceAcls(ws.id);
    expect(canRead(acls, "old/secret.md", asMember("bob"))).toBe(false);
    expect(canRead(acls, "old/secret.md", asMember("alice"))).toBe(true);
    const events = await db.changeEvent.findMany({
      where: { workspaceId: ws.id, path: "old/secret.md" },
      orderBy: { seq: "desc" },
      take: 3,
    });
    // Announced as made private first, so a synced copy from any time the
    // path was shared is removed even by a client that missed the events.
    expect(events.map((e) => [e.op, e.privateTo])).toEqual([
      ["restore", "alice"],
      ["access_granted", "alice"],
      ["access_revoked", ""],
    ]);
  });

  it("never writes over a member's private folder moved onto the path mid-restore", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/project", "alice's file");
    await put(ws.id, "old/other.md", "o");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await del(ws.id, "old/project");
    await moveFolderMetadata(ws.id, "old", "new");
    await svc.move({ workspaceId: ws.id, from: "old/other.md", to: "new/other.md", actor: alice });
    await put(ws.id, "bobs/bob-secret.md", "bob's secret", bob);
    await setNodePrivate({
      workspaceId: ws.id,
      path: "bobs",
      kind: "folder",
      ownerId: "bob",
      actor: bob,
    });
    const plan = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["old/project"],
    });
    expect(plan.actions).toHaveLength(1);

    // Bob renames his private folder onto the path after the restore's
    // permission check, while it looks up the bytes.
    const store = useBlobStore();
    const stat = store.stat.bind(store);
    const spy = vi.spyOn(store, "stat").mockImplementationOnce(async (key) => {
      await moveFolderMetadata(ws.id, "bobs", "old/project");
      await svc.move({
        workspaceId: ws.id,
        from: "bobs/bob-secret.md",
        to: "old/project/bob-secret.md",
        actor: bob,
      });
      return stat(key);
    });
    try {
      const outcome = await applyPlan({
        workspaceId: ws.id,
        plan,
        actor: alice,
        meta: { kind: "trash" },
      });
      expect(outcome.applied).toEqual([]);
      expect(outcome.skipped).toEqual([{ path: "old/project", reason: "changed" }]);
    } finally {
      spy.mockRestore();
    }
    const acls = await listWorkspaceAcls(ws.id);
    expect(acls.find((a) => a.path === "old/project")).toMatchObject({
      kind: "folder",
      grants: [{ subject: "user", userId: "bob", level: "write" }],
    });
    expect((await svc.read(ws.id, "old/project/bob-secret.md", asMember("alice"))).status).toBe(
      "not_found",
    );
  });

  it("keeps a file deleted from a shared folder to that folder's people", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "clients/plan.md", "for two people");
    await setNodeAccess({
      workspaceId: ws.id,
      path: "clients",
      kind: "folder",
      grants: [
        { subject: "user", userId: "alice", level: "write" },
        { subject: "user", userId: "sam", level: "read" },
      ],
      actor: alice,
    });
    await del(ws.id, "clients/plan.md");
    await clearNodePrivate(ws.id, "clients", alice);
    const trash = async (id: string) =>
      (await listTrash({ workspaceId: ws.id, subject: asMember(id) })).items.map((i) => i.path);
    expect(await trash("alice")).toEqual(["clients/plan.md"]);
    expect(await trash("sam")).toEqual(["clients/plan.md"]);
    // Lifting the restriction later doesn't open up what was deleted under it.
    expect(await trash("bob")).toEqual([]);
  });

  it("brings a file back with the whole grant list it was deleted under", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "clients/plan.md", "for two people");
    const grants = [
      { subject: "user", userId: "alice", level: "write" },
      { subject: "user", userId: "sam", level: "read" },
    ];
    await setNodeAccess({
      workspaceId: ws.id,
      path: "clients",
      kind: "folder",
      grants,
      actor: alice,
    });
    await del(ws.id, "clients/plan.md");
    await clearNodePrivate(ws.id, "clients", alice);

    const plan = await planTrashRestore({
      workspaceId: ws.id,
      subject: asMember("alice"),
      paths: ["clients/plan.md"],
    });
    await applyPlan({ workspaceId: ws.id, plan, actor: alice, meta: { kind: "trash" } });

    const acls = await listWorkspaceAcls(ws.id);
    expect(canRead(acls, "clients/plan.md", asMember("sam"))).toBe(true);
    expect(canWrite(acls, "clients/plan.md", asMember("sam"))).toBe(false);
    expect(canRead(acls, "clients/plan.md", asMember("bob"))).toBe(false);
  });

  it("keeps hiding a file deleted while private, after its folder is shared", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "draft/plan.md", "private thoughts");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "draft",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await del(ws.id, "draft/plan.md");
    await clearNodePrivate(ws.id, "draft", alice);
    expect((await listTrash({ workspaceId: ws.id, subject: asMember("bob") })).items).toEqual([]);
    expect(
      (await listTrash({ workspaceId: ws.id, subject: asMember("alice") })).items,
    ).toHaveLength(1);
  });
});

describe("trash and shared restrictions", () => {
  it("remembers everyone a restored file is limited to, not just who restored it", async () => {
    const ws = await freshWorkspace();
    const grants = ["alice", "bob"].map((userId) => ({ subject: "user", userId, level: "write" }));
    await put(ws.id, "folder/a.md", "one");
    await setNodeAccess({
      workspaceId: ws.id,
      path: "folder",
      kind: "folder",
      grants,
      actor: alice,
    });
    await del(ws.id, "folder/a.md");
    await clearNodePrivate(ws.id, "folder", alice);
    await restoreFromTrash(ws.id, "alice", ["folder/a.md"]);
    await new Promise((r) => setTimeout(r, 15));
    const at = new Date();
    await new Promise((r) => setTimeout(r, 15));
    await put(ws.id, "folder/a.md", "two");

    const { skipped, actions } = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("bob"),
      scope: null,
      at,
    });
    expect(skipped).toEqual([]);
    expect(actions.map((a) => `${a.kind} ${a.path}`)).toEqual(["restore folder/a.md"]);
  });
});

describe("trash and privacy, for history from before privacy was recorded", () => {
  /** As the migration leaves every event recorded before it. */
  async function forgetPrivacy(workspaceId: string) {
    await db.changeEvent.updateMany({ where: { workspaceId }, data: { privateTo: null } });
  }

  it("fails closed on a file deleted in a private folder that was renamed, then shared", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/secret.md", "the secret");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await moveFolderMetadata(ws.id, "old", "new");
    await svc.move({
      workspaceId: ws.id,
      from: "old/secret.md",
      to: "new/secret.md",
      actor: alice,
    });
    await del(ws.id, "new/secret.md");
    await clearNodePrivate(ws.id, "new", alice);
    await forgetPrivacy(ws.id);

    expect((await listTrash({ workspaceId: ws.id, subject: asMember("bob") })).items).toEqual([]);
    const outcome = await restoreFromTrash(ws.id, "bob", ["new/secret.md"], bob);
    expect(outcome.skipped).toEqual([{ path: "new/secret.md", reason: "not_in_trash" }]);
    expect(
      (await listTrash({ workspaceId: ws.id, subject: asMember("alice") })).items,
    ).toHaveLength(1);
  });

  it("still shows what was deleted before anyone made anything private", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "early.md", "e");
    await del(ws.id, "early.md");
    await put(ws.id, "mine/x.md", "x");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "mine",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await put(ws.id, "late.md", "l");
    await del(ws.id, "late.md");
    await forgetPrivacy(ws.id);

    const paths = async (userId: string) =>
      (await listTrash({ workspaceId: ws.id, subject: asMember(userId) })).items.map((i) => i.path);
    expect(await paths("bob")).toEqual(["early.md"]);
    expect(await paths("alice")).toEqual(["late.md", "early.md"]);
  });
});

describe("privateOwnerAt", () => {
  const ev = (path: string, op: string, actorId: string, seq: number) => ({
    path,
    op,
    actorId,
    seq: BigInt(seq),
  });
  const events = [
    ev("a", "access_revoked", "alice", 1),
    ev("a/b", "access_revoked", "bob", 2),
    ev("a", "access_granted", "alice", 5),
  ];

  it("follows the most specific private node at that moment", () => {
    expect(privateOwnerAt(events, "a/x.md", 0n)).toBeNull();
    expect(privateOwnerAt(events, "a/x.md", 1n)).toBe("alice");
    expect(privateOwnerAt(events, "a/b/y.md", 3n)).toBe("bob");
    expect(privateOwnerAt(events, "a/x.md", 5n)).toBeNull();
    expect(privateOwnerAt(events, "a/b/y.md", 9n)).toBe("bob");
  });

  it("never covers a sibling that only shares the prefix", () => {
    expect(privateOwnerAt(events, "ab/x.md", 3n)).toBeNull();
    expect(privateOwnerAt(events, "a/bc.md", 3n)).toBe("alice");
  });
});