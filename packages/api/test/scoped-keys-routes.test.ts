import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// Scoped API keys, end to end against a RUNNING api: a key can be read-only
// and/or confined to one folder, it never exceeds its owner, and everything it
// is refused says why. Server-gated.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3010";
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { createWorkspaceWithOrg } = await import("../server/utils/workspace");
const { clearNodePrivate, setNodePrivate } = await import("../server/utils/acl");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function signUp(label: string) {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const email = `key${label}${stamp}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: `Key ${label}` },
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

const mint = (cookie: string, body: object) =>
  fetch(`${BASE}/api/keys`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function keyFor(cookie: string, body: object): Promise<string> {
  const res = await mint(cookie, { actorType: "agent", ...body });
  if (!res.ok) throw new Error(`mint failed (${res.status})`);
  return ((await res.json()) as { key: string }).key;
}

/** A workspace with files in and out of `clients/acme`, and an owner holding keys. */
async function setup() {
  const owner = await signUp("owner");
  const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Keys" });
  const put = (path: string, body: string) =>
    fetch(`${BASE}/api/workspaces/${ws.id}/files/${path}`, {
      method: "PUT",
      body,
      headers: { cookie: owner.cookie, "content-type": "text/markdown", "if-none-match": "*" },
    });
  for (const [path, body] of [
    ["clients/acme/brief.md", "# Acme brief\n"],
    ["clients/other/secret.md", "# Other client\n"],
    ["clients/acme2/sibling.md", "# Shares a prefix\n"],
  ] as const) {
    const res = await put(path, body);
    if (!res.ok) throw new Error(`seed failed (${res.status})`);
  }
  const workspaceId = ws.id;
  return {
    owner,
    ws,
    readKey: await keyFor(owner.cookie, { workspaceId, access: "read" }),
    folderKey: await keyFor(owner.cookie, { workspaceId, folder: "clients/acme" }),
    readFolderKey: await keyFor(owner.cookie, {
      workspaceId,
      access: "read",
      folder: "clients/acme",
    }),
    fullKey: await keyFor(owner.cookie, { workspaceId }),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const withKey = (ctx: Ctx, key: string, path: string, init: RequestInit = {}) =>
  fetch(`${BASE}/api/workspaces/${ctx.ws.id}${path}`, {
    ...init,
    headers: { "x-api-key": key, ...init.headers },
  });
const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
const putFile = (ctx: Ctx, key: string, path: string, headers: Record<string, string>) =>
  withKey(ctx, key, `/files/${path}`, { method: "PUT", body: "changed", headers });

async function expectDenied(res: Response, data: object) {
  expect(res.status).toBe(409);
  expect(((await res.json()) as { data?: unknown }).data).toEqual(data);
}
const READ_ONLY = { error: "read_only", reason: "key" };
const OUTSIDE = { error: "outside_key_folder", folder: "clients/acme" };

/** A note in the key's folder and one beyond it, both linking to the brief. */
async function seedLinks(ctx: Ctx) {
  for (const [path, body] of [
    ["clients/acme/tagged.md", "See [[brief]]. #acme\n"],
    ["clients/other/tagged.md", "See [[brief]]. #other\n"],
  ] as const) {
    const res = await withKey(ctx, ctx.fullKey, `/files/${path}`, {
      method: "PUT",
      body,
      headers: { "content-type": "text/markdown", "if-none-match": "*" },
    });
    expect(res.status).toBe(201);
  }
}

async function connect(key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    requestInit: { headers: { "x-api-key": key } },
  });
  const client = new Client({ name: "scoped-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe.skipIf(!serverUp)("minting a scoped key", () => {
  it("records the scope and reports it to the key's owner", async () => {
    const ctx = await setup();
    const res = await mint(ctx.owner.cookie, {
      workspaceId: ctx.ws.id,
      access: "read",
      folder: "clients/acme",
    });
    expect(((await res.json()) as { scope: unknown }).scope).toEqual({
      access: "read",
      folder: "clients/acme",
    });
    const listed = (await (
      await fetch(`${BASE}/api/keys`, { headers: { cookie: ctx.owner.cookie } })
    ).json()) as { keys: { metadata: { scope?: unknown } }[] };
    expect(listed.keys.some((k) => k.metadata.scope)).toBe(true);
  });

  it("refuses a bad scope rather than minting a wider key", async () => {
    const ctx = await setup();
    const workspaceId = ctx.ws.id;
    for (const body of [
      { workspaceId, access: "admin" },
      { workspaceId, folder: "../escape" },
      { workspaceId, folder: 7 },
      // A folder means nothing without the workspace it's in.
      { folder: "clients/acme" },
    ]) {
      expect((await mint(ctx.owner.cookie, body)).status).toBe(400);
    }
  });

  it("won't confirm a folder the creator can't see", async () => {
    const ctx = await setup();
    const other = await signUp("other");
    await db.member.create({
      data: {
        id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
        organizationId: ctx.ws.organizationId,
        userId: other.userId,
        role: "member",
      },
    });
    await setNodePrivate({
      workspaceId: ctx.ws.id,
      path: "clients/other",
      kind: "folder",
      ownerId: ctx.owner.userId,
    });
    const res = await mint(other.cookie, { workspaceId: ctx.ws.id, folder: "clients/other" });
    expect(res.status).toBe(404);
  });

  it("a key with a damaged scope stops working rather than widening", async () => {
    const ctx = await setup();
    const key = await auth.api.createApiKey({
      body: {
        userId: ctx.owner.userId,
        name: "damaged",
        metadata: { workspaceId: ctx.ws.id, actorType: "agent", scope: { access: "everything" } },
      },
    });
    const res = await withKey(ctx, key.key, "/list");
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!serverUp)("approving a device with limits", () => {
  it("delivers a key carrying the limits chosen on the approval screen", async () => {
    const ctx = await setup();
    const code = (await (await fetch(`${BASE}/api/device/code`, { method: "POST" })).json()) as {
      device_code: string;
      user_code: string;
    };
    const approved = await fetch(`${BASE}/api/device/approve`, {
      method: "POST",
      headers: { cookie: ctx.owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        user_code: code.user_code,
        workspaceId: ctx.ws.id,
        access: "read",
        folder: "clients/acme",
      }),
    });
    expect(approved.status).toBe(200);

    const rows = await db.apikey.findMany({ where: { referenceId: ctx.owner.userId } });
    const minted = rows.map((r) => JSON.parse(r.metadata ?? "{}") as { scope?: object });
    expect(minted.filter((m) => m.scope)).toContainEqual(
      expect.objectContaining({ scope: { access: "read", folder: "clients/acme" } }),
    );
  });

  it("refuses bad limits before the code is spent", async () => {
    const ctx = await setup();
    const code = (await (await fetch(`${BASE}/api/device/code`, { method: "POST" })).json()) as {
      user_code: string;
    };
    const approve = (extra: object) =>
      fetch(`${BASE}/api/device/approve`, {
        method: "POST",
        headers: { cookie: ctx.owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ user_code: code.user_code, workspaceId: ctx.ws.id, ...extra }),
      });
    expect((await approve({ access: "admin" })).status).toBe(400);
    expect((await approve({})).status).toBe(200);
  });
});

describe.skipIf(!serverUp)("a key can't escape its scope", () => {
  const authRoute = (key: string, path: string, body: object) =>
    fetch(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    });

  it("can't mint itself a wider key through better-auth", async () => {
    const ctx = await setup();
    const before = await db.apikey.count({ where: { referenceId: ctx.owner.userId } });
    const res = await authRoute(ctx.readKey, "/api-key/create", {
      name: "escape",
      metadata: { workspaceId: ctx.ws.id, actorType: "agent" },
    });
    expect(res.status).toBe(403);
    expect(await db.apikey.count({ where: { referenceId: ctx.owner.userId } })).toBe(before);
  });

  it("can't rewrite its own scope through better-auth", async () => {
    const ctx = await setup();
    const row = await db.apikey.findFirst({
      where: { referenceId: ctx.owner.userId, metadata: { contains: "clients/acme" } },
    });
    const res = await authRoute(ctx.folderKey, "/api-key/update", {
      keyId: row?.id,
      metadata: { workspaceId: ctx.ws.id, actorType: "agent" },
    });
    expect(res.status).toBe(403);
    expect((await db.apikey.findUnique({ where: { id: row?.id } }))?.metadata).toBe(row?.metadata);
  });

  it("can't reach key management, member management or invites", async () => {
    const ctx = await setup();
    const key = ctx.fullKey;
    expect(
      (
        await fetch(`${BASE}/api/keys`, {
          method: "POST",
          headers: { "x-api-key": key, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await withKey(ctx, key, `/members/${ctx.owner.userId}`, {
          method: "PUT",
          ...json({ role: "viewer" }),
        })
      ).status,
    ).toBe(403);
  });

  it("never exceeds its owner: a demotion narrows a full key on the next call", async () => {
    const ctx = await setup();
    const member = await signUp("member");
    await db.member.create({
      data: {
        id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
        organizationId: ctx.ws.organizationId,
        userId: member.userId,
        role: "member",
      },
    });
    const key = await keyFor(member.cookie, { workspaceId: ctx.ws.id });
    expect((await putFile(ctx, key, "by-member.md", { "if-none-match": "*" })).status).toBe(201);
    await db.member.updateMany({
      where: { organizationId: ctx.ws.organizationId, userId: member.userId },
      data: { role: "viewer" },
    });
    await expectDenied(await putFile(ctx, key, "after.md", { "if-none-match": "*" }), {
      error: "read_only",
      reason: "role",
    });
  });

  it("can't reach what its owner can't", async () => {
    const ctx = await setup();
    await setNodePrivate({
      workspaceId: ctx.ws.id,
      path: "clients/acme",
      kind: "folder",
      ownerId: "someone-else",
    });
    expect((await withKey(ctx, ctx.folderKey, "/files/clients/acme/brief.md")).status).toBe(404);
  });
});

describe.skipIf(!serverUp)("a read-only key", () => {
  it("can't make a workspace by asking for one it doesn't have", async () => {
    const person = await signUp("empty");
    const key = await keyFor(person.cookie, { access: "read" });
    await db.member.deleteMany({ where: { userId: person.userId } });
    const res = await fetch(`${BASE}/api/workspace`, { headers: { "x-api-key": key } });
    expect(res.status).toBe(404);
    expect(await db.member.count({ where: { userId: person.userId } })).toBe(0);
  });

  it("follows links and tags, and can't move a note to rewrite them", async () => {
    const ctx = await setup();
    await seedLinks(ctx);
    const links = await withKey(ctx, ctx.readKey, "/links?path=clients/acme/brief.md");
    expect(((await links.json()) as { backlinks: string[] }).backlinks).toHaveLength(2);
    expect((await withKey(ctx, ctx.readKey, "/tags")).status).toBe(200);
    await expectDenied(
      await withKey(ctx, ctx.readKey, "/move", {
        method: "POST",
        ...json({ from: "clients/acme/brief.md", to: "clients/acme/z.md", updateLinks: true }),
      }),
      READ_ONLY,
    );
    const note = await withKey(ctx, ctx.fullKey, "/files/clients/acme/tagged.md");
    expect(await note.text()).toBe("See [[brief]]. #acme\n");
  });

  it("reads, and is told it can't write", async () => {
    const ctx = await setup();
    expect((await withKey(ctx, ctx.readKey, "/files/clients/acme/brief.md")).status).toBe(200);
    await expectDenied(
      await putFile(ctx, ctx.readKey, "clients/acme/brief.md", { "if-match": '"1"' }),
      READ_ONLY,
    );
    await expectDenied(
      await withKey(ctx, ctx.readKey, "/files/clients/acme/brief.md", {
        method: "DELETE",
        headers: { "if-match": '"1"' },
      }),
      READ_ONLY,
    );
    await expectDenied(
      await withKey(ctx, ctx.readKey, "/move", {
        method: "POST",
        ...json({ from: "clients/acme/brief.md", to: "b.md" }),
      }),
      READ_ONLY,
    );
    await expectDenied(
      await withKey(ctx, ctx.readKey, "/shares", {
        method: "POST",
        ...json({ path: "clients/acme/brief.md", kind: "file", access: "member" }),
      }),
      READ_ONLY,
    );
    await expectDenied(
      await withKey(ctx, ctx.readKey, "", { method: "PATCH", ...json({ name: "Mine" }) }),
      READ_ONLY,
    );
    await expectDenied(
      await withKey(ctx, ctx.readKey, "/recovery/preview", {
        method: "POST",
        ...json({ kind: "restore", at: new Date().toISOString() }),
      }),
      READ_ONLY,
    );
  });

  it("can comment: a review agent is the point of one", async () => {
    const ctx = await setup();
    const res = await withKey(ctx, ctx.readKey, "/comments", {
      method: "POST",
      ...json({
        path: "clients/acme/brief.md",
        kind: "range",
        quote: "Acme",
        contextBefore: "# ",
        contextAfter: " brief",
        body: "Is this the right client?",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("is reported as read-only on the workspace", async () => {
    const ctx = await setup();
    const meta = (await (await withKey(ctx, ctx.readKey, "")).json()) as { access: unknown };
    expect(meta.access).toEqual({
      role: "owner",
      canWrite: false,
      key: { access: "read", folder: null },
    });
  });
});

describe.skipIf(!serverUp)("a key confined to a folder", () => {
  it("sees the links and tags inside it and nothing beyond", async () => {
    const ctx = await setup();
    await seedLinks(ctx);
    const get = async (path: string) => (await withKey(ctx, ctx.folderKey, path)).json();
    const links = (await get("/links?path=clients/acme/brief.md")) as { backlinks: string[] };
    expect(links.backlinks).toEqual(["clients/acme/tagged.md"]);
    const tags = (await get("/tags")) as { tags: { tag: string }[] };
    expect(tags.tags.map((t) => t.tag)).toEqual(["acme"]);
    expect(((await get("/tags?tag=other")) as { paths: string[] }).paths).toEqual([]);
    await expectDenied(
      await withKey(ctx, ctx.folderKey, "/links?path=clients/other/secret.md"),
      OUTSIDE,
    );
  });

  it("reads and writes inside it", async () => {
    const ctx = await setup();
    expect((await withKey(ctx, ctx.folderKey, "/files/clients/acme/brief.md")).status).toBe(200);
    const res = await putFile(ctx, ctx.folderKey, "clients/acme/new.md", { "if-none-match": "*" });
    expect(res.status).toBe(201);
  });

  it("is told plainly it's outside, whether or not the path exists", async () => {
    const ctx = await setup();
    for (const path of ["clients/other/secret.md", "clients/nothing-here.md"]) {
      await expectDenied(await withKey(ctx, ctx.folderKey, `/files/${path}`), OUTSIDE);
      await expectDenied(
        await putFile(ctx, ctx.folderKey, path, { "if-none-match": "*" }),
        OUTSIDE,
      );
    }
    await expectDenied(
      await withKey(ctx, ctx.folderKey, "/version?path=clients/other/secret.md&version=1"),
      OUTSIDE,
    );
  });

  it("can't write a file at the folder's own path, whose copy would land outside", async () => {
    const ctx = await setup();
    await expectDenied(
      await putFile(ctx, ctx.folderKey, "clients/acme", { "if-none-match": "*" }),
      OUTSIDE,
    );
  });

  it("isn't fooled by a sibling sharing its prefix", async () => {
    const ctx = await setup();
    await expectDenied(
      await withKey(ctx, ctx.folderKey, "/files/clients/acme2/sibling.md"),
      OUTSIDE,
    );
  });

  it("can't move anything out of it, or in from outside", async () => {
    const ctx = await setup();
    await expectDenied(
      await withKey(ctx, ctx.folderKey, "/move", {
        method: "POST",
        ...json({ from: "clients/acme/brief.md", to: "stolen.md" }),
      }),
      OUTSIDE,
    );
    await expectDenied(
      await withKey(ctx, ctx.folderKey, "/move", {
        method: "POST",
        ...json({ from: "clients/other/secret.md", to: "clients/acme/secret.md" }),
      }),
      OUTSIDE,
    );
  });

  it("can't change the workspace itself", async () => {
    const ctx = await setup();
    await expectDenied(
      await withKey(ctx, ctx.folderKey, "", { method: "PATCH", ...json({ name: "Mine" }) }),
      OUTSIDE,
    );
  });

  it("sees only its folder in the tree, search, feed and metadata", async () => {
    const ctx = await setup();
    // Metadata on a node outside the folder would name it.
    await db.nodeMeta.create({
      data: { workspaceId: ctx.ws.id, path: "clients/other", icon: "🔒" },
    });
    const list = (await (await withKey(ctx, ctx.folderKey, "/list")).json()) as {
      entries: { path: string }[];
      icons: Record<string, string>;
    };
    expect(list.entries.map((e) => e.path)).toEqual(["clients/acme/brief.md"]);
    expect(list.icons).toEqual({});

    const search = (await (await withKey(ctx, ctx.folderKey, "/search?q=secret")).json()) as {
      results: unknown[];
    };
    expect(search.results).toEqual([]);

    const feed = (await (await withKey(ctx, ctx.folderKey, "/changes?sinceSeq=0")).json()) as {
      changes: { path: string }[];
    };
    expect([...new Set(feed.changes.map((c) => c.path))]).toEqual(["clients/acme/brief.md"]);
  });

  it("isn't told about a node restricted outside its folder", async () => {
    const ctx = await setup();
    await setNodePrivate({
      workspaceId: ctx.ws.id,
      path: "clients/other",
      kind: "folder",
      ownerId: ctx.owner.userId,
      actor: {
        principal: "human",
        actorId: ctx.owner.userId,
        access: { userId: ctx.owner.userId, role: "owner" },
      },
    });
    const feed = (await (await withKey(ctx, ctx.folderKey, "/changes?sinceSeq=0")).json()) as {
      changes: { path: string; op: string }[];
    };
    expect(feed.changes.filter((c) => c.op === "access_revoked")).toEqual([]);
  });

  it("hears about access changes above its folder, narrowed to the folder", async () => {
    const ctx = await setup();
    const actor = {
      principal: "human" as const,
      actorId: ctx.owner.userId,
      access: { userId: "someone-else", role: "owner" as const },
    };
    // Private to someone else, so this key's owner loses the subtree it reaches.
    await setNodePrivate({
      workspaceId: ctx.ws.id,
      path: "clients",
      kind: "folder",
      ownerId: "someone-else",
      actor,
    });
    const events = async () =>
      (
        (await (await withKey(ctx, ctx.folderKey, "/changes?sinceSeq=0")).json()) as {
          changes: { path: string; op: string }[];
        }
      ).changes.filter((c) => c.op.startsWith("access_"));
    expect(await events()).toMatchObject([{ op: "access_revoked", path: "clients/acme" }]);

    await clearNodePrivate(ctx.ws.id, "clients", { ...actor, actorId: "someone-else" });
    expect((await events()).map((e) => [e.op, e.path])).toEqual([
      ["access_granted", "clients/acme"],
    ]);
  });

  it("only sees comments in its folder", async () => {
    const ctx = await setup();
    for (const [path, quote] of [
      ["clients/acme/brief.md", "Acme"],
      ["clients/other/secret.md", "Other"],
    ] as const) {
      const res = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/comments`, {
        method: "POST",
        headers: { cookie: ctx.owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ path, kind: "range", quote, body: "A note" }),
      });
      expect(res.status).toBe(201);
    }
    const res = await withKey(ctx, ctx.folderKey, "/comments");
    const { threads } = (await res.json()) as { threads: { path: string }[] };
    expect(threads.map((t) => t.path)).toEqual(["clients/acme/brief.md"]);
  });

  it("isn't handed a folder link wider than its folder", async () => {
    const ctx = await setup();
    const share = (path: string) =>
      fetch(`${BASE}/api/workspaces/${ctx.ws.id}/shares`, {
        method: "POST",
        headers: { cookie: ctx.owner.cookie, "content-type": "application/json" },
        body: JSON.stringify({ path, kind: "folder", access: "public" }),
      });
    expect((await share("clients")).ok).toBe(true);
    expect((await share("clients/acme")).ok).toBe(true);
    const inherited = async (key: string) => {
      const res = await withKey(ctx, key, "/shares?path=clients/acme/brief.md");
      return ((await res.json()) as { inherited: { path: string }[] }).inherited.map((s) => s.path);
    };
    expect(await inherited(ctx.folderKey)).toEqual(["clients/acme"]);
    expect((await inherited(ctx.fullKey)).sort()).toEqual(["clients", "clients/acme"]);
  });

  it("is told it's outside when listing a path's share links", async () => {
    const ctx = await setup();
    for (const path of ["clients/other/secret.md", "clients/nothing-here.md"]) {
      await expectDenied(await withKey(ctx, ctx.folderKey, `/shares?path=${path}`), OUTSIDE);
    }
  });

  it("only touches share links in its folder", async () => {
    const ctx = await setup();
    const created = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/shares`, {
      method: "POST",
      headers: { cookie: ctx.owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "clients/other/secret.md", kind: "file", access: "member" }),
    });
    const { share } = (await created.json()) as { share: { id: string } };
    await expectDenied(
      await withKey(ctx, ctx.folderKey, `/shares/${share.id}`, { method: "DELETE" }),
      OUTSIDE,
    );
  });
});

describe.skipIf(!serverUp)("scoped keys over MCP", () => {
  const surfaces = [
    {
      name: "workspace key",
      key: (ctx: Ctx, which: "readKey" | "folderKey") => ctx[which],
      args: (_ctx: Ctx, a: Record<string, unknown>) => a,
    },
  ];

  describe.each(surfaces)("$name", ({ key, args }) => {
    it("a read-only key reads and gets a clear refusal on every change", async () => {
      const ctx = await setup();
      const c = await connect(key(ctx, "readKey"));
      const call = (name: string, a: Record<string, unknown>) =>
        c.callTool({ name, arguments: args(ctx, a) });
      expect((await call("read_file", { path: "clients/acme/brief.md" })).isError).toBeFalsy();
      expect((await call("get_links", { path: "clients/acme/brief.md" })).isError).toBeFalsy();
      expect((await call("list_tags", {})).isError).toBeFalsy();
      for (const [name, a] of [
        ["write_file", { path: "clients/acme/brief.md", content: "x", baseVersion: 1 }],
        ["move_file", { from: "clients/acme/brief.md", to: "clients/acme/z.md" }],
        ["delete_file", { path: "clients/acme/brief.md", baseVersion: 1 }],
        ["set_private", { path: "clients" }],
        ["create_share", { path: "clients/acme/brief.md", kind: "file" }],
        ["set_workspace", { name: "Mine" }],
        ["restore_to", { at: "2026-01-01T00:00:00Z", previewToken: "any" }],
      ] as const) {
        const res = await call(name, a);
        expect(res.isError, name).toBe(true);
        expect(textOf(res), name).toMatch(/^Read-only: this API key can only read/);
      }
    }, 30_000);

    it("a folder key is told it's outside, and works inside", async () => {
      const ctx = await setup();
      const c = await connect(key(ctx, "folderKey"));
      const call = (name: string, a: Record<string, unknown>) =>
        c.callTool({ name, arguments: args(ctx, a) });
      const outside = /^Outside this key's folder \(clients\/acme\)/;
      for (const prefix of ["clients", "clients/", "/clients"]) {
        const listed = await call("list_files", { prefix });
        expect(listed.isError, prefix).toBeFalsy();
        expect(textOf(listed), prefix).toContain("clients/acme/brief.md");
        expect(textOf(listed), prefix).not.toContain("clients/other");
      }
      await seedLinks(ctx);
      for (const path of ["clients/other/secret.md", "clients/nothing-here.md"]) {
        for (const tool of ["read_file", "get_links"]) {
          const read = await call(tool, { path });
          expect(read.isError, tool).toBe(true);
          expect(textOf(read), tool).toMatch(outside);
        }
      }
      const links = await call("get_links", { path: "clients/acme/brief.md" });
      expect(textOf(links)).toContain("clients/acme/tagged.md");
      expect(textOf(links)).not.toContain("clients/other");
      const tags = await call("list_tags", {});
      expect(textOf(tags)).toContain("acme");
      expect(textOf(tags)).not.toContain("other");
      const wrote = await call("write_file", { path: "other.md", content: "x" });
      expect(textOf(wrote)).toMatch(outside);
      const inside = await call("write_file", { path: "clients/acme/new.md", content: "x" });
      expect(inside.isError).toBeFalsy();
      const listed = await call("list_files", { prefix: "clients" });
      expect(textOf(listed)).toContain("clients/acme/brief.md");
      expect(textOf(listed)).not.toContain("clients/other");
      const beyond = await call("list_files", { prefix: "clients/other" });
      expect(textOf(beyond)).toMatch(outside);
    }, 30_000);
  });

  it("tells the agent what the key can do, up front", async () => {
    const ctx = await setup();
    const read = await connect(ctx.readFolderKey);
    const instructions = read.getInstructions() ?? "";
    expect(instructions).toContain("read-only");
    expect(instructions).toContain("clients/acme");
    const full = await connect(ctx.fullKey);
    expect(full.getInstructions()).not.toContain("This API key is");
  });

  it("a read-only user key can't create a workspace", async () => {
    const ctx = await setup();
    const key = await keyFor(ctx.owner.cookie, { access: "read" });
    const c = await connect(key);
    const res = await c.callTool({ name: "create_workspace", arguments: { name: "Sneaky" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("limited API key");
  });

  it("a read-only user key is read-only in every workspace", async () => {
    const ctx = await setup();
    const key = await keyFor(ctx.owner.cookie, { access: "read" });
    const c = await connect(key);
    const res = await c.callTool({
      name: "write_file",
      arguments: { workspaceId: ctx.ws.id, path: "x.md", content: "x" },
    });
    expect(textOf(res)).toMatch(/^Read-only: this API key can only read/);
  });
});