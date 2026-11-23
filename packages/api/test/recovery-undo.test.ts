import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

useTempBlobDir("treehouse-recovery-undo-");

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { setNodePrivate } = await import("../server/utils/acl");
const { applyPlan, fitToLimits, onlyApproved, planUndo, previewOf } =
  await import("../server/utils/recovery");
const { previewTokenFor, readPreviewToken } = await import("../server/utils/recovery-request");
type Actor = import("../server/utils/files").Actor;

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-10-29T00:00:00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const sam: Actor = { principal: "human", actorId: "sam", access: asMember("sam") };
const bob: Actor = { principal: "human", actorId: "bob", access: asMember("bob") };
const claude: Actor = {
  principal: "agent",
  actorId: "sam",
  access: asMember("sam"),
  actorKeyId: "key_claude",
  actorLabel: "Claude Code",
};
const cursor: Actor = {
  principal: "agent",
  actorId: "sam",
  access: asMember("sam"),
  actorKeyId: "key_cursor",
  actorLabel: "Cursor",
};
const tick = () => new Promise((r) => setTimeout(r, 15));

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}
async function put(workspaceId: string, path: string, body: string, actor: Actor = sam) {
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
async function del(workspaceId: string, path: string, actor: Actor = sam) {
  const head = await svc.stat(workspaceId, path, "trusted");
  expect((await svc.remove({ workspaceId, path, baseVersion: head!.version, actor })).status).toBe(
    "ok",
  );
}
const move = (workspaceId: string, from: string, to: string, actor: Actor) =>
  svc.move({ workspaceId, from, to, actor });
async function text(workspaceId: string, path: string) {
  const r = await svc.read(workspaceId, path, "trusted");
  return r.status === "ok" ? dec(r.body) : null;
}
async function moment(): Promise<Date> {
  await tick();
  const at = new Date();
  await tick();
  return at;
}
async function undo(workspaceId: string, keyId: string, since: Date, actor: Actor = sam) {
  const planned = await planUndo({ workspaceId, subject: asMember(actor.actorId!), keyId, since });
  const plan = await fitToLimits(workspaceId, planned);
  const outcome = await applyPlan({
    workspaceId,
    plan,
    actor,
    meta: { kind: "undo", targetAt: since, targetKeyId: keyId, targetLabel: planned.label },
  });
  return { planned, outcome };
}
const kinds = (actions: { kind: string; path: string }[]) =>
  actions.map((a) => `${a.kind} ${a.path}`).sort();

describe("undo one key's changes", () => {
  it("reverts everything the key did, and nothing anyone else did", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "plan.md", "plan v1");
    await put(ws.id, "notes.md", "notes");
    await put(ws.id, "old.md", "old");
    await put(ws.id, "keep.md", "keep");
    const since = await moment();
    await put(ws.id, "plan.md", "agent rewrite", claude);
    await del(ws.id, "notes.md", claude);
    await move(ws.id, "old.md", "renamed.md", claude);
    await put(ws.id, "junk.md", "junk", claude);
    await put(ws.id, "keep.md", "sam's own edit", sam);
    await put(ws.id, "other-agent.md", "cursor's file", cursor);

    const { planned, outcome } = await undo(ws.id, "key_claude", since);
    expect(planned.label).toBe("Claude Code");
    expect(kinds(outcome.applied)).toEqual([
      "delete junk.md",
      "move old.md",
      "recreate notes.md",
      "restore plan.md",
    ]);
    expect(outcome.skipped).toEqual([]);
    expect(await text(ws.id, "plan.md")).toBe("plan v1");
    expect(await text(ws.id, "notes.md")).toBe("notes");
    expect(await text(ws.id, "old.md")).toBe("old");
    expect(await text(ws.id, "junk.md")).toBeNull();
    expect(await text(ws.id, "keep.md")).toBe("sam's own edit");
    expect(await text(ws.id, "other-agent.md")).toBe("cursor's file");

    const op = await db.recoveryOperation.findUnique({ where: { id: outcome.operationId! } });
    expect(op).toMatchObject({
      kind: "undo",
      targetKeyId: "key_claude",
      targetLabel: "Claude Code",
      applied: 4,
    });
  });

  it("leaves a file someone else changed afterwards, and says who", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "v1");
    await put(ws.id, "b.md", "v1");
    const since = await moment();
    await put(ws.id, "a.md", "agent", claude);
    await put(ws.id, "b.md", "agent", claude);
    await put(ws.id, "a.md", "cursor fixed it up", cursor);

    const { outcome } = await undo(ws.id, "key_claude", since);
    expect(kinds(outcome.applied)).toEqual(["restore b.md"]);
    expect(outcome.skipped).toEqual([{ path: "a.md", reason: "edited_later", detail: "Cursor" }]);
    expect(await text(ws.id, "a.md")).toBe("cursor fixed it up");
  });

  it("goes back to the state just before the key, keeping earlier work by others", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "v1");
    const since = await moment();
    await put(ws.id, "a.md", "sam's v2", sam);
    await put(ws.id, "a.md", "agent v3", claude);
    await undo(ws.id, "key_claude", since);
    expect(await text(ws.id, "a.md")).toBe("sam's v2");
  });

  it("only undoes changes since the chosen moment", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "early.md", "agent before", claude);
    const since = await moment();
    await put(ws.id, "late.md", "agent after", claude);
    const { outcome } = await undo(ws.id, "key_claude", since);
    expect(kinds(outcome.applied)).toEqual(["delete late.md"]);
    expect(await text(ws.id, "early.md")).toBe("agent before");
  });

  it("leaves both ends of a rename alone when someone changed the renamed file", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "draft.md", "draft");
    const since = await moment();
    await move(ws.id, "draft.md", "middle.md", claude);
    await move(ws.id, "middle.md", "final.md", claude);
    await put(ws.id, "final.md", "bob edited the renamed file", bob);

    const { planned, outcome } = await undo(ws.id, "key_claude", since);
    expect(planned.actions).toEqual([]);
    expect(outcome.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "edited_later draft.md",
      "edited_later final.md",
      "edited_later middle.md",
    ]);
    expect(await text(ws.id, "final.md")).toBe("bob edited the renamed file");
    expect(await text(ws.id, "draft.md")).toBeNull();
  });

  it("never touches files the person undoing can't see", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "sam/.keep", "");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "sam",
      kind: "folder",
      ownerId: "sam",
      actor: sam,
    });
    const since = await moment();
    await put(ws.id, "sam/agent-notes.md", "private agent work", claude);
    await put(ws.id, "shared.md", "shared agent work", claude);

    const bobs = previewOf(
      await planUndo({ workspaceId: ws.id, subject: asMember("bob"), keyId: "key_claude", since }),
    );
    expect(kinds(bobs.actions)).toEqual(["delete shared.md"]);
    expect(bobs.skipped).toEqual([]);
    const sams = previewOf(
      await planUndo({ workspaceId: ws.id, subject: asMember("sam"), keyId: "key_claude", since }),
    );
    expect(kinds(sams.actions)).toEqual(["delete sam/agent-notes.md", "delete shared.md"]);
  });

  it("holds a rename whose original is now private to someone else", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "folder/a.md", "a");
    const since = await moment();
    await move(ws.id, "folder/a.md", "b.md", claude);
    await setNodePrivate({
      workspaceId: ws.id,
      path: "folder",
      kind: "folder",
      ownerId: "alice",
      actor: { principal: "human", actorId: "alice", access: asMember("alice") },
    });

    const plan = await planUndo({
      workspaceId: ws.id,
      subject: asMember("bob"),
      keyId: "key_claude",
      since,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toEqual([{ path: "b.md", reason: "linked" }]);
  });

  it("holds the whole rename chain when the key itself edits its end after the preview", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "original");
    const since = await moment();
    await move(ws.id, "a.md", "b.md", claude);
    await move(ws.id, "b.md", "c.md", claude);
    const preview = await planUndo({
      workspaceId: ws.id,
      subject: asMember("sam"),
      keyId: "key_claude",
      since,
    });
    expect(previewOf(preview).actions.map((a) => `${a.kind} ${a.path}`)).toEqual(["move a.md"]);
    await put(ws.id, "c.md", "more agent work", claude);

    const plan = await planUndo({
      workspaceId: ws.id,
      subject: asMember("sam"),
      keyId: "key_claude",
      since,
      previewHead: preview.head,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.skipped.map((s) => `${s.reason} ${s.path}`).sort()).toEqual([
      "changed c.md",
      "linked a.md",
    ]);
  });

  it("moves back the file the key renamed, not an earlier one with the same name", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "first file");
    const since = await moment();
    await del(ws.id, "a.md", sam);
    await put(ws.id, "a.md", "sam's new file", sam);
    await move(ws.id, "a.md", "b.md", claude);

    const { outcome } = await undo(ws.id, "key_claude", since);
    expect(kinds(outcome.applied)).toEqual(["move a.md"]);
    expect(await text(ws.id, "a.md")).toBe("sam's new file");
    expect(await text(ws.id, "b.md")).toBeNull();
  });
});

describe("undo through an agent's preview token", () => {
  it("makes only the previewed changes, even once space frees up", async () => {
    const ws = await freshWorkspace();
    await put(ws.id, "a.md", "abc");
    await put(ws.id, "deleted.md", "0123456789");
    const since = await moment();
    await del(ws.id, "deleted.md", claude);
    await put(ws.id, "a.md", "xyz", claude);
    await put(ws.id, "filler.md", "0123456789", bob);
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "13";
    try {
      const plan = (previewHead?: bigint) =>
        planUndo({
          workspaceId: ws.id,
          subject: asMember("sam"),
          keyId: "key_claude",
          since,
          previewHead,
        });
      const preview = previewOf(await fitToLimits(ws.id, await plan()));
      expect(kinds(preview.actions)).toEqual(["restore a.md"]);
      expect(preview.skipped).toEqual([{ path: "deleted.md", reason: "storage_limit" }]);

      await del(ws.id, "filler.md", bob);
      const token = readPreviewToken(previewTokenFor(preview))!;
      const bound = await fitToLimits(
        ws.id,
        onlyApproved(await plan(token.previewHead), token.approved),
      );
      expect(kinds(bound.actions)).toEqual(["restore a.md"]);
      expect(bound.skipped).toEqual([{ path: "deleted.md", reason: "not_previewed" }]);
    } finally {
      delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
    }
  });
});