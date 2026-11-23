import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import "./env";

// Local fs storage; no R2.
process.env.BLOB_DIR = mkdtempSync(join(tmpdir(), "treehouse-seed-"));
// Clear ALL four R2 vars, not just the endpoint: .env may set them (any dev with
// R2 configured), and a partial R2 config is a hard error in useBlobStore — which
// fails this file at import, before a single test runs.
for (const v of ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
  delete process.env[v];
}

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { seedWorkspace } = await import("../server/utils/seed");

const db = usePrismaClient();
const svc = useFileService();

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const paths = async (workspaceId: string) =>
  (await svc.list(workspaceId, "", "trusted")).map((e) => e.path).sort();

describe("workspace seed", () => {
  it("writes the starter kit as readable markdown", async () => {
    const ws = await freshWorkspace();
    await seedWorkspace(ws.id);

    expect(await paths(ws.id)).toEqual(["AGENTS.md", "README.md"]);

    for (const path of ["README.md", "AGENTS.md"]) {
      const read = await svc.read(ws.id, path, "trusted");
      expect(read.status).toBe("ok");
      if (read.status !== "ok") continue;
      expect(read.contentType).toBe("text/markdown");
      expect(read.body.byteLength).toBeGreaterThan(0);
    }
  });

  // README.md is what makes the workspace's front page render (the app's
  // folder-default-page convention), and `title:` is what gives it a heading —
  // so both are load-bearing, not decoration.
  it("gives the README front matter the app can use as a front page", async () => {
    const ws = await freshWorkspace();
    await seedWorkspace(ws.id);

    const read = await svc.read(ws.id, "README.md", "trusted");
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(dec(read.body)).toMatch(/^---\ntitle: .+\n---\n/);
  });

  // The bootstrap is worthless if the agent can't tell setup-not-yet-done from
  // a workspace already in use, so the guide must say so in its own text.
  it("addresses the setup guide to an agent and tells it when it is stale", async () => {
    const ws = await freshWorkspace();
    await seedWorkspace(ws.id);

    const read = await svc.read(ws.id, "AGENTS.md", "trusted");
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    const body = dec(read.body) ?? "";
    expect(body).toContain("has not been set up yet");
    expect(body).toContain("stale");
  });

  it("is idempotent — a second seed neither rewrites nor conflicts", async () => {
    const ws = await freshWorkspace();
    await seedWorkspace(ws.id);
    await seedWorkspace(ws.id);

    expect(await paths(ws.id)).toEqual(["AGENTS.md", "README.md"]);
    // Still v1: a second write would have bumped it (or, worse, forked a copy).
    expect(await svc.stat(ws.id, "README.md", "trusted")).toMatchObject({ version: 1 });
  });

  it("leaves an existing file alone rather than forking a conflicted copy", async () => {
    const ws = await freshWorkspace();
    await svc.write({
      workspaceId: ws.id,
      path: "README.md",
      body: enc("mine"),
      actor: { principal: "human", actorId: "u1", access: asMember("u1") },
      nowIso: "2026-08-05T00:00:00Z",
    });

    await seedWorkspace(ws.id);

    const read = await svc.read(ws.id, "README.md", "trusted");
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(dec(read.body)).toBe("mine");
    expect((await paths(ws.id)).some((p) => p.toLowerCase().includes("conflict"))).toBe(false);
  });

  it("skips seeding entirely when TREEHOUSE_SEED=0", async () => {
    const ws = await freshWorkspace();
    const prev = process.env.TREEHOUSE_SEED;
    process.env.TREEHOUSE_SEED = "0";
    try {
      await seedWorkspace(ws.id);
    } finally {
      if (prev === undefined) delete process.env.TREEHOUSE_SEED;
      else process.env.TREEHOUSE_SEED = prev;
    }

    expect(await paths(ws.id)).toEqual([]);
  });

  // A seed is a convenience; the workspace is the product. Signing up must not
  // 500 because the blob store was unreachable.
  it("never throws, so a failure cannot break workspace creation", async () => {
    await expect(seedWorkspace("does-not-exist")).resolves.toBeUndefined();
  });

  // The file service reports a quota rejection by RETURNING ok:false rather than
  // throwing, so the try/catch never sees it. Without the explicit check, a
  // workspace could come out of creation empty with nothing in the log saying
  // why. Asserts the diagnostic, not just the absence of a crash.
  it("logs a write the file service refuses instead of failing silently", async () => {
    const ws = await freshWorkspace();
    // A 1-byte allowance: the seed's writes are clean primary writes, which is
    // exactly what the storage gate rejects (with ok:false, never a throw).
    const prevQuota = process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "1";

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await seedWorkspace(ws.id);
    } finally {
      console.error = original;
      if (prevQuota === undefined) delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
      else process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = prevQuota;
    }

    expect(await paths(ws.id)).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.flat().join(" ")).toMatch(/storage limit/i);
  });

  // An MCP-connected agent has no local folder to discover AGENTS.md in, so the
  // server instructions are the only thing that makes the seed reachable. Drop
  // this paragraph and the whole bootstrap silently stops working over MCP.
  it("points MCP-connected agents at AGENTS.md via the server instructions", async () => {
    const { SERVER_INSTRUCTIONS } = await import("../server/utils/mcp");
    expect(SERVER_INSTRUCTIONS).toContain("AGENTS.md");
  });

  // The setup guide is how an agent learns the folder views exist at all, so it
  // has to describe the board alongside the calendar.
  it("teaches the setup guide how to declare a board", async () => {
    const { SEED_AGENTS } = await import("../server/utils/seed-content");
    expect(SEED_AGENTS).toContain("[[Launch plan]]");
    expect(SEED_AGENTS).toContain("get_links");
    expect(SEED_AGENTS).toContain("list_tags");
    expect(SEED_AGENTS).toContain("view: board");
    expect(SEED_AGENTS).toContain("columns:");
    expect(SEED_AGENTS).toContain("status:");
  });

  // A new user should see a board and a calendar on day one, with something on
  // them — that's how they find out folders can be either. Every template has
  // to carry both, or one starting point quietly loses the demo.
  it("gives every template a Tasks board and a calendar with first entries", async () => {
    const { SEED_AGENTS } = await import("../server/utils/seed-content");
    const templates = SEED_AGENTS.split("## Step 2")[1]!
      .split("## Step 3")[0]!
      .split("### ")
      .slice(1);
    expect(templates).toHaveLength(4);
    for (const t of templates) {
      expect(t).toContain("Tasks/");
      expect(t).toMatch(/(Meetings|Journal)\/ .*calendar/);
    }
    expect(SEED_AGENTS).toContain("Give the board and the calendar a first entry");
  });
});