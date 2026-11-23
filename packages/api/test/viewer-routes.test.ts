import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// The Viewer role, end to end against a RUNNING api: every write surface refuses
// a viewer with the distinct `read_only` rejection (never a 403 and never a
// version conflict), while reads and comments keep working. Server-gated.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3010";
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { createWorkspaceWithOrg } = await import("../server/utils/workspace");
const { useFileService } = await import("../server/utils/files");
const { setNodePrivate } = await import("../server/utils/acl");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function signUp(label: string) {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const email = `vwr${label}${stamp}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: `Vwr ${label}` },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const json = (await res.json()) as { user?: { id?: string } };
  if (!cookie || !json.user?.id) throw new Error(`sign-up failed (${res.status})`);
  return { cookie, userId: json.user.id };
}

async function join(organizationId: string, userId: string, role: string) {
  await db.member.create({
    data: {
      id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
      organizationId,
      userId,
      role,
    },
  });
}

/** A workspace with a file in it, an owner, and a viewer holding a key. */
async function setup() {
  const owner = await signUp("owner");
  const viewer = await signUp("viewer");
  const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Viewer test" });
  await join(ws.organizationId, viewer.userId, "viewer");
  // Through the API, not the service: the blob store's directory can be relative,
  // so bytes written from this process may land where the server can't read them.
  const seeded = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes/a.md`, {
    method: "PUT",
    body: "# hello\n",
    headers: {
      cookie: owner.cookie,
      "content-type": "text/markdown",
      "if-none-match": "*",
    },
  });
  if (!seeded.ok) throw new Error(`seed write failed (${seeded.status})`);
  const key = await auth.api.createApiKey({
    body: {
      userId: viewer.userId,
      name: "viewer-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  const userKey = await auth.api.createApiKey({
    body: { userId: viewer.userId, name: "viewer-user-key", metadata: { actorType: "agent" } },
  });
  return { owner, viewer, ws, key: key.key, userKey: userKey.key };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const api = (ctx: Ctx, path: string, init: RequestInit = {}) =>
  fetch(`${BASE}/api/workspaces/${ctx.ws.id}${path}`, {
    ...init,
    headers: { cookie: ctx.viewer.cookie, ...init.headers },
  });
const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function expectReadOnly(res: Response) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { data?: { error?: string; reason?: string } };
  expect(body.data).toEqual({ error: "read_only", reason: "role" });
}

async function connect(key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    requestInit: { headers: { "x-api-key": key } },
  });
  const client = new Client({ name: "viewer-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe.skipIf(!serverUp)("viewer role (REST)", () => {
  it("can read the tree, a file, its history, search and the change feed", async () => {
    const ctx = await setup();
    const list = (await (await api(ctx, "/list")).json()) as { entries: { path: string }[] };
    expect(list.entries.map((e) => e.path)).toContain("notes/a.md");
    const file = await api(ctx, "/files/notes/a.md");
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("# hello\n");
    expect((await api(ctx, "/version?path=notes/a.md&version=1")).status).toBe(200);
    expect((await api(ctx, "/search?q=a.md")).status).toBe(200);
    const changes = (await (await api(ctx, "/changes?sinceSeq=0")).json()) as {
      changes: { path: string }[];
    };
    expect(changes.changes.map((c) => c.path)).toContain("notes/a.md");
  });

  it("follows links and tags, and can't move a note to rewrite them", async () => {
    const ctx = await setup();
    const seeded = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/files/notes/b.md`, {
      method: "PUT",
      body: "See [[a]]. #plan\n",
      headers: {
        cookie: ctx.owner.cookie,
        "content-type": "text/markdown",
        "if-none-match": "*",
      },
    });
    expect(seeded.ok).toBe(true);

    const links = (await (await api(ctx, "/links?path=notes/a.md")).json()) as {
      backlinks: string[];
    };
    expect(links.backlinks).toEqual(["notes/b.md"]);
    const tags = (await (await api(ctx, "/tags")).json()) as { tags: { tag: string }[] };
    expect(tags.tags.map((t) => t.tag)).toEqual(["plan"]);
    const tagged = (await (await api(ctx, "/tags?tag=plan")).json()) as { paths: string[] };
    expect(tagged.paths).toEqual(["notes/b.md"]);

    await expectReadOnly(
      await api(ctx, "/move", {
        method: "POST",
        ...json({ from: "notes/a.md", to: "notes/z.md", updateLinks: true }),
      }),
    );
    expect((await api(ctx, "/files/notes/a.md")).status).toBe(200);
    expect(await (await api(ctx, "/files/notes/b.md")).text()).toBe("See [[a]]. #plan\n");
  });

  it("is told what it can do", async () => {
    const ctx = await setup();
    const meta = (await (await api(ctx, "")).json()) as { access: unknown };
    expect(meta.access).toEqual({ role: "viewer", canWrite: false, key: null });
  });

  it("is refused every file write with read_only, and nothing changes", async () => {
    const ctx = await setup();
    const put = await api(ctx, "/files/notes/a.md", {
      method: "PUT",
      body: "changed",
      headers: { "if-match": '"1"' },
    });
    await expectReadOnly(put);
    await expectReadOnly(
      await api(ctx, "/files/new.md", {
        method: "PUT",
        body: "new",
        headers: { "if-none-match": "*" },
      }),
    );
    await expectReadOnly(
      await api(ctx, "/files/notes/a.md", { method: "DELETE", headers: { "if-match": '"1"' } }),
    );
    await expectReadOnly(
      await api(ctx, "/move", { method: "POST", ...json({ from: "notes/a.md", to: "b.md" }) }),
    );
    await expectReadOnly(
      await api(ctx, "/move-folder", { method: "POST", ...json({ from: "notes", to: "b" }) }),
    );
    await expectReadOnly(
      await api(ctx, "/restore", {
        method: "POST",
        ...json({ path: "notes/a.md", targetVersion: 1 }),
      }),
    );

    const svc = useFileService();
    expect(await svc.stat(ctx.ws.id, "notes/a.md", "trusted")).toMatchObject({ version: 1 });
    expect(await svc.stat(ctx.ws.id, "new.md", "trusted")).toBeNull();
    expect(await svc.stat(ctx.ws.id, "b.md", "trusted")).toBeNull();
    // No conflicted copy either: a rejection stores nothing at all.
    expect(
      (await svc.list(ctx.ws.id, "", "trusted")).filter((e) => /conflict/i.test(e.path)),
    ).toEqual([]);
  });

  it("is refused metadata, privacy, share and workspace changes", async () => {
    const ctx = await setup();
    await expectReadOnly(
      await api(ctx, "/node-icon", { method: "PUT", ...json({ path: "notes", icon: "🌳" }) }),
    );
    await expectReadOnly(
      await api(ctx, "/node-order", { method: "PUT", ...json({ paths: ["notes"] }) }),
    );
    await expectReadOnly(
      await api(ctx, "/node-private", {
        method: "PUT",
        ...json({ path: "notes", kind: "folder", private: true }),
      }),
    );
    await expectReadOnly(
      await api(ctx, "/shares", {
        method: "POST",
        ...json({ path: "notes/a.md", kind: "file", access: "member" }),
      }),
    );
    await expectReadOnly(await api(ctx, "", { method: "PATCH", ...json({ name: "Mine now" }) }));
    await expectReadOnly(
      await api(ctx, "/icon", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
        headers: { "content-type": "image/png" },
      }),
    );
  });

  it("can't revoke or change someone else's share link", async () => {
    const ctx = await setup();
    const created = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/shares`, {
      method: "POST",
      headers: { cookie: ctx.owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/a.md", kind: "file", access: "member" }),
    });
    expect(created.status).toBeLessThan(300);
    const { share } = (await created.json()) as { share: { id: string } };
    await expectReadOnly(await api(ctx, `/shares/${share.id}`, { method: "DELETE" }));
    await expectReadOnly(
      await api(ctx, `/shares/${share.id}`, { method: "PATCH", ...json({ allowScripts: false }) }),
    );
  });

  it("can comment, reply and resolve: review is what a viewer is for", async () => {
    const ctx = await setup();
    const created = await api(ctx, "/comments", {
      method: "POST",
      ...json({
        path: "notes/a.md",
        kind: "range",
        quote: "hello",
        contextBefore: "# ",
        contextAfter: "\n",
        body: "Is this the right greeting?",
      }),
    });
    expect(created.status).toBeLessThan(300);
    const { thread } = (await created.json()) as { thread: { id: string } };
    const reply = await api(ctx, `/comments/${thread.id}/replies`, {
      method: "POST",
      ...json({ body: "On reflection, yes." }),
    });
    expect(reply.status).toBeLessThan(300);
    const resolved = await api(ctx, `/comments/${thread.id}/resolved`, {
      method: "PUT",
      ...json({ resolved: true }),
    });
    expect(resolved.status).toBeLessThan(300);
  });

  it("sees the trash but brings nothing back", async () => {
    const ctx = await setup();
    const deleted = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/files/notes/a.md`, {
      method: "DELETE",
      headers: { cookie: ctx.owner.cookie, "if-match": '"1"' },
    });
    expect(deleted.status).toBe(204);

    const trash = (await (await api(ctx, "/trash")).json()) as { items: { path: string }[] };
    expect(trash.items.map((i) => i.path)).toEqual(["notes/a.md"]);

    const recoveries = [
      { kind: "trash", paths: ["notes/a.md"] },
      { kind: "restore", at: new Date().toISOString() },
      { kind: "undo", keyId: "any", since: new Date(0).toISOString() },
    ];
    for (const body of recoveries) {
      for (const route of ["/recovery/preview", "/recovery/apply"]) {
        await expectReadOnly(await api(ctx, route, { method: "POST", ...json(body) }));
      }
    }
    const svc = useFileService();
    expect(await svc.stat(ctx.ws.id, "notes/a.md", "trusted")).toBeNull();
  });

  it("doesn't see restricted nodes, and they stay not-found rather than read-only", async () => {
    const ctx = await setup();
    await setNodePrivate({
      workspaceId: ctx.ws.id,
      path: "notes",
      kind: "folder",
      ownerId: ctx.owner.userId,
    });
    const list = (await (await api(ctx, "/list")).json()) as { entries: { path: string }[] };
    expect(list.entries.map((e) => e.path)).not.toContain("notes/a.md");
    expect((await api(ctx, "/files/notes/a.md")).status).toBe(404);
    // A viewer learning "read-only" here would learn the node exists.
    const put = await api(ctx, "/files/notes/a.md", {
      method: "PUT",
      body: "x",
      headers: { "if-match": '"1"' },
    });
    expect(put.status).toBe(404);
  });

  it("a demotion narrows the member and their existing key on the next request", async () => {
    const ctx = await setup();
    await db.member.updateMany({
      where: { organizationId: ctx.ws.organizationId, userId: ctx.viewer.userId },
      data: { role: "member" },
    });
    const put = (path: string) =>
      fetch(`${BASE}/api/workspaces/${ctx.ws.id}/files/${path}`, {
        method: "PUT",
        body: "from a key",
        headers: { "x-api-key": ctx.key, "if-none-match": "*" },
      });
    expect((await put("before.md")).status).toBe(201);
    await db.member.updateMany({
      where: { organizationId: ctx.ws.organizationId, userId: ctx.viewer.userId },
      data: { role: "viewer" },
    });
    await expectReadOnly(await put("after.md"));
  });
});

describe.skipIf(!serverUp)("changing a member's role", () => {
  const setRole = (cookie: string, workspaceId: string, userId: string, role: unknown) =>
    fetch(`${BASE}/api/workspaces/${workspaceId}/members/${userId}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
  const roleOf = async (organizationId: string, userId: string) =>
    (await db.member.findFirst({ where: { organizationId, userId } }))?.role;

  it("an owner can move someone between member and viewer", async () => {
    const ctx = await setup();
    const { organizationId, id } = ctx.ws;
    expect((await setRole(ctx.owner.cookie, id, ctx.viewer.userId, "member")).status).toBe(200);
    expect(await roleOf(organizationId, ctx.viewer.userId)).toBe("member");
    expect((await setRole(ctx.owner.cookie, id, ctx.viewer.userId, "viewer")).status).toBe(200);
    expect(await roleOf(organizationId, ctx.viewer.userId)).toBe("viewer");
  });

  it("refuses roles it can't hand out", async () => {
    const ctx = await setup();
    for (const role of ["owner", "admin", "superuser", "", null, 7]) {
      const res = await setRole(ctx.owner.cookie, ctx.ws.id, ctx.viewer.userId, role);
      expect(res.status).toBe(400);
    }
    expect(await roleOf(ctx.ws.organizationId, ctx.viewer.userId)).toBe("viewer");
  });

  it("a member or viewer can't change roles", async () => {
    const ctx = await setup();
    const third = await signUp("third");
    await join(ctx.ws.organizationId, third.userId, "member");
    expect((await setRole(third.cookie, ctx.ws.id, ctx.viewer.userId, "member")).status).toBe(403);
    expect((await setRole(ctx.viewer.cookie, ctx.ws.id, third.userId, "viewer")).status).toBe(403);
  });

  it("nobody changes an owner, or their own role", async () => {
    const ctx = await setup();
    const coOwner = await signUp("coowner");
    await join(ctx.ws.organizationId, coOwner.userId, "owner");
    const onOwner = await setRole(ctx.owner.cookie, ctx.ws.id, coOwner.userId, "viewer");
    expect(onOwner.status).toBe(403);
    const onSelf = await setRole(ctx.owner.cookie, ctx.ws.id, ctx.owner.userId, "viewer");
    expect(onSelf.status).toBe(409);
  });

  it("an admin can't demote another admin, but an owner can", async () => {
    const ctx = await setup();
    const a = await signUp("adminA");
    const b = await signUp("adminB");
    await join(ctx.ws.organizationId, a.userId, "admin");
    await join(ctx.ws.organizationId, b.userId, "admin");
    expect((await setRole(a.cookie, ctx.ws.id, b.userId, "member")).status).toBe(403);
    expect((await setRole(a.cookie, ctx.ws.id, ctx.viewer.userId, "member")).status).toBe(200);
    expect((await setRole(ctx.owner.cookie, ctx.ws.id, b.userId, "member")).status).toBe(200);
  });

  it("a key can't change roles, even its owner's", async () => {
    const ctx = await setup();
    const key = await auth.api.createApiKey({
      body: {
        userId: ctx.owner.userId,
        name: "owner-key",
        metadata: { workspaceId: ctx.ws.id, actorType: "human" },
      },
    });
    const res = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/members/${ctx.viewer.userId}`, {
      method: "PUT",
      headers: { "x-api-key": key.key, "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(403);
    expect(await roleOf(ctx.ws.organizationId, ctx.viewer.userId)).toBe("viewer");
  });
});

describe.skipIf(!serverUp)("invite links and roles", () => {
  const mint = (cookie: string, body: object) =>
    fetch(`${BASE}/api/invites`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("a viewer can't mint an invite link", async () => {
    const ctx = await setup();
    await expectReadOnly(await mint(ctx.viewer.cookie, { workspaceId: ctx.ws.id }));
  });

  it("a viewer link joins as a viewer and says so up front", async () => {
    const ctx = await setup();
    const minted = await mint(ctx.owner.cookie, { workspaceId: ctx.ws.id, role: "viewer" });
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };

    const preview = (await (await fetch(`${BASE}/api/invites/${token}`)).json()) as {
      role: string;
    };
    expect(preview.role).toBe("viewer");

    const guest = await signUp("guest");
    const accepted = await fetch(`${BASE}/api/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: guest.cookie },
    });
    expect(accepted.status).toBe(200);
    const row = await db.member.findFirst({
      where: { organizationId: ctx.ws.organizationId, userId: guest.userId },
    });
    expect(row?.role).toBe("viewer");
  });

  it("refuses to mint a link for a role it can't hand out", async () => {
    const ctx = await setup();
    for (const role of ["owner", "admin", "nope"]) {
      expect((await mint(ctx.owner.cookie, { workspaceId: ctx.ws.id, role })).status).toBe(400);
    }
  });
});

describe.skipIf(!serverUp)("viewer role (MCP)", () => {
  // The same refusals through both registration surfaces: the workspace-scoped
  // server, and the user-scoped one that takes a workspaceId on every call.
  const surfaces = [
    {
      name: "workspace key",
      client: (ctx: Ctx) => connect(ctx.key),
      args: (_ctx: Ctx, a: Record<string, unknown>) => a,
    },
    {
      name: "user key",
      client: (ctx: Ctx) => connect(ctx.userKey),
      args: (ctx: Ctx, a: Record<string, unknown>) => ({ workspaceId: ctx.ws.id, ...a }),
    },
  ];

  describe.each(surfaces)("$name", ({ client, args }) => {
    it("reads, and is refused every write in words that stop a retry", async () => {
      const ctx = await setup();
      const c = await client(ctx);
      const call = (name: string, a: Record<string, unknown>) =>
        c.callTool({ name, arguments: args(ctx, a) });

      const read = await call("read_file", { path: "notes/a.md" });
      expect(read.isError).toBeFalsy();
      expect(textOf(read)).toContain("# hello");
      expect((await call("get_links", { path: "notes/a.md" })).isError).toBeFalsy();
      expect((await call("list_tags", {})).isError).toBeFalsy();

      const refused: [string, Record<string, unknown>][] = [
        ["write_file", { path: "notes/a.md", content: "x", baseVersion: 1 }],
        ["write_file", { path: "new.md", content: "x" }],
        [
          "edit_file",
          {
            path: "notes/a.md",
            oldString: "hello",
            newString: "hi",
            baseVersion: 1,
          },
        ],
        ["move_file", { from: "notes/a.md", to: "b.md" }],
        ["delete_file", { path: "notes/a.md", baseVersion: 1 }],
        ["restore_file", { path: "notes/a.md", targetVersion: 1 }],
        ["set_private", { path: "notes", kind: "folder" }],
        ["set_private", { path: "notes", private: false }],
        ["set_file_icon", { path: "notes", icon: "🌳" }],
        ["create_share", { path: "notes/a.md", kind: "file" }],
        ["revoke_share", { shareId: "any" }],
        ["set_workspace", { name: "Mine now" }],
        ["set_workspace_image_icon", { content: "AAAA" }],
        ["restore_from_trash", { paths: ["notes/a.md"] }],
        ["preview_restore_to", { at: "2026-01-01T00:00:00Z" }],
        ["restore_to", { at: "2026-01-01T00:00:00Z", previewToken: "any" }],
        ["preview_undo_my_changes", { since: "2026-01-01T00:00:00Z" }],
        ["undo_my_changes", { since: "2026-01-01T00:00:00Z", previewToken: "any" }],
      ];
      for (const [name, a] of refused) {
        const res = await call(name, a);
        expect(res.isError, name).toBe(true);
        expect(textOf(res), name).toMatch(/^Read-only:/);
      }
      const svc = useFileService();
      expect(await svc.stat(ctx.ws.id, "notes/a.md", "trusted")).toMatchObject({ version: 1 });
      expect(await svc.stat(ctx.ws.id, "new.md", "trusted")).toBeNull();
    }, 30_000);

    it("can comment", async () => {
      const ctx = await setup();
      const c = await client(ctx);
      const res = await c.callTool({
        name: "add_comment",
        arguments: args(ctx, { path: "notes/a.md", quote: "hello", body: "Looks good." }),
      });
      expect(res.isError).toBeFalsy();
    });
  });

  it("the user surface applies each workspace's own role", async () => {
    // Viewer in ctx.ws, owner of a workspace of their own: one key, two answers.
    const ctx = await setup();
    const own = await createWorkspaceWithOrg({ userId: ctx.viewer.userId, name: "Mine" });
    const c = await connect(ctx.userKey);
    const here = await c.callTool({
      name: "write_file",
      arguments: { workspaceId: ctx.ws.id, path: "x.md", content: "x" },
    });
    expect(here.isError).toBe(true);
    const there = await c.callTool({
      name: "write_file",
      arguments: { workspaceId: own.id, path: "x.md", content: "x" },
    });
    expect(there.isError).toBeFalsy();
  });
});