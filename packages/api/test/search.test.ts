import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import "./env";

// Local fs storage; no R2 (a partial R2 config is a hard error at import).
process.env.BLOB_DIR = mkdtempSync(join(tmpdir(), "treehouse-search-"));
for (const v of ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
  delete process.env[v];
}

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { setNodePrivate } = await import("../server/utils/acl");
const { searchWorkspace } = await import("../server/utils/search");

const db = usePrismaClient();
const svc = useFileService();

const OWNER = "user_owner";
const OTHER = "user_other";
const enc = (s: string) => new TextEncoder().encode(s);

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

async function write(workspaceId: string, path: string, actorId = OWNER) {
  await svc.write({
    workspaceId,
    path,
    body: enc("x"),
    actor: { principal: "human", actorId, access: asMember(actorId) },
    nowIso: "2026-08-21T00:00:00Z",
  });
}

/** Just the paths, in rank order. */
async function paths(workspaceId: string, query: string, actorId = OWNER, limit?: number) {
  const out = await searchWorkspace({ workspaceId, subject: asMember(actorId), query, limit });
  return out.results.map((r) => r.path);
}

describe("searchWorkspace — matching", () => {
  it("finds a file by a fuzzy, non-adjacent query", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "Clients/acme/notes.md");
    await write(ws.id, "unrelated.txt");
    expect(await paths(ws.id, "clinot")).toContain("Clients/acme/notes.md");
    expect(await paths(ws.id, "clinot")).not.toContain("unrelated.txt");
  });

  it("returns folders as well as files", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "Clients/acme/notes.md");
    const out = await searchWorkspace({
      workspaceId: ws.id,
      subject: asMember(OWNER),
      query: "acme",
    });
    const folder = out.results.find((r) => r.path === "Clients/acme");
    expect(folder).toBeDefined();
    expect(folder?.isDir).toBe(true);
  });

  it("ranks direct name matches above buried ones, deterministically", async () => {
    const ws = await freshWorkspace();
    for (const p of ["report.md", "reports/q1.md", "archive/old-report.md"]) await write(ws.id, p);
    const ranked = await paths(ws.id, "report");
    // `reports` (the synthesized folder) and `report.md` both match by name,
    // consecutively, from index 0 — only the length penalty separates them, so
    // which lands first is not worth asserting. What matters is that both beat a
    // match buried mid-name in a deeper path.
    expect(ranked.slice(0, 2).sort()).toEqual(["report.md", "reports"]);
    expect(ranked.indexOf("archive/old-report.md")).toBeGreaterThan(1);
    // Ordering must be stable across calls: the client and the server have to
    // agree, and unstable ties make every downstream test flaky.
    expect(await paths(ws.id, "report")).toEqual(ranked);
  });
});

describe("searchWorkspace — .keep placeholders", () => {
  it("finds a folder that exists only because of a .keep placeholder", async () => {
    // The sidebar shows such a folder (buildTree skips only the leaf), so search
    // must too, or the human and the agent disagree about what exists.
    const ws = await freshWorkspace();
    await write(ws.id, "EmptyFolder/.keep");
    const out = await searchWorkspace({
      workspaceId: ws.id,
      subject: asMember(OWNER),
      query: "EmptyFolder",
    });
    expect(out.results.map((r) => r.path)).toContain("EmptyFolder");
  });

  it("never returns the .keep file itself", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "EmptyFolder/.keep");
    const out = await searchWorkspace({
      workspaceId: ws.id,
      subject: asMember(OWNER),
      query: "keep",
    });
    expect(out.results.map((r) => r.path)).not.toContain("EmptyFolder/.keep");
  });
});

describe("searchWorkspace — permissions", () => {
  it("hides a file made private by another user", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "secret-notes.md");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "secret-notes.md",
      kind: "file",
      ownerId: OTHER,
    });
    expect(await paths(ws.id, "secret", OTHER)).toContain("secret-notes.md");
    expect(await paths(ws.id, "secret", OWNER)).not.toContain("secret-notes.md");
  });

  it("hides a folder whose files are all private to another user", async () => {
    // Folders are synthesized from the FILTERED listing, so a folder with no
    // visible files must not surface — its name is itself a disclosure.
    const ws = await freshWorkspace();
    await write(ws.id, "hidden-project/plan.md");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "hidden-project/plan.md",
      kind: "file",
      ownerId: OTHER,
    });
    expect(await paths(ws.id, "hidden", OWNER)).not.toContain("hidden-project");
  });

  it("a folder-kind ACL hides the folder and its whole subtree, including descendants", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "journal/today.md");
    await write(ws.id, "journal/2026/q2-deep.md");
    await setNodePrivate({ workspaceId: ws.id, path: "journal", kind: "folder", ownerId: OTHER });
    const visible = await paths(ws.id, "journal", OWNER);
    expect(visible).not.toContain("journal");
    expect(visible).not.toContain("journal/today.md");
    const deep = await paths(ws.id, "q2deep", OWNER);
    expect(deep).not.toContain("journal/2026/q2-deep.md");
    // The owner of the ACL still sees all of it.
    expect(await paths(ws.id, "today", OTHER)).toContain("journal/today.md");
  });

  it("is sibling-prefix safe: an ACL on `dir` neither hides nor exposes `dir2`", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "dir/inside.md");
    await write(ws.id, "dir2/sibling.md");
    await setNodePrivate({ workspaceId: ws.id, path: "dir", kind: "folder", ownerId: OTHER });
    const visible = await paths(ws.id, "sibling", OWNER);
    expect(visible).toContain("dir2/sibling.md");
    expect(await paths(ws.id, "inside", OWNER)).not.toContain("dir/inside.md");
  });

  it("works in a workspace with no ACL rows at all", async () => {
    // files.ts takes a different branch when there are zero ACLs; a
    // "private file is hidden" test only exercises the other one.
    const ws = await freshWorkspace();
    await write(ws.id, "plain.md");
    expect(await paths(ws.id, "plain", OWNER)).toEqual(["plain.md"]);
  });

  it("throws rather than returning empty when the subject has no user id", async () => {
    // Returning empty would look like "nothing matched" and hide the bug.
    const ws = await freshWorkspace();
    await write(ws.id, "plain.md");
    await expect(
      searchWorkspace({ workspaceId: ws.id, subject: asMember(""), query: "plain" }),
    ).rejects.toThrow(/subject/i);
  });

  it("listPaths itself refuses a falsy actor", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "plain.md");
    await expect(svc.listPaths(ws.id, asMember(""))).rejects.toThrow(/subject/i);
  });
});

describe("searchWorkspace — limits", () => {
  it("caps results and reports the pre-cap total", async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 6; i++) await write(ws.id, `notes-${i}.md`);
    const out = await searchWorkspace({
      workspaceId: ws.id,
      subject: asMember(OWNER),
      query: "notes",
      limit: 2,
    });
    expect(out.results).toHaveLength(2);
    expect(out.totalMatches).toBe(6);
  });

  it("clamps an absurd limit rather than honouring it", async () => {
    const ws = await freshWorkspace();
    for (let i = 0; i < 3; i++) await write(ws.id, `notes-${i}.md`);
    const out = await searchWorkspace({
      workspaceId: ws.id,
      subject: asMember(OWNER),
      query: "notes",
      limit: 10_000_000,
    });
    // Fewer matches than the cap here, so the assertion is that it did not throw
    // or over-return; the cap itself is unit-tested in packages/shared.
    expect(out.results).toHaveLength(3);
  });

  it("returns nothing for a query that matches nothing", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "plain.md");
    const out = await searchWorkspace({
      workspaceId: ws.id,
      subject: asMember(OWNER),
      query: "zzzzzz",
    });
    expect(out.results).toEqual([]);
    expect(out.totalMatches).toBe(0);
  });
});