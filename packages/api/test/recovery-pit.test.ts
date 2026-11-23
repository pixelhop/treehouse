import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

useTempBlobDir("treehouse-recovery-pit-");

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const {
  canRead,
  clearNodePrivate,
  getNodeAcl,
  listWorkspaceAcls,
  moveFolderMetadata,
  setNodeAccess,
  setNodePrivate,
} = await import("../server/utils/acl");
const { applyPlan, fitToLimits, onlyApproved, planPointInTime, previewOf } =
  await import("../server/utils/recovery");
const { recoveryActionKey } = await import("shared");
const { previewTokenFor, readPreviewToken } = await import("../server/utils/recovery-request");
type Actor = import("../server/utils/files").Actor;

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-10-29T00:00:00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const alice: Actor = { principal: "human", actorId: "alice", access: asMember("alice") };
const bob: Actor = { principal: "human", actorId: "bob", access: asMember("bob") };
const tick = () => new Promise((r) => setTimeout(r, 15));

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
}
async function del(workspaceId: string, path: string, actor: Actor = alice) {
  const head = await svc.stat(workspaceId, path, "trusted");
  expect((await svc.remove({ workspaceId, path, baseVersion: head!.version, actor })).status).toBe(
    "ok",
  );
}
async function text(workspaceId: string, path: string) {
  const r = await svc.read(workspaceId, path, "trusted");
  return r.status === "ok" ? dec(r.body) : null;
}
/** A moment strictly between what's been written and what comes next. */
async function moment(): Promise<Date> {
  await tick();
  const at = new Date();
  await tick();
  return at;
}
async function restoreTo(
  workspaceId: string,
  scope: string | null,
  at: Date,
  actor: Actor = alice,
) {
  const plan = await fitToLimits(
    workspaceId,
    await planPointInTime({ workspaceId, subject: asMember(actor.actorId!), scope, at }),
  );
  return applyPlan({
    workspaceId,
    plan,
    actor,
    meta: { kind: "restore", scopePath: scope, targetAt: at },
  });
}
const kinds = (actions: { kind: string; path: string }[]) =>
  actions.map((a) => `${a.kind} ${a.path}`).sort();

describe("point-in-time restore", () => {
  it("puts a folder back: restores edits, recreates deletions, deletes additions", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "notes/a.md", "a1");
    await put(ws.id, "notes/b.md", "b1");
    const at = await moment();
    await put(ws.id, "notes/a.md", "a2");
    await del(ws.id, "notes/b.md");
    await put(ws.id, "notes/new.md", "new");

    const preview = previewOf(
      await planPointInTime({ workspaceId: ws.id, subject: asMember("alice"), scope: "notes", at }),
    );
    expect(kinds(preview.actions)).toEqual([
      "delete notes/new.md",
      "recreate notes/b.md",
      "restore notes/a.md",
    ]);

    const outcome = await restoreTo(ws.id, "notes", at);
    expect(outcome.applied).toHaveLength(3);
    expect(await text(ws.id, "notes/a.md")).toBe("a1");
    expect(await text(ws.id, "notes/b.md")).toBe("b1");
    expect(await text(ws.id, "notes/new.md")).toBeNull();
    const op = await db.recoveryOperation.findUnique({ where: { id: outcome.operationId! } });
    expect(op).toMatchObject({ kind: "restore", scopePath: "notes", applied: 3 });

    // Nothing left to do: the folder is as it was.
    const again = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: "notes",
      at,
    });
    expect(again.actions).toEqual([]);
  });

  it("never touches a sibling that only shares the folder's name, or anything outside it", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "notes/a.md", "a1");
    await put(ws.id, "notes2/x.md", "x1");
    const at = await moment();
    await put(ws.id, "notes/a.md", "a2");
    await put(ws.id, "notes2/x.md", "x2");
    await put(ws.id, "notes-extra.md", "e");

    const outcome = await restoreTo(ws.id, "notes", at);
    expect(kinds(outcome.applied)).toEqual(["restore notes/a.md"]);
    expect(await text(ws.id, "notes2/x.md")).toBe("x2");
    expect(await text(ws.id, "notes-extra.md")).toBe("e");
  });

  it("moves a renamed file back, restoring its content when that changed too", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "docs/plan.md", "plan v1");
    await put(ws.id, "docs/spec.md", "spec v1");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "docs/plan.md", to: "docs/renamed.md", actor: bob });
    await svc.move({
      workspaceId: ws.id,
      from: "docs/renamed.md",
      to: "docs/final.md",
      actor: bob,
    });
    await svc.move({ workspaceId: ws.id, from: "docs/spec.md", to: "docs/spec2.md", actor: bob });
    await put(ws.id, "docs/spec2.md", "spec v2", bob);

    const outcome = await restoreTo(ws.id, "docs", at);
    expect(outcome.applied).toEqual(
      expect.arrayContaining([
        {
          kind: "move",
          from: "docs/final.md",
          path: "docs/plan.md",
          size: 7,
          restoresContent: false,
        },
        {
          kind: "move",
          from: "docs/spec2.md",
          path: "docs/spec.md",
          size: 7,
          restoresContent: true,
        },
      ]),
    );
    expect(outcome.applied).toHaveLength(2);
    expect(await text(ws.id, "docs/plan.md")).toBe("plan v1");
    expect(await text(ws.id, "docs/spec.md")).toBe("spec v1");
    expect(await text(ws.id, "docs/final.md")).toBeNull();
    expect(await text(ws.id, "docs/spec2.md")).toBeNull();
  });

  it("recreates a file moved out of the folder, leaving the moved copy where it is", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "in/a.md", "a");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "in/a.md", to: "out/a.md", actor: alice });

    const outcome = await restoreTo(ws.id, "in", at);
    expect(kinds(outcome.applied)).toEqual(["recreate in/a.md"]);
    expect(await text(ws.id, "out/a.md")).toBe("a");
  });

  it("restores the whole workspace, a rename across folders included", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "in/a.md", "a");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "in/a.md", to: "out/a.md", actor: alice });
    const outcome = await restoreTo(ws.id, null, at);
    expect(kinds(outcome.applied)).toEqual(["move in/a.md"]);
  });

  it("skips what changed after the preview", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "1");
    await put(ws.id, "b.md", "1");
    const at = await moment();
    await put(ws.id, "a.md", "2");
    await put(ws.id, "b.md", "2");
    const preview = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    await put(ws.id, "b.md", "3 — written after the preview", bob);

    const plan = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
      previewHead: preview.head,
    });
    const outcome = await applyPlan({
      workspaceId: ws.id,
      plan,
      actor: alice,
      meta: { kind: "restore" },
    });
    expect(kinds(outcome.applied)).toEqual(["restore a.md"]);
    expect(outcome.skipped).toEqual([{ path: "b.md", reason: "changed" }]);
    expect(await text(ws.id, "b.md")).toBe("3 — written after the preview");
  });

  it("reports earlier content that was never recorded as unavailable", async () => {
    const ws = await freshWorkspace();
    await db.changeEvent.create({
      data: { workspaceId: ws.id, path: "old.md", op: "write", version: 1, principal: "human" },
    });
    await db.fileNode.create({
      data: {
        workspaceId: ws.id,
        path: "old.md",
        version: 1,
        contentHash: "unknown",
        size: 1,
        contentType: "text/markdown",
        blobKey: `${ws.id}/unknown`,
      },
    });
    const at = await moment();
    await put(ws.id, "old.md", "new");
    const outcome = await restoreTo(ws.id, null, at);
    expect(outcome.skipped).toEqual([{ path: "old.md", reason: "unavailable" }]);
    expect(await text(ws.id, "old.md")).toBe("new");
  });
});

describe("point-in-time restore and privacy", () => {
  it("leaves another member's private files out entirely", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "shared.md", "s1");
    await put(ws.id, "alice/diary.md", "d1");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "alice",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    const at = await moment();
    await put(ws.id, "shared.md", "s2");
    await put(ws.id, "alice/diary.md", "d2");
    await put(ws.id, "alice/new.md", "n");

    const preview = previewOf(
      await planPointInTime({ workspaceId: ws.id, subject: asMember("bob"), scope: null, at }),
    );
    expect(kinds(preview.actions)).toEqual(["restore shared.md"]);
    expect(preview.skipped).toEqual([]);

    // Alice can restore her own private files.
    const hers = previewOf(
      await planPointInTime({ workspaceId: ws.id, subject: asMember("alice"), scope: null, at }),
    );
    expect(kinds(hers.actions)).toEqual([
      "delete alice/new.md",
      "restore alice/diary.md",
      "restore shared.md",
    ]);
  });

  it("leaves a file alone when who can reach it has changed since then", async () => {
    const ws = await freshWorkspace();
    const people = (...ids: string[]) =>
      ids.map((userId) => ({ subject: "user", userId, level: "write" }));
    const access = (grants: ReturnType<typeof people>) =>
      setNodeAccess({ workspaceId: ws.id, path: "plan.md", kind: "file", grants, actor: alice });
    await put(ws.id, "plan.md", "draft");
    await access(people("alice", "bob"));
    await put(ws.id, "plan.md", "for alice and bob");
    const at = await moment();
    await access(people("alice", "carol"));
    await put(ws.id, "plan.md", "for alice and carol");

    const { skipped } = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    expect(skipped).toEqual([{ path: "plan.md", reason: "access_changed" }]);
    await restoreTo(ws.id, null, at);
    expect(await text(ws.id, "plan.md")).toBe("for alice and carol");
    const own = await getNodeAcl(ws.id, "plan.md");
    expect(own?.grants.map((g) => g.userId).sort()).toEqual(["alice", "carol"]);
  });

  it("won't carry old content under a rename that has different people on it now", async () => {
    const ws = await freshWorkspace();
    const people = (...ids: string[]) =>
      ids.map((userId) => ({ subject: "user", userId, level: "write" }));
    const access = (path: string, kind: "file" | "folder", grants: ReturnType<typeof people>) =>
      setNodeAccess({ workspaceId: ws.id, path, kind, grants, actor: alice });
    await put(ws.id, "vault/a.md", "draft");
    await access("vault", "folder", people("alice", "bob"));
    await access("vault/a.md", "file", people("alice", "bob"));
    await put(ws.id, "vault/a.md", "confidential");
    const at = await moment();
    await put(ws.id, "vault/a.md", "redacted");
    const head = await svc.stat(ws.id, "vault/a.md", "trusted");
    expect(
      (
        await svc.move({
          workspaceId: ws.id,
          from: "vault/a.md",
          to: "vault/b.md",
          baseVersion: head!.version,
          actor: alice,
        })
      ).status,
    ).toBe("ok");
    await access("vault/b.md", "file", people("alice", "carol"));

    await restoreTo(ws.id, null, at);
    expect(await text(ws.id, "vault/b.md")).toBe("redacted");
    expect(await text(ws.id, "vault/a.md")).toBeNull();
    const { skipped } = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    expect(skipped).toContainEqual({ path: "vault/a.md", reason: "access_changed" });
  });

  it("doesn't shrink a folder's people to whoever is restoring", async () => {
    const ws = await freshWorkspace();
    const grants = [
      { subject: "user", userId: "alice", level: "write" },
      { subject: "user", userId: "bob", level: "write" },
    ];
    await put(ws.id, "folder/a.md", "one");
    await setNodeAccess({
      workspaceId: ws.id,
      path: "folder",
      kind: "folder",
      grants,
      actor: alice,
    });
    const at = await moment();
    await put(ws.id, "folder/a.md", "two");

    await restoreTo(ws.id, null, at);
    expect(await text(ws.id, "folder/a.md")).toBe("one");
    expect(await getNodeAcl(ws.id, "folder/a.md")).toBeNull();
    const acls = await listWorkspaceAcls(ws.id);
    expect(canRead(acls, "folder/a.md", asMember("bob"))).toBe(true);
  });

  it("never brings back content from while a file was private to someone else", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "draft/plan.md", "private thoughts");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "draft",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    const at = await moment();
    await put(ws.id, "draft/plan.md", "cleaned up for everyone");
    await clearNodePrivate(ws.id, "draft", alice);

    const bobs = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("bob"),
      scope: null,
      at,
    });
    expect(bobs.actions).toEqual([]);
    expect(bobs.skipped).toEqual([{ path: "draft/plan.md", reason: "private_then" }]);

    const alices = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    expect(kinds(alices.actions)).toEqual(["restore draft/plan.md"]);
  });

  it("leaves a private file and its later name alone after the folder is renamed and shared", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/a.md", "public start");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await put(ws.id, "old/a.md", "the secret");
    const at = await moment();
    await moveFolderMetadata(ws.id, "old", "new");
    await svc.move({ workspaceId: ws.id, from: "old/a.md", to: "new/a.md", actor: alice });
    await put(ws.id, "new/a.md", "cleaned up");
    await clearNodePrivate(ws.id, "new", alice);

    const bobs = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("bob"),
      scope: null,
      at,
    });
    expect(bobs.actions).toEqual([]);
    expect(bobs.skipped).toEqual(
      expect.arrayContaining([
        { path: "old/a.md", reason: "private_then" },
        { path: "new/a.md", reason: "private_then" },
      ]),
    );
    const alices = previewOf(
      await planPointInTime({ workspaceId: ws.id, subject: asMember("alice"), scope: null, at }),
    );
    expect(alices.actions).toEqual([
      { kind: "move", from: "new/a.md", path: "old/a.md", size: 10, restoresContent: true },
    ]);
  });

  it("keeps a file private when moving it back out of a renamed private folder", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "old/secret.md", "the secret");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "old",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    const at = await moment();
    await moveFolderMetadata(ws.id, "old", "new");
    await svc.move({
      workspaceId: ws.id,
      from: "old/secret.md",
      to: "new/secret.md",
      actor: alice,
    });

    const outcome = await restoreTo(ws.id, null, at, alice);
    expect(kinds(outcome.applied)).toEqual(["move old/secret.md"]);
    expect((await svc.read(ws.id, "old/secret.md", asMember("alice"))).status).toBe("ok");
    expect((await svc.read(ws.id, "old/secret.md", asMember("bob"))).status).toBe("not_found");
  });
});

describe("point-in-time restore and privacy, applied", () => {
  it("makes a file private again when restoring content from while it was private", async () => {
    const ws = await freshWorkspace();
    await setNodePrivate({
      workspaceId: ws.id,
      path: "draft",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    await put(ws.id, "draft/a.md", "secret v1");
    const at = await moment();
    await put(ws.id, "draft/a.md", "sanitized v2");
    await clearNodePrivate(ws.id, "draft", alice);
    expect(await text(ws.id, "draft/a.md")).toBe("sanitized v2");

    const outcome = await restoreTo(ws.id, null, at, alice);
    expect(kinds(outcome.applied)).toEqual(["restore draft/a.md"]);
    expect(canRead(await listWorkspaceAcls(ws.id), "draft/a.md", asMember("bob"))).toBe(false);
    expect((await svc.read(ws.id, "draft/a.md", asMember("bob"))).status).toBe("not_found");
    expect((await svc.read(ws.id, "draft/a.md", asMember("alice"))).status).toBe("ok");
    // Bob's synced copy is told to go, before the private content lands.
    const last = await db.changeEvent.findMany({
      where: { workspaceId: ws.id, path: "draft/a.md" },
      orderBy: { seq: "desc" },
      take: 3,
    });
    expect(last.map((e) => [e.op, e.privateTo])).toEqual([
      ["restore", "alice"],
      ["access_granted", "alice"],
      ["access_revoked", ""],
    ]);
  });

  it("tells members to drop their copy when a private file is recreated or moved back", async () => {
    for (const away of ["delete", "move"] as const) {
      const ws = await freshWorkspace();
      await setNodePrivate({
        workspaceId: ws.id,
        path: "draft",
        kind: "folder",
        ownerId: "alice",
        actor: alice,
      });
      await put(ws.id, "draft/a.md", "secret v1");
      const at = await moment();
      await put(ws.id, "draft/a.md", "public v2");
      await clearNodePrivate(ws.id, "draft", alice);
      // Bob syncs v2, then misses every poll from here on.
      if (away === "delete") await del(ws.id, "draft/a.md");
      else await svc.move({ workspaceId: ws.id, from: "draft/a.md", to: "b.md", actor: alice });

      const outcome = await restoreTo(ws.id, null, at, alice);
      expect(kinds(outcome.applied)).toEqual([
        away === "delete" ? "recreate draft/a.md" : "move draft/a.md",
      ]);
      // The feed now withholds every event at draft/a.md from Bob, except
      // this one, which tells his client to remove its copy.
      const revoked = await db.changeEvent.findFirst({
        where: { workspaceId: ws.id, path: "draft/a.md", op: "access_revoked" },
        orderBy: { seq: "desc" },
      });
      const restored = await db.changeEvent.findFirstOrThrow({
        where: { workspaceId: ws.id, path: "draft/a.md", op: { in: ["restore", "move"] } },
        orderBy: { seq: "desc" },
      });
      expect(revoked && revoked.seq < restored.seq).toBe(true);
      expect(canRead(await listWorkspaceAcls(ws.id), "draft/a.md", asMember("bob"))).toBe(false);
    }
  });

  it("applies only the previewed changes, not a file shared with the runner since", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "shared.md", "one");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "private",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });
    const at = await moment();
    await put(ws.id, "shared.md", "two");
    await put(ws.id, "private/new.md", "alice's", alice);

    const preview = previewOf(
      await planPointInTime({ workspaceId: ws.id, subject: asMember("bob"), scope: null, at }),
    );
    expect(kinds(preview.actions)).toEqual(["restore shared.md"]);
    await clearNodePrivate(ws.id, "private", alice);

    const plan = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("bob"),
      scope: null,
      at,
      previewHead: BigInt(preview.previewHead),
    });
    // Shared after the preview: left alone as changed, even by an apply that
    // doesn't list the changes it confirms.
    expect(kinds(plan.actions)).toEqual(["restore shared.md"]);
    expect(plan.skipped).toEqual([{ path: "private/new.md", reason: "changed" }]);
    const bound = onlyApproved(plan, new Set(preview.actions.map(recoveryActionKey)));
    expect(kinds(bound.actions)).toEqual(["restore shared.md"]);
  });
});

describe("an agent's preview token", () => {
  it("holds the apply to the previewed changes, even once a limit frees up", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "d/a.md", "abc");
    await put(ws.id, "d/deleted.md", "0123456789");
    const at = await moment();
    await put(ws.id, "d/a.md", "xyz");
    await del(ws.id, "d/deleted.md");
    await put(ws.id, "filler.md", "0123456789", bob);
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "13";
    try {
      const plan = (previewHead?: bigint) =>
        planPointInTime({
          workspaceId: ws.id,
          subject: asMember("alice"),
          scope: "d",
          at,
          previewHead,
        });
      const preview = previewOf(await fitToLimits(ws.id, await plan()));
      expect(kinds(preview.actions)).toEqual(["restore d/a.md"]);
      expect(preview.skipped).toEqual([{ path: "d/deleted.md", reason: "storage_limit" }]);
      const token = readPreviewToken(previewTokenFor(preview))!;
      expect(token.previewHead).toBe(BigInt(preview.previewHead));

      // Space frees up before the agent applies: still only what it previewed.
      await del(ws.id, "filler.md", bob);
      const bound = await fitToLimits(
        ws.id,
        onlyApproved(await plan(token.previewHead), token.approved),
      );
      expect(kinds(bound.actions)).toEqual(["restore d/a.md"]);
      expect(bound.skipped).toEqual([{ path: "d/deleted.md", reason: "not_previewed" }]);
    } finally {
      delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
    }
  });

  it("rejects anything that isn't a preview token", () => {
    expect(readPreviewToken("123")).toBeNull();
    expect(readPreviewToken("not a token")).toBeNull();
    expect(readPreviewToken("")).toBeNull();
  });
});

describe("point-in-time restore and versions", () => {
  it("moves a file back above any version its old path had, so synced copies pull it", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "A1");
    const at = await moment();
    await put(ws.id, "a.md", "A2");
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "b.md", actor: bob });

    const outcome = await restoreTo(ws.id, null, at);
    expect(kinds(outcome.applied)).toEqual(["move a.md"]);
    expect(await text(ws.id, "a.md")).toBe("A1");
    // A client that missed the rename still has a.md at v2.
    expect((await svc.stat(ws.id, "a.md", "trusted"))!.version).toBeGreaterThan(2);
  });
});

describe("point-in-time restore keeps a rename whole", () => {
  it("leaves a renamed file alone when another file has taken its old name", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "the original, with its comments");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "b.md", actor: bob });
    await put(ws.id, "a.md", "a newcomer", bob);

    const outcome = await restoreTo(ws.id, null, at);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "linked b.md",
      "name_taken a.md",
    ]);
    expect(await text(ws.id, "a.md")).toBe("a newcomer");
    expect(await text(ws.id, "b.md")).toBe("the original, with its comments");
  });

  it("leaves a swap alone rather than swapping the bytes back in place", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "A");
    await put(ws.id, "b.md", "B");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "tmp.md", actor: bob });
    await svc.move({ workspaceId: ws.id, from: "b.md", to: "a.md", actor: bob });
    await svc.move({ workspaceId: ws.id, from: "tmp.md", to: "b.md", actor: bob });

    const outcome = await restoreTo(ws.id, null, at);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "name_taken a.md",
      "name_taken b.md",
    ]);
    expect(await text(ws.id, "a.md")).toBe("B");
  });

  it("leaves the renamed file alone when its old name was taken after the preview", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "original");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "b.md", actor: bob });
    const preview = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    expect(previewOf(preview).actions).toEqual([
      { kind: "move", from: "b.md", path: "a.md", size: 8, restoresContent: false },
    ]);
    await put(ws.id, "a.md", "a new file by bob", bob);

    const plan = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
      previewHead: preview.head,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "changed a.md",
      "linked b.md",
    ]);
  });

  it("holds a whole rename chain when its far end changed after the preview", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "original");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "a.md", to: "b.md", actor: bob });
    await svc.move({ workspaceId: ws.id, from: "b.md", to: "c.md", actor: bob });
    const preview = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    expect(previewOf(preview).actions.map((a) => a.kind)).toEqual(["move"]);
    await put(ws.id, "c.md", "edited after the preview", bob);

    const plan = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
      previewHead: preview.head,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "changed c.md",
      "linked a.md",
    ]);
  });

  it("holds a renamed file whose other end is now private to someone else, without saying why", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "folder/a.md", "a");
    const at = await moment();
    await svc.move({ workspaceId: ws.id, from: "folder/a.md", to: "b.md", actor: bob });
    await setNodePrivate({
      workspaceId: ws.id,
      path: "folder",
      kind: "folder",
      ownerId: "alice",
      actor: alice,
    });

    const bobs = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("bob"),
      scope: null,
      at,
    });
    expect(bobs.actions).toEqual([]);
    expect(bobs.skipped).toEqual([{ path: "b.md", reason: "linked" }]);
    expect(await text(ws.id, "b.md")).toBe("a");
  });

  it("leaves a live file that moved on past the events it read", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "one");
    const at = await moment();
    await put(ws.id, "a.md", "two");
    // A write landing between reading the feed and reading the files: the
    // row is ahead of every event the plan saw.
    await db.fileNode.update({
      where: { workspaceId_path: { workspaceId: ws.id, path: "a.md" } },
      data: { version: 3 },
    });
    const plan = await planPointInTime({
      workspaceId: ws.id,
      subject: asMember("alice"),
      scope: null,
      at,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([{ path: "a.md", reason: "changed" }]);
  });
});