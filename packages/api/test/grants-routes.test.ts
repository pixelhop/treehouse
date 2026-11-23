import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// Folder and file grants, end to end against a RUNNING api: a restricted folder
// is reachable only by its grantees, at the level each was given, on every
// surface, and the workspace's owner gets no way around that. Server-gated.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3010";
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { createWorkspaceWithOrg } = await import("../server/utils/workspace");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function signUp(label: string) {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const email = `grt${label}${stamp}@example.test`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: `Grt ${label}` },
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

type Person = Awaited<ReturnType<typeof signUp>>;

async function join(organizationId: string, userId: string, role = "member") {
  await db.member.create({
    data: {
      id: `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
      organizationId,
      userId,
      role,
    },
  });
}

/** `clients/` restricted to an editor and a view-only member, with an owner and an outsider left out. */
async function setup() {
  const owner = await signUp("owner");
  const editor = await signUp("editor");
  const viewer = await signUp("viewer");
  const outsider = await signUp("outsider");
  const ws = await createWorkspaceWithOrg({ userId: owner.userId, name: "Grants" });
  for (const p of [editor, viewer, outsider]) await join(ws.organizationId, p.userId);

  const ctx = { owner, editor, viewer, outsider, ws };
  const put = (who: Person, path: string, body: string) =>
    as(ctx, who, `/files/${path}`, {
      method: "PUT",
      body,
      headers: { "content-type": "text/markdown", "if-none-match": "*" },
    });
  for (const [path, body] of [
    ["clients/acme.md", "# Acme secret plan\n"],
    ["open/notes.md", "# Open notes\n"],
  ] as const) {
    const res = await put(editor, path, body);
    if (!res.ok) throw new Error(`seed failed (${res.status})`);
  }
  const set = await setAccess(ctx, editor, {
    path: "clients",
    kind: "folder",
    grants: [
      { userId: editor.userId, level: "write" },
      { userId: viewer.userId, level: "read" },
    ],
  });
  if (!set.ok) throw new Error(`restrict failed (${set.status})`);
  return { ...ctx, put };
}

type Base = { ws: { id: string; organizationId: string } };

const as = (ctx: Base, who: Person, path: string, init: RequestInit = {}) =>
  fetch(`${BASE}/api/workspaces/${ctx.ws.id}${path}`, {
    ...init,
    headers: { cookie: who.cookie, ...init.headers },
  });
const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
const setAccess = (ctx: Base, who: Person, body: unknown) =>
  as(ctx, who, "/node-access", { method: "PUT", ...json(body) });
const listed = async (ctx: Base, who: Person) =>
  ((await (await as(ctx, who, "/list")).json()) as { entries: { path: string }[] }).entries.map(
    (e) => e.path,
  );

describe.skipIf(!serverUp)("a restricted folder", () => {
  it("is visible only to its grantees, and the workspace owner isn't one", async () => {
    const ctx = await setup();
    expect(await listed(ctx, ctx.editor)).toContain("clients/acme.md");
    expect(await listed(ctx, ctx.viewer)).toContain("clients/acme.md");
    expect(await listed(ctx, ctx.outsider)).not.toContain("clients/acme.md");
    expect(await listed(ctx, ctx.owner)).not.toContain("clients/acme.md");
    for (const who of [ctx.outsider, ctx.owner]) {
      expect((await as(ctx, who, "/files/clients/acme.md")).status).toBe(404);
      const search = (await (await as(ctx, who, "/search?q=acme")).json()) as {
        results: unknown[];
      };
      expect(search.results).toEqual([]);
    }
    expect(await listed(ctx, ctx.outsider)).toContain("open/notes.md");
  });

  it("gives each grantee the level they were given", async () => {
    const ctx = await setup();
    const edit = (who: Person) =>
      as(ctx, who, "/files/clients/acme.md", {
        method: "PUT",
        body: "changed",
        headers: { "if-match": '"1"' },
      });
    const refused = await edit(ctx.viewer);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { data: unknown }).data).toEqual({
      error: "read_only",
      reason: "grant",
    });
    expect((await edit(ctx.outsider)).status).toBe(404);
    expect((await edit(ctx.owner)).status).toBe(404);
    expect((await edit(ctx.editor)).status).toBe(200);
  });

  it("doesn't let a view-only member's role exceed a grant, or a grant exceed a role", async () => {
    const ctx = await setup();
    const roleViewer = await signUp("roleviewer");
    await join(ctx.ws.organizationId, roleViewer.userId, "viewer");
    await setAccess(ctx, ctx.editor, {
      path: "clients",
      kind: "folder",
      grants: [
        { userId: ctx.editor.userId, level: "write" },
        { userId: roleViewer.userId, level: "write" },
      ],
    });
    const res = await as(ctx, roleViewer, "/files/clients/acme.md", {
      method: "PUT",
      body: "x",
      headers: { "if-match": '"1"' },
    });
    expect(res.status).toBe(409);
    expect((await as(ctx, roleViewer, "/files/clients/acme.md")).status).toBe(200);
  });

  it("can open to everyone at one level, with an edit grant or an exclusion on top", async () => {
    const ctx = await setup();
    await setAccess(ctx, ctx.editor, {
      path: "clients",
      kind: "folder",
      everyone: "read",
      grants: [{ userId: ctx.editor.userId, level: "write" }],
    });
    expect((await as(ctx, ctx.outsider, "/files/clients/acme.md")).status).toBe(200);
    const write = await as(ctx, ctx.outsider, "/files/clients/acme.md", {
      method: "PUT",
      body: "x",
      headers: { "if-match": '"1"' },
    });
    expect(write.status).toBe(409);
  });

  it("can't be given a share link, and an older link goes dead", async () => {
    const ctx = await setup();
    const shared = await as(ctx, ctx.editor, "/shares", {
      method: "POST",
      ...json({ path: "clients/acme.md", kind: "file", access: "public" }),
    });
    expect(shared.status).toBe(409);

    const made = await as(ctx, ctx.editor, "/shares", {
      method: "POST",
      ...json({ path: "open/notes.md", kind: "file", access: "public" }),
    });
    const { share } = (await made.json()) as { share: { token: string } };
    expect((await fetch(`${BASE}/api/share/${share.token}/file`)).status).toBe(200);
    await setAccess(ctx, ctx.editor, {
      path: "open",
      kind: "folder",
      grants: [{ userId: ctx.editor.userId, level: "write" }],
    });
    expect((await fetch(`${BASE}/api/share/${share.token}/file`)).status).toBe(404);
  });

  it("keeps its comments and version history to the same people", async () => {
    const ctx = await setup();
    const made = await as(ctx, ctx.viewer, "/comments", {
      method: "POST",
      ...json({ path: "clients/acme.md", kind: "range", quote: "secret", body: "Really?" }),
    });
    expect(made.status).toBe(201);
    const threads = async (who: Person) =>
      ((await (await as(ctx, who, "/comments")).json()) as { threads: unknown[] }).threads;
    expect(await threads(ctx.editor)).toHaveLength(1);
    expect(await threads(ctx.outsider)).toEqual([]);
    const history = "/version?path=clients/acme.md&version=1";
    expect((await as(ctx, ctx.viewer, history)).status).toBe(200);
    expect((await as(ctx, ctx.owner, history)).status).toBe(404);
  });

  it("tells a sync client who lost sight of it, and who gained it", async () => {
    const ctx = await setup();
    const access = async (who: Person) =>
      (
        (await (await as(ctx, who, "/changes?sinceSeq=0")).json()) as {
          changes: { path: string; op: string }[];
        }
      ).changes.filter((c) => c.op.startsWith("access_"));
    expect((await access(ctx.outsider)).map((e) => e.op)).toEqual(["access_revoked"]);
    // A grantee keeps the files, so nothing says to drop them.
    expect((await access(ctx.viewer)).map((e) => e.op)).toEqual(["access_granted"]);
    expect((await access(ctx.editor)).map((e) => e.op)).toEqual([]);

    const lifted = await setAccess(ctx, ctx.editor, { path: "clients", restricted: false });
    expect(lifted.status).toBe(200);
    // Told to pull, and not told to drop anything.
    expect((await access(ctx.outsider)).map((e) => e.op)).not.toContain("access_revoked");
    expect((await access(ctx.outsider)).map((e) => e.op)).toContain("access_granted");
  });

  describe("inside a folder someone can't see", () => {
    const accessOps = async (ctx: Base, who: Person) =>
      (
        (await (await as(ctx, who, "/changes?sinceSeq=0")).json()) as {
          changes: { path: string; op: string }[];
        }
      ).changes.filter((c) => c.op.startsWith("access_"));
    const revoked = async (ctx: Base, who: Person) =>
      (await accessOps(ctx, who)).filter((c) => c.op === "access_revoked").map((c) => c.path);

    /** clients is the editor's alone, and the viewer holds a grant on a folder in it. */
    async function nested() {
      const ctx = await setup();
      await ctx.put(ctx.editor, "clients/shared/brief.md", "# Brief\n");
      await setAccess(ctx, ctx.editor, {
        path: "clients",
        kind: "folder",
        grants: [{ userId: ctx.editor.userId, level: "write" }],
      });
      await setAccess(ctx, ctx.editor, {
        path: "clients/shared",
        kind: "folder",
        grants: [
          { userId: ctx.editor.userId, level: "write" },
          { userId: ctx.viewer.userId, level: "read" },
        ],
      });
      return ctx;
    }

    it("tells someone whose grant was taken away, and nobody else", async () => {
      const ctx = await nested();
      expect(await revoked(ctx, ctx.viewer)).not.toContain("clients/shared");
      const res = await setAccess(ctx, ctx.editor, {
        path: "clients/shared",
        kind: "folder",
        grants: [{ userId: ctx.editor.userId, level: "write" }],
      });
      expect(res.status).toBe(200);
      expect(await revoked(ctx, ctx.viewer)).toContain("clients/shared");
      expect(await revoked(ctx, ctx.outsider)).not.toContain("clients/shared");
    });

    it("stays hidden from someone a folder above kept out, even once that folder opens", async () => {
      const ctx = await setup();
      const { editor, outsider } = ctx;
      await ctx.put(editor, "clients/secret/plan.md", "# Plan\n");
      const alone = [{ userId: editor.userId, level: "write" }];
      await setAccess(ctx, editor, { path: "clients", kind: "folder", grants: alone });
      await setAccess(ctx, editor, { path: "clients/secret", kind: "folder", grants: alone });
      await setAccess(ctx, editor, {
        path: "clients",
        kind: "folder",
        everyone: "read",
        grants: alone,
      });
      expect(await revoked(ctx, outsider)).not.toContain("clients/secret");
    });

    it("tells someone a lifted restriction had let in, and nobody else", async () => {
      const ctx = await nested();
      const res = await setAccess(ctx, ctx.editor, { path: "clients/shared", restricted: false });
      expect(res.status).toBe(200);
      expect(await listed(ctx, ctx.viewer)).not.toContain("clients/shared/brief.md");
      expect(await revoked(ctx, ctx.viewer)).toContain("clients/shared");
      expect(await revoked(ctx, ctx.outsider)).not.toContain("clients/shared");
    });
  });

  describe("with links and tags", () => {
    const linksTo = async (ctx: Base, who: Person, path: string) =>
      (
        (await (await as(ctx, who, `/links?path=${path}`)).json()) as {
          backlinks: string[];
        }
      ).backlinks;
    const move = async (ctx: Base, who: Person, from: string, to: string) => {
      const res = await as(ctx, who, "/move", {
        method: "POST",
        ...json({ from, to, updateLinks: true }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { links: { updated: string[]; failed: string[] } }).links;
    };
    const read = async (ctx: Base, who: Person, path: string) =>
      (await as(ctx, who, `/files/${path}`)).text();

    it("keeps a restricted note out of everyone else's links and tags", async () => {
      const ctx = await setup();
      await ctx.put(ctx.editor, "clients/brief.md", "See [[notes]]. #secret\n");
      expect(await linksTo(ctx, ctx.viewer, "open/notes.md")).toEqual(["clients/brief.md"]);
      expect(await linksTo(ctx, ctx.outsider, "open/notes.md")).toEqual([]);

      const tagged = async (who: Person) =>
        (
          (await (await as(ctx, who, "/tags?tag=secret")).json()) as {
            paths: string[];
          }
        ).paths;
      expect(await tagged(ctx.viewer)).toEqual(["clients/brief.md"]);
      expect(await tagged(ctx.outsider)).toEqual([]);
      const all = (await (await as(ctx, ctx.outsider, "/tags")).json()) as {
        tags: { tag: string }[];
      };
      expect(all.tags.map((t) => t.tag)).not.toContain("secret");
      expect((await as(ctx, ctx.outsider, "/links?path=clients/brief.md")).status).toBe(404);
    });

    it("rewrites a restricted file's name only where the same people can read it", async () => {
      const ctx = await setup();
      await ctx.put(ctx.editor, "open/index.md", "[[acme]]\n");
      await ctx.put(ctx.editor, "clients/other.md", "[[acme]]\n");
      const links = await move(ctx, ctx.editor, "clients/acme.md", "clients/renamed.md");
      expect(links.updated).toContain("clients/other.md");
      expect(links.failed).toEqual(["open/index.md"]);
      expect(await read(ctx, ctx.outsider, "open/index.md")).toBe("[[acme]]\n");
      expect(await read(ctx, ctx.editor, "clients/other.md")).toBe("[[renamed]]\n");
    });

    it("won't carry a new name to the people on the old folder", async () => {
      const ctx = await setup();
      const { editor, viewer, outsider } = ctx;
      const mine = { userId: editor.userId, level: "write" };
      await ctx.put(editor, "clients/index.md", "[[acme]]\n");
      await setAccess(ctx, editor, {
        path: "vault",
        kind: "folder",
        grants: [mine, { userId: outsider.userId, level: "read" }],
      });
      const links = await move(ctx, editor, "clients/acme.md", "vault/renamed.md");
      expect(links.updated).not.toContain("clients/index.md");
      expect(links.failed).toEqual(["clients/index.md"]);
      expect(await read(ctx, viewer, "clients/index.md")).toBe("[[acme]]\n");
    });

    it("reports a note the mover can read but not change", async () => {
      const ctx = await setup();
      await ctx.put(ctx.editor, "shared/map.md", "[[notes]]\n");
      await setAccess(ctx, ctx.editor, {
        path: "shared",
        kind: "folder",
        grants: [
          { userId: ctx.editor.userId, level: "write" },
          { userId: ctx.outsider.userId, level: "read" },
        ],
      });
      const links = await move(ctx, ctx.outsider, "open/notes.md", "open/moved.md");
      expect(links.updated).not.toContain("shared/map.md");
      expect(links.failed).toEqual(["shared/map.md"]);
      expect(await read(ctx, ctx.editor, "shared/map.md")).toBe("[[notes]]\n");
    });
  });

  it("names a restriction's people only to those who can see it", async () => {
    const ctx = await setup();
    const restrictions = async (who: Person) =>
      (
        (await (await as(ctx, who, "/list")).json()) as {
          restrictions: { path: string; level: string; grants: unknown[] }[];
        }
      ).restrictions;
    expect(await restrictions(ctx.outsider)).toEqual([]);
    expect(await restrictions(ctx.owner)).toEqual([]);
    expect(await restrictions(ctx.viewer)).toMatchObject([
      { path: "clients", level: "read", grants: [{}, {}] },
    ]);
  });
});

describe.skipIf(!serverUp)("changing who has access", () => {
  it("is only for editors, and never by API key", async () => {
    const ctx = await setup();
    const body = {
      path: "clients",
      kind: "folder",
      grants: [{ userId: ctx.outsider.userId, level: "write" }],
    };
    expect((await setAccess(ctx, ctx.outsider, body)).status).toBe(404);
    expect((await setAccess(ctx, ctx.owner, body)).status).toBe(404);
    const viewer = await setAccess(ctx, ctx.viewer, body);
    expect(viewer.status).toBe(409);
    const key = await auth.api.createApiKey({
      body: {
        userId: ctx.editor.userId,
        name: "editor-key",
        metadata: { workspaceId: ctx.ws.id, actorType: "agent" },
      },
    });
    const byKey = await fetch(`${BASE}/api/workspaces/${ctx.ws.id}/node-access`, {
      method: "PUT",
      headers: { "x-api-key": key.key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(byKey.status).toBe(403);
  });

  it("won't let you lock yourself out", async () => {
    const ctx = await setup();
    const res = await setAccess(ctx, ctx.editor, {
      path: "clients",
      kind: "folder",
      grants: [{ userId: ctx.viewer.userId, level: "write" }],
    });
    expect(res.status).toBe(409);
    expect((await as(ctx, ctx.editor, "/files/clients/acme.md")).status).toBe(200);
  });

  it("goes by your own grant, not one for everyone", async () => {
    const ctx = await setup();
    for (const level of ["none", "read"]) {
      const res = await setAccess(ctx, ctx.editor, {
        path: "clients",
        kind: "folder",
        everyone: "write",
        grants: [{ userId: ctx.editor.userId, level }],
      });
      expect(res.status).toBe(409);
    }
    expect((await as(ctx, ctx.editor, "/files/clients/acme.md")).status).toBe(200);
  });

  it("refuses grants that don't make sense", async () => {
    const ctx = await setup();
    const me = { userId: ctx.editor.userId, level: "write" };
    const stranger = await signUp("stranger");
    for (const grants of [
      [me, { userId: stranger.userId, level: "read" }],
      [me, { userId: ctx.viewer.userId, level: "admin" }],
      [me, me],
      [me, { level: "read" }],
    ]) {
      const res = await setAccess(ctx, ctx.editor, { path: "clients", kind: "folder", grants });
      expect(res.status).toBe(400);
    }
    const everyone = await setAccess(ctx, ctx.editor, {
      path: "clients",
      kind: "folder",
      everyone: "admin",
      grants: [me],
    });
    expect(everyone.status).toBe(400);
  });

  it("keeps an exclusion: No access means no access, even when everyone can read", async () => {
    const ctx = await setup();
    const res = await setAccess(ctx, ctx.editor, {
      path: "clients",
      kind: "folder",
      everyone: "read",
      grants: [
        { userId: ctx.editor.userId, level: "write" },
        { userId: ctx.outsider.userId, level: "none" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await as(ctx, ctx.viewer, "/files/clients/acme.md")).status).toBe(200);
    expect((await as(ctx, ctx.outsider, "/files/clients/acme.md")).status).toBe(404);
  });

  it("won't lift a restriction if that hands the node to one you can't reach", async () => {
    const ctx = await setup();
    // The outsider holds a grant on a folder inside one they can't see.
    await ctx.put(ctx.editor, "clients/shared/inside.md", "# Inside\n");
    await setAccess(ctx, ctx.editor, {
      path: "clients/shared",
      kind: "folder",
      grants: [
        { userId: ctx.editor.userId, level: "write" },
        { userId: ctx.outsider.userId, level: "write" },
      ],
    });
    const res = await setAccess(ctx, ctx.outsider, { path: "clients/shared", restricted: false });
    expect(res.status).toBe(409);
    expect((await as(ctx, ctx.outsider, "/files/clients/shared/inside.md")).status).toBe(200);
  });

  it("sees through a path written another way before lifting", async () => {
    const ctx = await setup();
    const { editor, viewer } = ctx;
    await ctx.put(editor, "clients/shared/brief.md", "# Brief\n");
    await setAccess(ctx, editor, {
      path: "clients/shared",
      kind: "folder",
      grants: [
        { userId: editor.userId, level: "write" },
        { userId: viewer.userId, level: "write" },
      ],
    });
    await setAccess(ctx, editor, {
      path: "clients",
      kind: "folder",
      grants: [{ userId: editor.userId, level: "write" }],
    });
    const res = await setAccess(ctx, viewer, { path: "clients/./shared", restricted: false });
    expect(res.status).toBe(409);
    expect((await as(ctx, viewer, "/files/clients/shared/brief.md")).status).toBe(200);
  });

  it("the Private toggle won't quietly drop the people on a shared folder", async () => {
    const ctx = await setup();
    for (const makePrivate of [true, false]) {
      const res = await as(ctx, ctx.editor, "/node-private", {
        method: "PUT",
        ...json({ path: "clients", kind: "folder", private: makePrivate }),
      });
      expect(res.status).toBe(409);
    }
    expect((await as(ctx, ctx.viewer, "/files/clients/acme.md")).status).toBe(200);
  });

  it("nor the people who reach something through the folder it's in", async () => {
    const ctx = await setup();
    const res = await as(ctx, ctx.editor, "/node-private", {
      method: "PUT",
      ...json({ path: "clients/acme.md", kind: "file", private: true }),
    });
    expect(res.status).toBe(409);
    expect((await as(ctx, ctx.viewer, "/files/clients/acme.md")).status).toBe(200);
  });
});

describe.skipIf(!serverUp)("orphaned restrictions", () => {
  async function orphaned() {
    const ctx = await setup();
    await setAccess(ctx, ctx.editor, {
      path: "clients",
      kind: "folder",
      grants: [{ userId: ctx.editor.userId, level: "write" }],
    });
    await db.member.deleteMany({
      where: { organizationId: ctx.ws.organizationId, userId: ctx.editor.userId },
    });
    return ctx;
  }
  const orphans = async (ctx: Base, who: Person) => {
    const res = await as(ctx, who, "/orphans");
    return res.ok ? ((await res.json()) as { orphans: unknown[] }).orphans : res.status;
  };
  const claim = (ctx: Base, who: Person, path: string) =>
    as(ctx, who, "/orphans-claim", { method: "POST", ...json({ path }) });

  it("shows an owner the name and nothing else", async () => {
    const ctx = await orphaned();
    expect(await orphans(ctx, ctx.owner)).toEqual([{ path: "clients", kind: "folder" }]);
    expect((await as(ctx, ctx.owner, "/files/clients/acme.md")).status).toBe(404);
  });

  it("is for owners only, and not for a key", async () => {
    const ctx = await orphaned();
    expect(await orphans(ctx, ctx.outsider)).toBe(403);
    expect((await claim(ctx, ctx.outsider, "clients")).status).toBe(403);
  });

  it("is offered when everyone can read but everyone left is excluded", async () => {
    const ctx = await setup();
    const { owner, viewer, outsider, editor } = ctx;
    await setAccess(ctx, editor, {
      path: "clients",
      kind: "folder",
      everyone: "read",
      grants: [
        { userId: editor.userId, level: "write" },
        { userId: owner.userId, level: "none" },
      ],
    });
    await db.member.deleteMany({
      where: {
        organizationId: ctx.ws.organizationId,
        userId: { in: [editor.userId, viewer.userId, outsider.userId] },
      },
    });
    expect(await orphans(ctx, owner)).toEqual([{ path: "clients", kind: "folder" }]);
    expect((await claim(ctx, owner, "clients")).status).toBe(200);
    expect((await as(ctx, owner, "/files/clients/acme.md")).status).toBe(200);
  });

  it("isn't offered while a member can still reach it", async () => {
    const ctx = await setup();
    expect(await orphans(ctx, ctx.owner)).toEqual([]);
    expect((await claim(ctx, ctx.owner, "clients")).status).toBe(404);
  });

  it("claiming gives the owner the files, and says so in the activity feed", async () => {
    const ctx = await orphaned();
    const res = await claim(ctx, ctx.owner, "clients");
    expect(res.status).toBe(200);
    expect((await as(ctx, ctx.owner, "/files/clients/acme.md")).status).toBe(200);
    expect(await orphans(ctx, ctx.owner)).toEqual([]);

    const activity = async (query: string) =>
      (
        (await (await as(ctx, ctx.owner, `/changes?${query}`)).json()) as {
          changes: { op: string }[];
        }
      ).changes.map((c) => c.op);
    expect(await activity("order=desc")).toContain("access_claimed");
    // Never to a sync client, which would read an op it doesn't know as a delete.
    expect(await activity("sinceSeq=0")).not.toContain("access_claimed");
  });

  it("a grantee who has rejoined keeps it", async () => {
    const ctx = await orphaned();
    await join(ctx.ws.organizationId, ctx.editor.userId);
    expect((await claim(ctx, ctx.owner, "clients")).status).toBe(404);
    expect((await as(ctx, ctx.editor, "/files/clients/acme.md")).status).toBe(200);
  });

  it("a claim doesn't reach members who still can't see it", async () => {
    const ctx = await orphaned();
    await claim(ctx, ctx.owner, "clients");
    expect((await as(ctx, ctx.outsider, "/files/clients/acme.md")).status).toBe(404);
    const feed = (await (await as(ctx, ctx.outsider, "/changes?order=desc")).json()) as {
      changes: { op: string }[];
    };
    expect(feed.changes.map((c) => c.op)).not.toContain("access_claimed");
  });
});

describe.skipIf(!serverUp)("grants over MCP", () => {
  async function connect(key: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
      requestInit: { headers: { "x-api-key": key } },
    });
    const client = new Client({ name: "grants-test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }
  const keyOf = async (ctx: Base, who: Person) =>
    (
      await auth.api.createApiKey({
        body: {
          userId: who.userId,
          name: "agent",
          metadata: { workspaceId: ctx.ws.id, actorType: "agent" },
        },
      })
    ).key;
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
    (r.content as { text: string }[]).map((c) => c.text).join("\n");

  it("an agent gets exactly its person's level", async () => {
    const ctx = await setup();
    const read = { name: "read_file", arguments: { path: "clients/acme.md" } };
    const write = {
      name: "write_file",
      arguments: { path: "clients/acme.md", content: "x", baseVersion: 1 },
    };

    const viewer = await connect(await keyOf(ctx, ctx.viewer));
    expect((await viewer.callTool(read)).isError).toBeFalsy();
    expect(text(await viewer.callTool(write))).toMatch(/^Read-only: you have view-only access to/);

    const outsider = await connect(await keyOf(ctx, ctx.outsider));
    expect(text(await outsider.callTool(read))).toBe("Not found: clients/acme.md");

    const owner = await connect(await keyOf(ctx, ctx.owner));
    expect(text(await owner.callTool(read))).toBe("Not found: clients/acme.md");
    const listed = await owner.callTool({ name: "list_files", arguments: {} });
    expect(text(listed)).not.toContain("clients/acme.md");
  }, 20_000);

  it("an agent's links and tags stop where its person's access does", async () => {
    const ctx = await setup();
    await ctx.put(ctx.editor, "clients/brief.md", "See [[notes]]. #secret\n");
    const editor = await connect(await keyOf(ctx, ctx.editor));
    const outsider = await connect(await keyOf(ctx, ctx.outsider));
    const links = (c: Client) =>
      c.callTool({ name: "get_links", arguments: { path: "open/notes.md" } });
    const tags = (c: Client) => c.callTool({ name: "list_tags", arguments: {} });
    expect(text(await links(editor))).toContain("clients/brief.md");
    expect(text(await links(outsider))).not.toContain("clients/brief.md");
    expect(text(await tags(editor))).toContain("secret");
    expect(text(await tags(outsider))).not.toContain("secret");
  });

  it("set_private won't overwrite the people on a shared folder", async () => {
    const ctx = await setup();
    const editor = await connect(await keyOf(ctx, ctx.editor));
    const res = await editor.callTool({ name: "set_private", arguments: { path: "clients" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("shared with specific people");
  });

  it("set_private won't drop them from inside the folder either", async () => {
    const ctx = await setup();
    const editor = await connect(await keyOf(ctx, ctx.editor));
    const res = await editor.callTool({
      name: "set_private",
      arguments: { path: "clients/acme.md", kind: "file" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("shared with specific people");
    expect((await as(ctx, ctx.viewer, "/files/clients/acme.md")).status).toBe(200);
  });
});