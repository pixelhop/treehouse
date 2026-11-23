import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vite-plus/test";
import "./env";

// End-to-end MCP test against a RUNNING api dev server: a real MCP client over
// streamable-HTTP, authenticated with a workspace-scoped agent key. Verifies the
// tools are exposed, a write lands via the shared file-service, and it is
// attributed `agent` in the change feed (the leading metric). Server-gated.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `mcp${stamp}@example.test`, password: "correct-horse-battery", name: "MCP" },
  });
  const org = await db.organization.create({ data: { id: `org_mcp_${stamp}`, name: "MCP Org" } });
  await db.member.create({
    data: {
      id: `mem_mcp_${stamp}`,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "mcp-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  // A second key on the same workspace, credentialed as the human reviewer —
  // the comment tests need a thread authored the way the web app authors one.
  const humanKey = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "mcp-human",
      metadata: { workspaceId: ws.id, actorType: "human" },
    },
  });
  return { ws, key: key.key, humanKey: humanKey.key };
}

// A user-scoped key (no workspaceId in metadata) — reaches every workspace the
// user is a member of.
async function setupUser() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `mcpu${stamp}@example.test`, password: "correct-horse-battery", name: "MCP U" },
  });
  const org = await db.organization.create({
    data: { id: `org_mcpu_${stamp}`, name: "MCP U Org" },
  });
  await db.member.create({
    data: {
      id: `mem_mcpu_${stamp}`,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: { userId: user.id, name: "mcp-user", metadata: { actorType: "agent" } },
  });
  return { key: key.key };
}

async function connect(key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    requestInit: { headers: { "x-api-key": key } },
  });
  const client = new Client({ name: "treehouse-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

// A real 1x1 PNG — small enough to inline, valid enough to pass magic-byte
// sniffing on the server.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe.skipIf(!serverUp)("mcp server", () => {
  it("follows links between notes and keeps them working across a rename", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const write = (path: string, content: string) =>
      client.callTool({ name: "write_file", arguments: { path, content } });
    await write("decisions/Use Postgres.md", "# Use Postgres");
    await write("index.md", "- [[Use Postgres|DB choice]]\n- [[Nowhere]]");

    type Links = {
      structuredContent?: {
        backlinks: string[];
        outgoing: { kind: string; target: string; path: string | null }[];
        complete: boolean;
      };
    };
    const target = (await client.callTool({
      name: "get_links",
      arguments: { path: "decisions/Use Postgres.md" },
    })) as Links;
    expect(target.structuredContent).toMatchObject({ backlinks: ["index.md"], complete: true });

    const index = (await client.callTool({
      name: "get_links",
      arguments: { path: "index.md" },
    })) as Links;
    expect(index.structuredContent?.outgoing).toEqual([
      { kind: "wikilink", target: "Use Postgres", path: "decisions/Use Postgres.md" },
      { kind: "wikilink", target: "Nowhere", path: null },
    ]);

    const moved = (await client.callTool({
      name: "move_file",
      arguments: { from: "decisions/Use Postgres.md", to: "decisions/Adopt Postgres.md" },
    })) as { content: { text: string }[] };
    expect(moved.content[0].text).toContain("Updated links in 1 file(s): index.md");
    const read = (await client.callTool({
      name: "read_file",
      arguments: { path: "index.md" },
    })) as { structuredContent?: { content: string } };
    expect(read.structuredContent?.content).toBe("- [[Adopt Postgres|DB choice]]\n- [[Nowhere]]");

    const missing = (await client.callTool({
      name: "get_links",
      arguments: { path: "decisions/Use Postgres.md" },
    })) as { isError?: boolean };
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it("lists tags and finds the notes carrying one", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const write = (path: string, content: string) =>
      client.callTool({ name: "write_file", arguments: { path, content } });
    await write("a.md", "---\ntags: [Planning]\n---\nShip #launch/beta");
    await write("b.md", "Also #planning, not `#code`");

    type Tags = { structuredContent?: { tags: { tag: string; count: number }[] } };
    const all = (await client.callTool({ name: "list_tags", arguments: {} })) as Tags;
    expect(all.structuredContent?.tags.map((t) => [t.tag, t.count])).toEqual([
      ["launch/beta", 1],
      ["Planning", 2],
    ]);
    // Listing stays small however many notes there are: paths are per tag.
    expect(all.structuredContent).toMatchObject({ paths: [], more: 0, complete: true });
    const launch = (await client.callTool({
      name: "list_tags",
      arguments: { tag: "#launch" },
    })) as { content: { text: string }[]; structuredContent?: { paths: string[] } };
    expect(launch.content[0].text).toContain("a.md");
    expect(launch.structuredContent?.paths).toEqual(["a.md"]);
    const page = (await client.callTool({
      name: "list_tags",
      arguments: { tag: "planning", limit: 1 },
    })) as { structuredContent?: { paths: string[]; more: number; nextOffset: number } };
    expect(page.structuredContent).toMatchObject({ paths: ["a.md"], more: 1, nextOffset: 1 });
    const links = (await client.callTool({
      name: "get_links",
      arguments: { path: "a.md" },
    })) as { structuredContent?: { tags: string[] } };
    expect(links.structuredContent?.tags).toEqual(["Planning", "launch/beta"]);
    await client.close();
  });

  it("exposes filesystem tools and writes attributed to the agent", async () => {
    const { ws, key } = await setup();
    const client = await connect(key);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "add_comment",
      "create_share",
      "delete_file",
      "edit_file",
      "get_links",
      "get_usage",
      "list_comments",
      "list_files",
      "list_members",
      "list_shares",
      "list_tags",
      "list_trash",
      "move_file",
      "preview_restore_to",
      "preview_undo_my_changes",
      "read_file",
      "read_file_version",
      "reply_comment",
      "resolve_comment",
      "restore_file",
      "restore_from_trash",
      "restore_to",
      "revoke_share",
      "search_files",
      "set_file_icon",
      "set_private",
      "set_workspace",
      "set_workspace_image_icon",
      "undo_my_changes",
      "write_file",
    ]);

    const write = (await client.callTool({
      name: "write_file",
      arguments: { path: "from-agent.md", content: "# Written by the agent" },
    })) as { content: { text: string }[] };
    expect(write.content[0].text).toContain("version 1");

    const read = (await client.callTool({
      name: "read_file",
      arguments: { path: "from-agent.md" },
    })) as { content: { text: string }[] };
    expect(read.content[0].text).toContain("Written by the agent");

    // list_members names the people an agent can assign a board card to: display
    // names and roles, never emails.
    const listed = (await client.callTool({ name: "list_members", arguments: {} })) as {
      structuredContent?: { members: { name: string; role: string }[] };
      content: { text: string }[];
    };
    expect(listed.structuredContent?.members).toEqual([{ name: "MCP", role: "owner" }]);
    expect(listed.content[0].text).not.toContain("@example.test");

    // The write is attributed to the agent in the change feed (the metric).
    const events = await db.changeEvent.findMany({ where: { workspaceId: ws.id } });
    expect(
      events.some((e) => e.op === "write" && e.principal === "agent" && e.path === "from-agent.md"),
    ).toBe(true);

    // The agent can brand its own workspace (name/icon/colour/theme).
    const setWs = (await client.callTool({
      name: "set_workspace",
      arguments: {
        name: "Agent Renamed",
        icon: "solar:rocket-bold",
        color: "violet",
        theme: "dracula",
      },
    })) as { content: { text: string }[] };
    expect(setWs.content[0].text).toContain("Updated workspace");
    const updated = await db.workspace.findUnique({ where: { id: ws.id } });
    expect(updated?.name).toBe("Agent Renamed");
    expect(updated?.icon).toBe("solar:rocket-bold");
    expect(updated?.color).toBe("violet");
    expect(updated?.theme).toBe("dracula");

    // The agent can set a file's icon.
    await client.callTool({
      name: "set_file_icon",
      arguments: { path: "from-agent.md", icon: "📌" },
    });
    const meta = await db.nodeMeta.findUnique({
      where: { workspaceId_path: { workspaceId: ws.id, path: "from-agent.md" } },
    });
    expect(meta?.icon).toBe("📌");

    await client.close();
  });

  // Agent parity with the web app's icon uploader: a human can drop a logo on a
  // workspace, so an agent can too — same bytes, same public URL.
  it("uploads a logo as the workspace icon and serves it back", async () => {
    const { ws, key } = await setup();
    const client = await connect(key);

    const res = (await client.callTool({
      name: "set_workspace_image_icon",
      arguments: { content: PNG_1x1_BASE64 },
    })) as { structuredContent?: { icon: string } };
    const icon = res.structuredContent?.icon ?? "";
    expect(icon.startsWith("upload:")).toBe(true);

    const stored = await db.workspace.findUnique({ where: { id: ws.id } });
    expect(stored?.icon).toBe(icon);

    // The bytes are readable from the public capability URL, unauthenticated —
    // this is what makes the icon render in an <img> and on the invite preview.
    const bytes = await fetch(
      `${BASE}/api/workspaces/${ws.id}/icon/${icon.slice("upload:".length)}`,
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");

    // A hash the workspace no longer wears is a 404, not someone else's icon.
    const stale = await fetch(`${BASE}/api/workspaces/${ws.id}/icon/${"b".repeat(64)}`);
    expect(stale.status).toBe(404);

    // Non-images are refused whatever they claim to be.
    const bad = (await client.callTool({
      name: "set_workspace_image_icon",
      arguments: { content: Buffer.from("<svg onload=alert(1)>").toString("base64") },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);

    await client.close();
  });

  it("get_usage reports the workspace's live byte total (U5)", async () => {
    const { key } = await setup();
    const client = await connect(key);

    const before = (await client.callTool({ name: "get_usage", arguments: {} })) as {
      structuredContent?: { usedBytes: number; limitBytes: number | null; warning: boolean };
    };
    expect(before.structuredContent).toMatchObject({
      usedBytes: 0,
      limitBytes: null,
      warning: false,
    });

    await client.callTool({ name: "write_file", arguments: { path: "u.md", content: "12345" } });
    const after = (await client.callTool({ name: "get_usage", arguments: {} })) as {
      structuredContent?: { usedBytes: number };
    };
    expect(after.structuredContent?.usedBytes).toBe(5);

    await client.close();
  });

  it("list_trash + restore_from_trash bring a deleted file back", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };

    await call("write_file", { path: "trash/gone.md", content: "keep me" });
    await call("delete_file", { path: "trash/gone.md", baseVersion: 1 });

    const listed = await call("list_trash", { prefix: "trash" });
    expect(listed.structuredContent?.items).toEqual([
      expect.objectContaining({
        path: "trash/gone.md",
        restorable: true,
        deletedBy: "agent (mcp-agent)",
      }),
    ]);

    const dry = await call("restore_from_trash", {
      paths: ["trash/gone.md", "nope.md"],
      dryRun: true,
    });
    expect(dry.structuredContent).toEqual({
      restored: ["trash/gone.md"],
      skipped: [{ path: "nope.md", reason: "not_in_trash" }],
      dryRun: true,
    });
    expect((await call("read_file", { path: "trash/gone.md" })).isError).toBe(true);

    const done = await call("restore_from_trash", { paths: ["trash/gone.md"] });
    expect(done.structuredContent?.restored).toEqual(["trash/gone.md"]);
    expect((await call("read_file", { path: "trash/gone.md" })).content[0].text).toBe("keep me");
    expect((await call("list_trash", { prefix: "trash" })).structuredContent?.items).toEqual([]);
    await client.close();
  });

  it("preview_restore_to then restore_to put a folder back", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };

    await call("write_file", { path: "pit/a.md", content: "before" });
    await new Promise((r) => setTimeout(r, 30));
    const at = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30));
    await call("write_file", { path: "pit/a.md", content: "after", baseVersion: 1 });
    await call("write_file", { path: "pit/junk.md", content: "junk" });

    const bad = await call("preview_restore_to", { path: "pit", at: "yesterday-ish" });
    expect(bad.isError).toBe(true);

    const preview = await call("preview_restore_to", { path: "pit", at });
    expect(preview.structuredContent?.changes).toEqual(
      expect.arrayContaining([
        { kind: "restore", path: "pit/a.md" },
        { kind: "delete", path: "pit/junk.md" },
      ]),
    );
    expect((await call("read_file", { path: "pit/a.md" })).content[0].text).toBe("after");

    const done = await call("restore_to", {
      path: "pit",
      at,
      previewToken: preview.structuredContent?.previewToken,
    });
    expect(done.structuredContent?.changes).toHaveLength(2);
    expect((await call("read_file", { path: "pit/a.md" })).content[0].text).toBe("before");
    expect((await call("read_file", { path: "pit/junk.md" })).isError).toBe(true);
    await client.close();
  });

  it("an agent can preview and undo its own changes", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };
    await new Promise((r) => setTimeout(r, 30));
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 30));
    await call("write_file", { path: "undo/mistake.md", content: "oops" });

    const preview = await call("preview_undo_my_changes", { since });
    expect(preview.structuredContent?.changes).toEqual([
      { kind: "delete", path: "undo/mistake.md" },
    ]);
    const done = await call("undo_my_changes", {
      since,
      previewToken: preview.structuredContent?.previewToken,
    });
    expect(done.structuredContent?.changes).toHaveLength(1);
    expect((await call("read_file", { path: "undo/mistake.md" })).isError).toBe(true);
    await client.close();
  });

  it("restore_file + read_file_version round-trip via MCP (U5)", async () => {
    const { key } = await setup();
    const client = await connect(key);

    await client.callTool({ name: "write_file", arguments: { path: "doc.md", content: "v1" } });
    await client.callTool({
      name: "write_file",
      arguments: { path: "doc.md", content: "v2", baseVersion: 1 },
    });

    const old = (await client.callTool({
      name: "read_file_version",
      arguments: { path: "doc.md", version: 1 },
    })) as { content: { text: string }[] };
    expect(old.content[0].text).toContain("v1");

    const restore = (await client.callTool({
      name: "restore_file",
      arguments: { path: "doc.md", targetVersion: 1 },
    })) as { structuredContent?: { status: string; version: number; restoredFrom: number } };
    expect(restore.structuredContent).toMatchObject({ status: "ok", version: 3, restoredFrom: 1 });

    const cur = (await client.callTool({
      name: "read_file",
      arguments: { path: "doc.md" },
    })) as { content: { text: string }[] };
    expect(cur.content[0].text).toContain("v1");

    await client.close();
  });

  it("create_share mints a member link; public is refused; list/revoke round-trip (U5)", async () => {
    const { key } = await setup();
    const client = await connect(key);

    await client.callTool({
      name: "write_file",
      arguments: { path: "share-me.md", content: "hi" },
    });

    const created = (await client.callTool({
      name: "create_share",
      arguments: { path: "share-me.md", kind: "file" },
    })) as { structuredContent?: { id: string; access: string; memberUrl: string } };
    expect(created.structuredContent?.access).toBe("member");
    expect(created.structuredContent?.memberUrl).toContain("/w/");
    const shareId = created.structuredContent?.id as string;

    const list = (await client.callTool({
      name: "list_shares",
      arguments: { path: "share-me.md" },
    })) as { structuredContent?: { shares: { id: string }[] } };
    expect(list.structuredContent?.shares.some((s) => s.id === shareId)).toBe(true);

    // Public minting is refused over MCP (KTD4).
    const pub = (await client.callTool({
      name: "create_share",
      arguments: { path: "share-me.md", kind: "file", access: "public" },
    })) as { isError?: boolean };
    expect(pub.isError).toBe(true);

    const revoked = (await client.callTool({
      name: "revoke_share",
      arguments: { shareId },
    })) as { isError?: boolean };
    expect(revoked.isError).toBeFalsy();

    await client.close();
  });

  it("user-scoped key: lists, creates, and uses workspaces", async () => {
    const { key } = await setupUser();
    const client = await connect(key);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_comment",
      "create_share",
      "create_workspace",
      "delete_file",
      "edit_file",
      "get_links",
      "get_usage",
      "list_comments",
      "list_files",
      "list_members",
      "list_shares",
      "list_tags",
      "list_trash",
      "list_workspaces",
      "move_file",
      "preview_restore_to",
      "preview_undo_my_changes",
      "read_file",
      "read_file_version",
      "reply_comment",
      "resolve_comment",
      "restore_file",
      "restore_from_trash",
      "restore_to",
      "revoke_share",
      "search_files",
      "set_file_icon",
      "set_private",
      "set_workspace",
      "set_workspace_image_icon",
      "undo_my_changes",
      "write_file",
    ]);

    const created = (await client.callTool({
      name: "create_workspace",
      arguments: { name: "Agent WS", icon: "🤖", color: "violet" },
    })) as { structuredContent?: { id: string } };
    const newId = created.structuredContent?.id as string;
    expect(newId).toBeTruthy();

    // The agent's new workspace gets its OWN hidden organization — it is not
    // dropped into whichever org the user happened to join first.
    const newRow = await db.workspace.findUniqueOrThrow({ where: { id: newId } });
    const siblings = await db.workspace.count({
      where: { organizationId: newRow.organizationId },
    });
    expect(siblings).toBe(1);

    await client.callTool({
      name: "write_file",
      arguments: { workspaceId: newId, path: "hi.md", content: "# hi from agent" },
    });
    const read = (await client.callTool({
      name: "read_file",
      arguments: { workspaceId: newId, path: "hi.md" },
    })) as { content: { text: string }[] };
    expect(read.content[0].text).toContain("hi from agent");

    await client.close();
  });

  it("search_files finds a file by fuzzy name and frames results as untrusted data", async () => {
    const { key } = await setup();
    const client = await connect(key);
    for (const path of ["Clients/acme/notes.md", "unrelated.txt"]) {
      await client.callTool({ name: "write_file", arguments: { path, content: "x" } });
    }

    const res = (await client.callTool({
      name: "search_files",
      arguments: { query: "clinot" },
    })) as unknown as {
      content: { text: string }[];
      structuredContent: { results: { path: string }[] };
    };

    const paths = res.structuredContent.results.map((r) => r.path);
    expect(paths).toContain("Clients/acme/notes.md");
    expect(paths).not.toContain("unrelated.txt");
    // Filenames are attacker-influenceable and flow straight into a model's
    // context, so the block must announce itself as data.
    expect(res.content[0].text).toMatch(/DATA supplied by users and agents/);
    await client.close();
  });

  it("search_files returns a valid structured payload when nothing matches", async () => {
    // The tool declares an outputSchema, so an empty result with no
    // structuredContent trips the SDK's output validation and surfaces to the
    // agent as a tool error rather than "no matches".
    const { key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "a.md", content: "x" } });
    const res = (await client.callTool({
      name: "search_files",
      arguments: { query: "zzzzzzqqq" },
    })) as unknown as {
      isError?: boolean;
      structuredContent: { results: unknown[]; totalMatches: number };
    };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.results).toEqual([]);
    expect(res.structuredContent.totalMatches).toBe(0);
    await client.close();
  });

  it("search_files returns folders, not just files", async () => {
    const { key } = await setup();
    const client = await connect(key);
    await client.callTool({
      name: "write_file",
      arguments: { path: "Clients/acme/notes.md", content: "x" },
    });
    const res = (await client.callTool({
      name: "search_files",
      arguments: { query: "acme" },
    })) as unknown as { structuredContent: { results: { path: string; isDir: boolean }[] } };
    expect(res.structuredContent.results.some((r) => r.path === "Clients/acme" && r.isDir)).toBe(
      true,
    );
    await client.close();
  });

  it("search_files clamps an absurd limit", async () => {
    const { key } = await setup();
    const client = await connect(key);
    for (let i = 0; i < 4; i++) {
      await client.callTool({ name: "write_file", arguments: { path: `n-${i}.md`, content: "x" } });
    }
    const res = (await client.callTool({
      name: "search_files",
      arguments: { query: "n", limit: 10_000_000 },
    })) as unknown as { structuredContent: { results: unknown[] } };
    // MAX_SEARCH_LIMIT is 200; the point is that a huge limit neither throws nor
    // returns an unbounded dump.
    expect(res.structuredContent.results.length).toBeLessThanOrEqual(200);
    await client.close();
  });

  it("workspace-scoped search_files ignores a foreign workspaceId in the payload", async () => {
    // Phrased as a positive property on purpose: Zod object schemas silently
    // STRIP unknown keys, so asserting a rejection would fail and tempt whoever
    // hits it into adding workspaceId to the schema — the exact thing the
    // closure-scoped server forbids.
    const a = await setup();
    const b = await setup();
    const client = await connect(a.key);
    await client.callTool({
      name: "write_file",
      arguments: { path: "mine-only.md", content: "x" },
    });

    const res = (await client.callTool({
      name: "search_files",
      arguments: { query: "mine", workspaceId: b.ws.id },
    })) as unknown as { structuredContent: { results: { path: string }[] } };
    // Answered from the closure's workspace, not the one named in the payload.
    expect(res.structuredContent.results.map((r) => r.path)).toContain("mine-only.md");
    await client.close();
  });

  it("rejects an unscoped/invalid key", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
      requestInit: { headers: { "x-api-key": "th_not_real" } },
    });
    const client = new Client({ name: "t", version: "0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("list_files pages with limit/offset (U4)", async () => {
    const { key } = await setup();
    const client = await connect(key);
    for (const n of ["a", "b", "c"]) {
      await client.callTool({ name: "write_file", arguments: { path: `${n}.md`, content: "hi" } });
    }

    const first = (await client.callTool({
      name: "list_files",
      arguments: { limit: 2 },
    })) as { content: { text: string }[] };
    const firstLines = first.content[0].text.split("\n");
    // Two entries plus a "… (N more; …)" continuation hint.
    expect(firstLines.filter((l) => l.includes(".md")).length).toBe(2);
    expect(first.content[0].text).toContain("more");

    const second = (await client.callTool({
      name: "list_files",
      arguments: { limit: 2, offset: 2 },
    })) as { content: { text: string }[] };
    expect(second.content[0].text).toContain("c.md");

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Comment tools (U4). The review loop as an agent experiences it: a human
// comments in the app (REST), the agent lists → replies → resolves over MCP,
// text-first throughout. Same running server, same workspace-scoped key.
// ---------------------------------------------------------------------------

const V1 = "# Doc\n\nAlpha beta gamma delta paragraph one.\n\nAnother line entirely here.\n";
const QUOTE = "beta gamma delta";
// A rewrite sharing no phrasing with V1, so the anchor cascade lands outdated.
const V2 = "# Doc\n\nCompletely rewritten with nothing in common anymore.\n";

const createCommentRest = (wsId: string, key: string, payload: object) =>
  fetch(`${BASE}/api/workspaces/${wsId}/comments`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

interface ThreadPayload {
  id: string;
  path: string;
  status: string;
  anchorKind: string;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  pinnedVersion: number;
  anchorStatus: string;
  currentText: string | null;
  entries: { body: string; author: { principal: string; actorLabel: string | null } }[];
  entryCount: number;
  hasMoreEntries: boolean;
}
type ListResult = {
  content: { text: string }[];
  structuredContent?: {
    threads: ThreadPayload[];
    total: number;
    more?: number;
    nextOffset?: number | null;
    truncated?: boolean;
  };
};

// Numeric character positions must never reach the agent surface (KD8/R16) —
// version numbers may, character offsets may not.
const POSITION_KEYS =
  /"(sourceStart|sourceEnd|resolvedStart|resolvedEnd|start|end|offset|position)"\s*:/;

const listComments = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: "list_comments", arguments: args }) as Promise<ListResult>;

describe.skipIf(!serverUp)("mcp comment tools (U4)", () => {
  it("human comments in the app; the agent lists, replies, and resolves it (AE3)", async () => {
    const { ws, key, humanKey } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "doc.md", content: V1 } });

    const res = await createCommentRest(ws.id, humanKey, {
      path: "doc.md",
      body: "tighten this",
      quote: QUOTE,
      kind: "range",
    });
    expect(res.status).toBe(201);

    const listed = await listComments(client, { path: "doc.md" });
    expect(listed.structuredContent?.total).toBe(1);
    const thread = listed.structuredContent!.threads[0]!;
    expect(thread.quote).toBe(QUOTE); // the original quoted text
    expect(thread.currentText).toBe(QUOTE); // as it reads in the current version
    expect(thread.contextBefore).toContain("Alpha"); // surrounding context
    expect(thread.pinnedVersion).toBe(1); // the version it was written against
    expect(thread.status).toBe("open");
    expect(thread.anchorStatus).toBe("anchored");
    expect(thread.entries[0]!.body).toBe("tighten this");
    expect(thread.entries[0]!.author.principal).toBe("human");
    // Text-first: the quote is in the prose body, offsets are nowhere.
    expect(listed.content[0]!.text).toContain(QUOTE);
    expect(JSON.stringify(listed.structuredContent)).not.toMatch(POSITION_KEYS);
    expect(listed.content[0]!.text).not.toMatch(POSITION_KEYS);
    // One thread reads as one compact block: the quoted document text (which is
    // multi-line here) is JSON-quoted, so it cannot smear the listing across
    // lines — header, quote, before, after, one reply.
    expect(listed.content[0]!.text.split("\n")).toHaveLength(5);

    const replied = (await client.callTool({
      name: "reply_comment",
      arguments: { threadId: thread.id, body: "tightened it", dedupeKey: "reply-1" },
    })) as { isError?: boolean; structuredContent?: { ok: boolean; deduped: boolean } };
    expect(replied.isError).toBeFalsy();
    expect(replied.structuredContent).toMatchObject({ ok: true, deduped: false });

    // A retried reply with the same key records one reply, not two.
    const retried = (await client.callTool({
      name: "reply_comment",
      arguments: { threadId: thread.id, body: "tightened it", dedupeKey: "reply-1" },
    })) as { structuredContent?: { deduped: boolean } };
    expect(retried.structuredContent?.deduped).toBe(true);

    const resolved = (await client.callTool({
      name: "resolve_comment",
      arguments: { threadId: thread.id, resolved: true },
    })) as { isError?: boolean; structuredContent?: { resolved: boolean; changed: boolean } };
    expect(resolved.structuredContent).toMatchObject({ resolved: true, changed: true });
    // Idempotent: resolving twice is success with changed=false.
    const again = (await client.callTool({
      name: "resolve_comment",
      arguments: { threadId: thread.id, resolved: true },
    })) as { structuredContent?: { changed: boolean } };
    expect(again.structuredContent?.changed).toBe(false);

    // Attribution is by credential: the agent's key, not the route.
    const events = await db.changeEvent.findMany({ where: { workspaceId: ws.id } });
    const replyEvent = events.find((e) => e.op === "comment_replied");
    expect(replyEvent?.principal).toBe("agent");
    expect(replyEvent?.actorLabel).toBe("mcp-agent");
    expect(events.filter((e) => e.op === "comment_replied")).toHaveLength(1); // dedupe held
    expect(events.find((e) => e.op === "comment_resolved")?.principal).toBe("agent");
    expect(events.find((e) => e.op === "comment_created")?.principal).toBe("human");

    // The thread now reads back as resolved with the agent's reply on it.
    const after = await listComments(client, { path: "doc.md", status: "resolved" });
    expect(after.structuredContent?.threads).toHaveLength(1);
    expect(after.structuredContent!.threads[0]!.entryCount).toBe(2);
    // …and it no longer shows up in the open queue.
    const open = await listComments(client, { path: "doc.md", status: "open" });
    expect(open.structuredContent?.threads ?? []).toHaveLength(0);

    await client.close();
  });

  it("point comments carry their surrounding context, not a position (AE5)", async () => {
    const { key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "p.md", content: V1 } });

    const added = (await client.callTool({
      name: "add_comment",
      arguments: {
        path: "p.md",
        body: "insert an example here",
        kind: "point",
        contextBefore: "Alpha beta gamma delta paragraph one.",
        contextAfter: "\n\nAnother line entirely here.",
      },
    })) as { isError?: boolean; structuredContent?: { ok: boolean; thread: ThreadPayload } };
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent?.ok).toBe(true);

    const listed = await listComments(client, { path: "p.md" });
    const thread = listed.structuredContent!.threads[0]!;
    expect(thread.anchorKind).toBe("point");
    expect(thread.quote).toBe("");
    expect(thread.contextBefore).toContain("paragraph one.");
    expect(thread.contextAfter).toContain("Another line");
    expect(listed.content[0]!.text).toContain("Another line");
    expect(JSON.stringify(listed.structuredContent)).not.toMatch(POSITION_KEYS);

    await client.close();
  });

  it("an outdated thread is recovered by reading its pinnedVersion", async () => {
    const { ws, key, humanKey } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "d.md", content: V1 } });
    expect(
      (
        await createCommentRest(ws.id, humanKey, {
          path: "d.md",
          body: "why this phrasing?",
          quote: QUOTE,
          kind: "range",
        })
      ).status,
    ).toBe(201);
    await client.callTool({
      name: "write_file",
      arguments: { path: "d.md", content: V2, baseVersion: 1 },
    });

    const listed = await listComments(client, { path: "d.md" });
    const thread = listed.structuredContent!.threads[0]!;
    expect(thread.anchorStatus).toBe("outdated");
    expect(thread.quote).toBe(QUOTE); // the original quote survives the rewrite
    expect(thread.currentText).toBeNull();
    expect(thread.pinnedVersion).toBe(1);

    // The recovery move is the existing version-read tool — no special read.
    const pinned = (await client.callTool({
      name: "read_file_version",
      arguments: { path: "d.md", version: thread.pinnedVersion },
    })) as { content: { text: string }[] };
    expect(pinned.content[0]!.text).toBe(V1);

    // Filtering by anchorStatus finds exactly the threads needing recovery.
    const outdated = await listComments(client, { path: "d.md", anchorStatus: "outdated" });
    expect(outdated.structuredContent?.threads).toHaveLength(1);

    await client.close();
  });

  it("an anchor that cannot be placed returns ok=false data, not a tool error", async () => {
    const { key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "f.md", content: V1 } });

    // Quote that does not exist in the file.
    const missing = (await client.callTool({
      name: "add_comment",
      arguments: { path: "f.md", body: "hm", quote: "text that is simply not present" },
    })) as { isError?: boolean; structuredContent?: { ok: boolean; error: string } };
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({ ok: false, error: "anchor_not_found" });

    // A quote appearing twice, with no disambiguator.
    await client.callTool({
      name: "write_file",
      arguments: {
        path: "f.md",
        content: "# Doc\n\nrepeated phrase here\n\nand again repeated phrase here\n",
        baseVersion: 1,
      },
    });
    const ambiguous = (await client.callTool({
      name: "add_comment",
      arguments: { path: "f.md", body: "which one?", quote: "repeated phrase here" },
    })) as { isError?: boolean; structuredContent?: { ok: boolean; occurrences: number } };
    expect(ambiguous.isError).toBeFalsy();
    expect(ambiguous.structuredContent?.ok).toBe(false);
    expect(ambiguous.structuredContent?.occurrences).toBe(2);

    // …and the occurrence disambiguator resolves it.
    const picked = (await client.callTool({
      name: "add_comment",
      arguments: {
        path: "f.md",
        body: "this one",
        quote: "repeated phrase here",
        occurrence: 2,
      },
    })) as { structuredContent?: { ok: boolean } };
    expect(picked.structuredContent?.ok).toBe(true);

    // A stale baseVersion whose quote is gone from the current text: a
    // structured conflict, still not a tool error, and nothing is created.
    await client.callTool({
      name: "write_file",
      arguments: { path: "g.md", content: V1 },
    });
    await client.callTool({
      name: "write_file",
      arguments: { path: "g.md", content: V2, baseVersion: 1 },
    });
    const stale = (await client.callTool({
      name: "add_comment",
      arguments: { path: "g.md", body: "late", quote: QUOTE, baseVersion: 1 },
    })) as {
      isError?: boolean;
      structuredContent?: { ok: boolean; error: string; currentVersion: number };
    };
    expect(stale.isError).toBeFalsy();
    expect(stale.structuredContent).toMatchObject({ ok: false, error: "base_version_conflict" });
    expect(stale.structuredContent?.currentVersion).toBe(2);
    const none = await listComments(client, { path: "g.md" });
    expect(none.structuredContent?.threads ?? []).toHaveLength(0);

    await client.close();
  });

  it("caps replies per thread and marks how many more there are", async () => {
    const { key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "c.md", content: V1 } });
    const added = (await client.callTool({
      name: "add_comment",
      arguments: { path: "c.md", body: "first", quote: QUOTE },
    })) as { structuredContent?: { thread: ThreadPayload } };
    const threadId = added.structuredContent!.thread.id;
    for (let i = 0; i < 4; i++) {
      await client.callTool({
        name: "reply_comment",
        arguments: { threadId, body: `reply ${i}`, dedupeKey: `k${i}` },
      });
    }

    const capped = await listComments(client, { threadId, entriesLimit: 2 });
    const thread = capped.structuredContent!.threads[0]!;
    expect(thread.entries).toHaveLength(2);
    expect(thread.entryCount).toBe(5);
    expect(thread.hasMoreEntries).toBe(true);
    expect(capped.content[0]!.text).toContain("more");

    const whole = await listComments(client, { threadId });
    expect(whole.structuredContent!.threads[0]!.entries).toHaveLength(5);

    await client.close();
  });

  it("pages threads by the service's own cursor (nextOffset null on the last page)", async () => {
    const { key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "p.md", content: V1 } });
    for (const quote of [QUOTE, "Another line"]) {
      await client.callTool({
        name: "add_comment",
        arguments: { path: "p.md", body: `on ${quote}`, quote },
      });
    }

    const first = await listComments(client, { path: "p.md", limit: 1 });
    expect(first.structuredContent).toMatchObject({ total: 2, more: 1, nextOffset: 1 });
    expect(first.structuredContent?.truncated).toBe(false);
    expect(first.content[0]!.text).toContain("offset=1");

    // Last page: the cursor is null, not a number that would re-request nothing.
    const last = await listComments(client, { path: "p.md", limit: 1, offset: 1 });
    expect(last.structuredContent).toMatchObject({ total: 2, more: 0, nextOffset: null });

    await client.close();
  });

  it("a truncated anchorStatus scan is never presented as complete", async () => {
    const { ws, key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "s.md", content: V1 } });
    const node = (await db.fileNode.findUnique({
      where: { workspaceId_path: { workspaceId: ws.id, path: "s.md" } },
      select: { contentHash: true, version: true },
    }))!;

    // The service resolves at most 500 threads before answering an anchorStatus
    // query, so the scan has to be overflowed to see the truncation. 505 tool
    // calls would make this a minute-long test; these rows are shaped exactly as
    // createThread writes them, with the resolution cache warm against the
    // file's current hash, so listThreads takes its ordinary cache-hit path.
    const base = Date.now();
    const row = (i: number, status: "anchored" | "outdated") => ({
      workspaceId: ws.id,
      path: "s.md",
      anchorKind: "range",
      quote: QUOTE,
      contextBefore: "",
      contextAfter: "",
      sourceStart: 0,
      sourceEnd: QUOTE.length,
      pinnedContentHash: node.contentHash,
      pinnedVersion: node.version,
      lastResolvedHash: node.contentHash,
      resolvedStart: status === "anchored" ? 0 : null,
      resolvedEnd: status === "anchored" ? QUOTE.length : null,
      anchorStatus: status,
      principal: "human",
      createdAt: new Date(base + i),
    });
    await db.commentThread.createMany({
      data: [
        ...Array.from({ length: 500 }, (_, i) => row(i, "anchored")),
        // Sorted last, so they fall outside the scan's ceiling entirely.
        ...Array.from({ length: 5 }, (_, i) => row(500 + i, "outdated")),
      ],
    });

    const scan = await listComments(client, { path: "s.md", anchorStatus: "outdated" });
    expect(scan.structuredContent?.truncated).toBe(true);
    // Zero matches inside a truncated scan is the dangerous case: five outdated
    // threads exist, and the answer must not read as "there are none".
    expect(scan.structuredContent?.threads).toHaveLength(0);
    expect(scan.content[0]!.text).toMatch(/incomplete/i);
    expect(scan.content[0]!.text).not.toBe("(no comments)");

    await client.close();
  });

  it("reply 101 is reachable by following the guidance the tool prints", async () => {
    const { ws, key } = await setup();
    const client = await connect(key);
    await client.callTool({ name: "write_file", arguments: { path: "long.md", content: V1 } });
    const added = (await client.callTool({
      name: "add_comment",
      arguments: { path: "long.md", body: "first", quote: QUOTE },
    })) as { structuredContent?: { thread: ThreadPayload } };
    const threadId = added.structuredContent!.thread.id;

    // 100 more replies (bulk-inserted for speed), so the thread runs one past
    // the service's 100-reply-per-page ceiling.
    const base = Date.now() + 1000;
    await db.commentEntry.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        workspaceId: ws.id,
        threadId,
        body: `bulk ${i + 1}`,
        principal: "human",
        createdAt: new Date(base + i),
      })),
    });

    const capped = await listComments(client, { threadId, entriesLimit: 100 });
    const thread = capped.structuredContent!.threads[0]!;
    expect(thread.entries).toHaveLength(100);
    expect(thread.entryCount).toBe(101);
    expect(thread.hasMoreEntries).toBe(true);
    // Raising entriesLimit is capped at 100, so advising it strands reply 101.
    expect(capped.content[0]!.text).not.toMatch(/raise entriesLimit/i);
    expect(capped.content[0]!.text).toContain("entriesOffset=100");

    const rest = await listComments(client, { threadId, entriesLimit: 100, entriesOffset: 100 });
    const tail = rest.structuredContent!.threads[0]!;
    expect(tail.entries.map((e) => e.body)).toEqual(["bulk 100"]);
    expect(tail.hasMoreEntries).toBe(false);

    await client.close();
  });

  it("edit_file changes part of a file, and its errors say what to do", async () => {
    const { key } = await setup();
    const client = await connect(key);
    type EditResult = {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "edit_file", arguments: args })) as EditResult;

    await client.callTool({
      name: "write_file",
      arguments: { path: "plan.md", content: "# Plan\n\n- [ ] one\n- [ ] two\n\nOwner: TBC\n" },
    });

    const done = await call({
      path: "plan.md",
      oldString: "Owner: TBC",
      newString: "Owner: Sam",
      baseVersion: 1,
    });
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toEqual({ ok: true, version: 2, replacements: 1 });

    const ambiguous = await call({
      path: "plan.md",
      oldString: "- [ ]",
      newString: "- [x]",
      baseVersion: 2,
    });
    expect(ambiguous.structuredContent).toMatchObject({
      ok: false,
      error: "old_string_ambiguous",
      matches: 2,
      currentVersion: 2,
    });
    expect(ambiguous.content[0].text).toContain("replaceAll");

    const all = await call({
      path: "plan.md",
      oldString: "- [ ]",
      newString: "- [x]",
      replaceAll: true,
      baseVersion: 2,
    });
    expect(all.structuredContent).toEqual({ ok: true, version: 3, replacements: 2 });

    const missing = await call({
      path: "plan.md",
      oldString: "Owner: Alex",
      newString: "x",
      baseVersion: 3,
    });
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({
      ok: false,
      error: "old_string_not_found",
      currentVersion: 3,
      editIndex: 0,
    });

    // Several edits in one call, all or nothing.
    const multi = await call({
      path: "plan.md",
      edits: [
        { oldString: "# Plan", newString: "# Launch plan" },
        { oldString: "Owner: Sam", newString: "Owner: Sam and Alex" },
      ],
      baseVersion: 3,
    });
    expect(multi.structuredContent).toEqual({ ok: true, version: 4, replacements: 2 });

    // A person changes another part of the file; the agent's stale edit still lands.
    await client.callTool({
      name: "write_file",
      arguments: {
        path: "plan.md",
        content: "# Launch plan\n\n- [x] one\n- [x] two\n- [ ] three\n\nOwner: Sam and Alex\n",
        baseVersion: 4,
      },
    });
    const rebased = await call({
      path: "plan.md",
      oldString: "Owner: Sam and Alex",
      newString: "Owner: Alex",
      baseVersion: 4,
    });
    expect(rebased.structuredContent).toEqual({
      ok: true,
      version: 6,
      replacements: 1,
      rebasedFrom: 4,
    });
    // Retrying it (reply lost) is recognised, and still reports the rebase.
    const rebasedRetry = await call({
      path: "plan.md",
      oldString: "Owner: Sam and Alex",
      newString: "Owner: Alex",
      baseVersion: 4,
    });
    expect(rebasedRetry.structuredContent).toEqual(rebased.structuredContent);
    expect(rebasedRetry.content[0].text).toContain("Re-read");
    const read = (await client.callTool({
      name: "read_file",
      arguments: { path: "plan.md" },
    })) as { content: { text: string }[] };
    expect(read.content[0].text).toContain("- [ ] three");
    expect(read.content[0].text).toContain("Owner: Alex\n");

    // Stale and the targeted text changed: kept as a conflicted copy, like write_file.
    const conflicted = await call({
      path: "plan.md",
      oldString: "Owner: Sam and Alex",
      newString: "Owner: Robin",
      baseVersion: 4,
    });
    expect(conflicted.structuredContent).toMatchObject({ ok: false, currentVersion: 6 });
    expect(conflicted.structuredContent?.conflictCopyPath).toContain("conflicted copy");

    const notFound = await call({
      path: "nope.md",
      oldString: "a",
      newString: "b",
      baseVersion: 1,
    });
    expect(notFound.isError).toBe(true);
    expect(notFound.content[0].text).toContain("Not found");

    await client.callTool({
      name: "write_file",
      arguments: { path: "pixel.png", content: PNG_1x1_BASE64, encoding: "base64" },
    });
    const binary = await call({
      path: "pixel.png",
      oldString: "PNG",
      newString: "x",
      baseVersion: 1,
    });
    expect(binary.isError).toBe(true);
    expect(binary.content[0].text).toContain("write_file");

    // A retry whose reply was lost (same edit, same base) is a no-op, even
    // though newString contains oldString and would match again.
    await client.callTool({
      name: "write_file",
      arguments: { path: "team.md", content: "Owner: Sam\n" },
    });
    const insert = {
      path: "team.md",
      oldString: "Owner: Sam",
      newString: "Owner: Sam and Alex",
      baseVersion: 1,
    };
    expect((await call(insert)).structuredContent).toMatchObject({ ok: true, version: 2 });
    expect((await call(insert)).structuredContent).toMatchObject({ ok: true, version: 2 });
    const team = (await client.callTool({
      name: "read_file",
      arguments: { path: "team.md" },
    })) as { content: { text: string }[] };
    expect(team.content[0].text).toBe("Owner: Sam and Alex\n");

    // After editing a conflicted copy (whose first version has no stored
    // content), a stale edit can't be checked against that own write, so it
    // is refused as data rather than risk repeating it.
    const copyPath = conflicted.structuredContent?.conflictCopyPath as string;
    const copyEdit = { path: copyPath, oldString: "# Launch", newString: "# The launch" };
    expect((await call({ ...copyEdit, baseVersion: 1 })).structuredContent).toMatchObject({
      ok: true,
      version: 2,
    });
    expect(
      (await call({ ...copyEdit, oldString: "plan", newString: "plan!", baseVersion: 1 }))
        .structuredContent,
    ).toEqual({ ok: false, error: "retry_unverifiable", currentVersion: 2 });

    // An edit that would outgrow the per-file limit is a hard error, refused
    // from the projected size before anything is built: 10,000 matches of a
    // 20,000-byte replacement is ~200 MB, over the default 100 MB limit.
    await client.callTool({
      name: "write_file",
      arguments: { path: "grow.txt", content: "a".repeat(10_000) },
    });
    const grow = await call({
      path: "grow.txt",
      oldString: "a",
      newString: "b".repeat(20_000),
      replaceAll: true,
      baseVersion: 1,
    });
    expect(grow.isError).toBe(true);
    expect(grow.content[0].text).toContain("limit");

    // Malformed input is a hard error before anything is read.
    const both = await call({
      path: "plan.md",
      oldString: "a",
      newString: "b",
      edits: [{ oldString: "c", newString: "d" }],
      baseVersion: 6,
    });
    expect(both.isError).toBe(true);

    const empty = await call({ path: "plan.md", oldString: "", newString: "b", baseVersion: 6 });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("write_file");

    await client.close();
  });

  it("user-scoped key: edit_file takes an explicit workspaceId", async () => {
    const { key } = await setupUser();
    const client = await connect(key);
    const created = (await client.callTool({
      name: "create_workspace",
      arguments: { name: "Edit WS" },
    })) as { structuredContent?: { id: string } };
    const wsId = created.structuredContent!.id;
    await client.callTool({
      name: "write_file",
      arguments: { workspaceId: wsId, path: "e.md", content: "hello world" },
    });
    const res = (await client.callTool({
      name: "edit_file",
      arguments: {
        workspaceId: wsId,
        path: "e.md",
        oldString: "world",
        newString: "there",
        baseVersion: 1,
      },
    })) as { structuredContent?: Record<string, unknown> };
    expect(res.structuredContent).toEqual({ ok: true, version: 2, replacements: 1 });
    const read = (await client.callTool({
      name: "read_file",
      arguments: { workspaceId: wsId, path: "e.md" },
    })) as { content: { text: string }[] };
    expect(read.content[0].text).toBe("hello there");
    await client.close();
  });

  it("both builders expose the same list_comments paging inputs", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const { key: userKey } = await setupUser();
    const userClient = await connect(userKey);

    const inputs = async (c: Client) => {
      const tool = (await c.listTools()).tools.find((t) => t.name === "list_comments")!;
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      // The user-scoped tool takes an explicit workspaceId; everything else must
      // match, or an agent's paging works on one key type and not the other.
      return Object.keys(props)
        .filter((k) => k !== "workspaceId")
        .sort();
    };
    const scoped = await inputs(client);
    expect(scoped).toEqual(await inputs(userClient));
    expect(scoped).toEqual(expect.arrayContaining(["entriesLimit", "entriesOffset", "offset"]));

    await client.close();
    await userClient.close();
  });

  it("unknown thread ids are tool errors (not-found), in both builders", async () => {
    const { key } = await setup();
    const client = await connect(key);
    for (const call of [
      { name: "reply_comment", arguments: { threadId: "nope", body: "x" } },
      { name: "resolve_comment", arguments: { threadId: "nope", resolved: true } },
      { name: "list_comments", arguments: { threadId: "nope" } },
    ]) {
      const res = (await client.callTool(call)) as { isError?: boolean };
      expect(res.isError).toBe(true);
    }
    await client.close();
  });

  it("user-scoped key: the same four tools work with an explicit workspaceId", async () => {
    const { key } = await setupUser();
    const client = await connect(key);
    const created = (await client.callTool({
      name: "create_workspace",
      arguments: { name: "Comment WS" },
    })) as { structuredContent?: { id: string } };
    const wsId = created.structuredContent!.id;

    await client.callTool({
      name: "write_file",
      arguments: { workspaceId: wsId, path: "u.md", content: V1 },
    });
    const added = (await client.callTool({
      name: "add_comment",
      arguments: { workspaceId: wsId, path: "u.md", body: "note", quote: QUOTE },
    })) as { isError?: boolean; structuredContent?: { ok: boolean; thread: ThreadPayload } };
    expect(added.isError).toBeFalsy();
    const threadId = added.structuredContent!.thread.id;

    const listed = (await client.callTool({
      name: "list_comments",
      arguments: { workspaceId: wsId, path: "u.md" },
    })) as ListResult;
    expect(listed.structuredContent!.threads[0]!.quote).toBe(QUOTE);
    expect(JSON.stringify(listed.structuredContent)).not.toMatch(POSITION_KEYS);

    const replied = (await client.callTool({
      name: "reply_comment",
      arguments: { workspaceId: wsId, threadId, body: "ack", dedupeKey: "u1" },
    })) as { structuredContent?: { ok: boolean } };
    expect(replied.structuredContent?.ok).toBe(true);

    const resolved = (await client.callTool({
      name: "resolve_comment",
      arguments: { workspaceId: wsId, threadId, resolved: true },
    })) as { structuredContent?: { resolved: boolean } };
    expect(resolved.structuredContent?.resolved).toBe(true);

    // Reopening travels the same tool (a boolean, not a second verb).
    const reopened = (await client.callTool({
      name: "resolve_comment",
      arguments: { workspaceId: wsId, threadId, resolved: false },
    })) as { structuredContent?: { resolved: boolean; changed: boolean } };
    expect(reopened.structuredContent).toMatchObject({ resolved: false, changed: true });

    await client.close();
  });
});

// The server instructions must teach the loop — an agent nudged with "address
// my comments on X" has only this text to go on (R5).
describe("mcp server instructions", () => {
  it("names the comment tools and the resolve-only-what-you-fixed rule", async () => {
    const { SERVER_INSTRUCTIONS } = await import("../server/utils/mcp");
    expect(SERVER_INSTRUCTIONS).toContain("list_comments");
    expect(SERVER_INSTRUCTIONS).toContain("reply_comment");
    expect(SERVER_INSTRUCTIONS).toContain("resolve_comment");
    expect(SERVER_INSTRUCTIONS).toContain("baseVersion");
    // Partial edits are the default way to change an existing file.
    expect(SERVER_INSTRUCTIONS).toContain("edit_file");
    expect(SERVER_INSTRUCTIONS).toMatch(/don't resolve what you didn't fix/i);
    // Boards are driven by front matter, and list_members is how an agent finds
    // a real person to assign.
    expect(SERVER_INSTRUCTIONS).toContain("view: board");
    expect(SERVER_INSTRUCTIONS).toContain("status:");
    expect(SERVER_INSTRUCTIONS).toContain("list_members");
    expect(SERVER_INSTRUCTIONS).toContain("card_fields");
    // The old closing line claimed everything the web UI does is a plain-file
    // operation. Comments are not files — that claim must not stand unqualified.
    expect(SERVER_INSTRUCTIONS).not.toContain(
      "Anything the web UI does with these is a plain-file operation, so reading and writing files is enough to participate.",
    );
  });
});

// read_file response cap (U4). Needs the api server booted with a small, known
// MCP_MAX_READ_BYTES (below the upload cap) so an over-cap file is writable but
// unreadable-whole. Start the server with e.g. `MCP_MAX_READ_BYTES=64` and set
// `SMOKE_MCP_MAX_READ_BYTES=64`; otherwise these skip.
const MCP_READ_CAP = process.env.SMOKE_MCP_MAX_READ_BYTES
  ? Number.parseInt(process.env.SMOKE_MCP_MAX_READ_BYTES, 10)
  : undefined;

describe.skipIf(!serverUp || MCP_READ_CAP === undefined)("mcp read_file size cap (U4)", () => {
  const cap = MCP_READ_CAP as number;

  it("returns a structured too-large error instead of the payload; maxBytes truncates", async () => {
    const { key } = await setup();
    const client = await connect(key);
    const big = "x".repeat(cap + 50); // over the read cap, under the upload cap
    await client.callTool({ name: "write_file", arguments: { path: "big.txt", content: big } });

    const whole = (await client.callTool({
      name: "read_file",
      arguments: { path: "big.txt" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(whole.isError).toBe(true);
    expect(whole.content[0].text).toContain("File too large");
    expect(whole.content[0].text).toContain(String(cap + 50)); // reports the size

    const windowed = (await client.callTool({
      name: "read_file",
      arguments: { path: "big.txt", maxBytes: 10 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(windowed.isError).toBeFalsy();
    expect(windowed.content[0].text).toBe("x".repeat(10)); // truncated read

    await client.close();
  });
});