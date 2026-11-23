import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import "./env";
import { createEngine } from "../../cli/src/engine";
import { runSync } from "../../cli/src/sync";

// AE3: two-way round-trip through the real CLI sync engine against a running
// server. Server-gated like the other HTTP tests.
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { setNodeAccess } = await import("../server/utils/acl");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `cli${stamp}@example.test`, password: "correct-horse-battery", name: "CLI" },
  });
  const org = await db.organization.create({ data: { id: `org_cli_${stamp}`, name: "CLI Org" } });
  await db.member.create({
    data: {
      id: `mem_cli_${stamp}`,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: { userId: user.id, name: "cli", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  const root = mkdtempSync(join(tmpdir(), "treehouse-cli-"));
  const cfg = { apiBase: BASE, apiKey: key.key, workspaceId: ws.id };
  // A linked folder always carries the `.treehouse/config.json` liveness marker
  // (written at login); seed it so runSync's root-liveness guard sees the root.
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(join(root, ".treehouse", "config.json"), JSON.stringify(cfg));
  return { ws, key: key.key, root, cfg, userId: user.id };
}

// A folder synced by a viewer of the workspace in `setup()`, through a key of
// their own, so every push hits the real read_only refusal.
async function viewerFolder(ws: { id: string; organizationId: string }) {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `clv${stamp}@example.test`, password: "correct-horse-battery", name: "Viewer" },
  });
  await db.member.create({
    data: {
      id: `mem_clv_${stamp}`,
      organizationId: ws.organizationId,
      userId: user.id,
      role: "viewer",
      createdAt: new Date(),
    },
  });
  const key = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "viewer-cli",
      metadata: { workspaceId: ws.id, actorType: "human" },
    },
  });
  const root = mkdtempSync(join(tmpdir(), "treehouse-viewer-"));
  const cfg = { apiBase: BASE, apiKey: key.key, workspaceId: ws.id };
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(join(root, ".treehouse", "config.json"), JSON.stringify(cfg));
  return { root, cfg };
}

describe.skipIf(!serverUp)("cli sync with view-only access (real engine, real server)", () => {
  const fileOf = (ws: { id: string }, key: string, path: string) =>
    fetch(`${BASE}/api/workspaces/${ws.id}/files/${path}`, { headers: { "x-api-key": key } });
  const paths = async (ws: { id: string }, key: string) => {
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/list`, {
      headers: { "x-api-key": key },
    });
    return ((await res.json()) as { entries: { path: string }[] }).entries.map((e) => e.path);
  };

  async function seeded() {
    const owner = await setup();
    await fetch(`${BASE}/api/workspaces/${owner.ws.id}/files/doc.md`, {
      method: "PUT",
      headers: { "x-api-key": owner.key, "content-type": "text/markdown", "if-none-match": "*" },
      body: "# the server's version",
    });
    const viewer = await viewerFolder(owner.ws);
    const first = await runSync(viewer.root, viewer.cfg);
    expect(first.pulled).toContain("doc.md");
    return { owner, viewer };
  }

  it("reverts an edit, makes no version and no conflicted copy, and settles", async () => {
    const { owner, viewer } = await seeded();
    writeFileSync(join(viewer.root, "doc.md"), "# my edit");

    const s = await runSync(viewer.root, viewer.cfg);

    expect(s.readOnly).toMatchObject([{ path: "doc.md", outcome: "reverted", reason: "role" }]);
    expect(s.failed).toEqual([]);
    expect(s.conflicts).toEqual([]);
    expect(readFileSync(join(viewer.root, "doc.md"), "utf8")).toBe("# the server's version");
    expect(readFileSync(join(viewer.root, s.readOnly[0]!.savedTo as string), "utf8")).toBe(
      "# my edit",
    );

    const onServer = await fileOf(owner.ws, owner.key, "doc.md");
    expect(onServer.headers.get("etag")).toContain("1");
    expect(await onServer.text()).toBe("# the server's version");
    expect(await paths(owner.ws, owner.key)).toEqual(["doc.md"]);

    const again = await runSync(viewer.root, viewer.cfg);
    expect(again.readOnly).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it("reverts an edit big enough to stream, though the server stops reading it", async () => {
    const { owner, viewer } = await seeded();
    // Past STREAM_PUSH_BYTES, so the upload is a stream the server cuts off.
    const big = "x".repeat(8 * 1024 * 1024 + 1);
    writeFileSync(join(viewer.root, "doc.md"), big);

    const s = await runSync(viewer.root, viewer.cfg);

    expect(s.failed).toEqual([]);
    expect(s.readOnly).toMatchObject([{ path: "doc.md", outcome: "reverted" }]);
    expect(readFileSync(join(viewer.root, "doc.md"), "utf8")).toBe("# the server's version");
    expect(readFileSync(join(viewer.root, s.readOnly[0]!.savedTo as string), "utf8")).toBe(big);
    expect(await paths(owner.ws, owner.key)).toEqual(["doc.md"]);
  }, 30_000);

  it("restores a deleted file and leaves a new one alone, unuploaded", async () => {
    const { owner, viewer } = await seeded();
    rmSync(join(viewer.root, "doc.md"));
    writeFileSync(join(viewer.root, "mine.md"), "# new work");

    const s = await runSync(viewer.root, viewer.cfg);

    expect(s.failed).toEqual([]);
    expect(s.readOnly.map((n) => [n.path, n.outcome]).sort()).toEqual([
      ["doc.md", "restored"],
      ["mine.md", "kept"],
    ]);
    expect(readFileSync(join(viewer.root, "doc.md"), "utf8")).toBe("# the server's version");
    expect(readFileSync(join(viewer.root, "mine.md"), "utf8")).toBe("# new work");
    expect(await paths(owner.ws, owner.key)).toEqual(["doc.md"]);
  });
});

describe.skipIf(!serverUp)("cli sync with a folder-limited key (real engine, real server)", () => {
  it("receives only its folder, works inside it, and keeps what it can't upload", async () => {
    const owner = await setup();
    for (const [path, body] of [
      ["team/brief.md", "# in reach"],
      ["private/plan.md", "# out of reach"],
    ] as const) {
      await fetch(`${BASE}/api/workspaces/${owner.ws.id}/files/${path}`, {
        method: "PUT",
        headers: { "x-api-key": owner.key, "if-none-match": "*" },
        body,
      });
    }
    const limited = await auth.api.createApiKey({
      body: {
        userId: owner.userId,
        name: "folder-cli",
        metadata: {
          workspaceId: owner.ws.id,
          actorType: "human",
          scope: { access: "write", folder: "team" },
        },
      },
    });
    const root = mkdtempSync(join(tmpdir(), "treehouse-folder-key-"));
    const cfg = { apiBase: BASE, apiKey: limited.key, workspaceId: owner.ws.id };
    mkdirSync(join(root, ".treehouse"), { recursive: true });
    writeFileSync(join(root, ".treehouse", "config.json"), JSON.stringify(cfg));

    const first = await runSync(root, cfg);
    expect(first.pulled).toEqual(["team/brief.md"]);
    expect(existsSync(join(root, "private"))).toBe(false);

    writeFileSync(join(root, "team/brief.md"), "# edited in reach");
    writeFileSync(join(root, "elsewhere.md"), "# out of reach");
    const second = await runSync(root, cfg);

    expect(second.failed).toEqual([]);
    expect(second.pushed).toEqual(["team/brief.md"]);
    expect(second.readOnly).toEqual([
      { path: "elsewhere.md", outcome: "kept", reason: "key_folder" },
    ]);
    expect(readFileSync(join(root, "elsewhere.md"), "utf8")).toBe("# out of reach");
  });
});

describe.skipIf(!serverUp)("cli sync with a grant inside a restricted folder", () => {
  it("a change to the parent leaves the granted child and its unsynced edit alone", async () => {
    const owner = await setup();
    const put = (path: string, body: string) =>
      fetch(`${BASE}/api/workspaces/${owner.ws.id}/files/${path}`, {
        method: "PUT",
        headers: { "x-api-key": owner.key, "if-none-match": "*" },
        body,
      });
    await put("clients/other.md", "# not for bob");
    await put("clients/project/kept.md", "# for bob");

    const bob = await viewerFolder(owner.ws);
    await db.member.updateMany({
      where: { organizationId: owner.ws.organizationId, role: "viewer" },
      data: { role: "member" },
    });
    const bobId = (
      await db.member.findFirst({
        where: { organizationId: owner.ws.organizationId, role: "member" },
      })
    )?.userId as string;
    const engine = createEngine(bob.root, bob.cfg, {});
    await engine.bootstrap();
    expect(existsSync(join(bob.root, "clients/other.md"))).toBe(true);

    const restrict = (path: string, grants: { subject: string; userId: string; level: string }[]) =>
      setNodeAccess({
        workspaceId: owner.ws.id,
        path,
        kind: "folder",
        grants,
        actor: {
          principal: "human",
          actorId: owner.userId,
          access: { userId: owner.userId, role: "owner" },
        },
      });
    const ownerGrant = { subject: "user", userId: owner.userId, level: "write" };
    await restrict("clients/project", [
      ownerGrant,
      { subject: "user", userId: bobId, level: "write" },
    ]);
    await restrict("clients", [ownerGrant]);

    // Unsynced when the parent's revocation arrives: this is what deleting the
    // whole subtree would destroy.
    writeFileSync(join(bob.root, "clients/project/kept.md"), "# bob's unsynced edit");
    await engine.pollOnce();
    await engine.pollOnce();

    expect(readFileSync(join(bob.root, "clients/project/kept.md"), "utf8")).toBe(
      "# bob's unsynced edit",
    );
    expect(existsSync(join(bob.root, "clients/other.md"))).toBe(false);
  }, 30_000);
});

describe.skipIf(!serverUp)("cli sync (round-trip)", () => {
  it("pushes a new local file to the cloud", async () => {
    const { ws, key, root, cfg } = await setup();
    writeFileSync(join(root, "notes.md"), "# local note");
    const summary = await runSync(root, cfg);
    expect(summary.pushed).toContain("notes.md");

    const get = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes.md`, {
      headers: { "x-api-key": key },
    });
    expect(await get.text()).toBe("# local note");
  });

  it("pulls a cloud-created file down to the local folder", async () => {
    const { ws, key, root, cfg } = await setup();
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/from-cloud.md`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
      body: "# from the cloud",
    });
    const summary = await runSync(root, cfg);
    expect(summary.pulled).toContain("from-cloud.md");
    expect(readFileSync(join(root, "from-cloud.md"), "utf8")).toBe("# from the cloud");
  });

  it("a local edit against a changed remote keeps both copies", async () => {
    const { ws, key, root, cfg } = await setup();
    // create remotely + sync down
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/shared.md`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
      body: "v1",
    });
    await runSync(root, cfg);
    // remote advances to v2 (someone else), and we edit locally from v1
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/shared.md`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/markdown", "if-match": '"1"' },
      body: "remote-v2",
    });
    writeFileSync(join(root, "shared.md"), "my-local-edit");
    const summary = await runSync(root, cfg);
    expect(summary.conflicts.length).toBe(1);
    // local now holds the winner; nothing lost (our edit is the conflicted copy)
    expect(readFileSync(join(root, "shared.md"), "utf8")).toBe("remote-v2");
  });

  it("a comment event never produces a delete hint or re-enqueues the commented path (U3)", async () => {
    const { ws, key, root, cfg } = await setup();
    const content = "# reviewed doc\n\nThe quick brown paragraph under review.\n";
    writeFileSync(join(root, "reviewed.md"), content);

    // Real engine, real server: bootstrap pushes the file and parks the cursor
    // at head, exactly like a fielded daemon.
    const engine = createEngine(root, cfg);
    await engine.bootstrap();

    // Someone comments on the synced file (a comment_created event lands on
    // the feed with the file's CURRENT version — the poller must not see it).
    const commented = await fetch(`${BASE}/api/workspaces/${ws.id}/comments`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        path: "reviewed.md",
        body: "please reword",
        quote: "quick brown paragraph",
        kind: "range",
      }),
    });
    expect(commented.status).toBe(201);

    // The next poll scans the comment event's seq (cursor safety) but applies
    // nothing: no delete hint, no pull, the local file untouched.
    const poll = await engine.pollOnce();
    expect(poll.applied).toBe(0);
    expect(poll.full).toBe(false); // cursor reached head — no stall on the window
    expect(readFileSync(join(root, "reviewed.md"), "utf8")).toBe(content);

    // A follow-up full sync also treats the world as settled.
    const summary = await runSync(root, cfg);
    expect(summary.deleted).toEqual([]);
    expect(summary.pulled).toEqual([]);
    expect(summary.conflicts).toEqual([]);
  });
});