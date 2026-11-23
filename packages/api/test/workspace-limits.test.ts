import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { NO_GRANTS } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

// Write-path plan limits (U2): storage bytes, live file count, and per-file
// size, all enforced at the single shared file service so REST and MCP are
// gated identically.
//
// Limits are driven here through the operator env overrides rather than a plan
// slug, because the real tiers are far too large to exercise in a test (1,000
// files on seedling). The merge in `limitsForWorkspace` is what makes these
// equivalent: a plan value wins where set, the env value applies otherwise, so
// the gate under test is the same one a plan drives.

useTempBlobDir("treehouse-limits-");
process.env.BLOB_KEK = `v1:${randomBytes(32).toString("base64")}`;

const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { limitsForWorkspace } = await import("../server/utils/quota");

const db = usePrismaClient();
const svc = useFileService();
const NOW = "2026-08-26T00:00:00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const actor = { principal: "human" as const, access: NO_GRANTS };

async function freshWorkspace() {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

function write(workspaceId: string, path: string, body: string, baseVersion?: number) {
  return svc.write({ workspaceId, path, body: enc(body), baseVersion, actor, nowIso: NOW });
}

afterEach(() => {
  delete process.env.DEFAULT_WORKSPACE_FILE_LIMIT;
  delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
  delete process.env.MAX_FILE_BYTES;
});

describe("file count limit", () => {
  it("accepts creates up to the limit and rejects the one past it", async () => {
    const ws = await freshWorkspace();
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "3";

    for (let i = 0; i < 3; i++) {
      expect((await write(ws.id, `note-${i}.md`, "x")).ok).toBe(true);
    }

    const rejected = await write(ws.id, "note-3.md", "x");
    expect(rejected.ok).toBe(false);
    expect(rejected.fileCountExceeded).toBe(true);
    expect(rejected.fileUsage).toEqual({ usedFiles: 3, limitFiles: 3 });

    // The rejected write must leave nothing behind — no row, no version bump.
    expect(await svc.fileCount(ws.id)).toBe(3);
    expect(await svc.stat(ws.id, "note-3.md", "trusted")).toBeNull();
  });

  it("allows an overwrite at the limit, because replacing a file adds no row", async () => {
    const ws = await freshWorkspace();
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "2";
    await write(ws.id, "a.md", "one");
    await write(ws.id, "b.md", "two");

    const overwrite = await write(ws.id, "a.md", "one revised", 1);
    expect(overwrite.ok).toBe(true);
    expect(overwrite.version).toBe(2);
    expect(await svc.fileCount(ws.id)).toBe(2);
  });

  it("frees capacity when a file is deleted", async () => {
    const ws = await freshWorkspace();
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "2";
    await write(ws.id, "a.md", "one");
    await write(ws.id, "b.md", "two");
    expect((await write(ws.id, "c.md", "three")).fileCountExceeded).toBe(true);

    await svc.remove({ workspaceId: ws.id, path: "b.md", baseVersion: 1, actor });
    expect((await write(ws.id, "c.md", "three")).ok).toBe(true);
  });

  it("never blocks a conflicted copy, even at the limit", async () => {
    // Data preservation beats the cap: a stale write still keeps the losing
    // edit, which can legitimately push the workspace over.
    const ws = await freshWorkspace();
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "1";
    await write(ws.id, "doc.md", "original");
    await write(ws.id, "doc.md", "second", 1);

    // baseVersion 1 is now stale (head is 2) — this must produce a conflicted copy.
    const stale = await write(ws.id, "doc.md", "mine", 1);
    expect(stale.ok).toBe(false);
    expect(stale.fileCountExceeded).toBeUndefined();
    expect(stale.conflict?.conflictCopyPath).toBeTruthy();
    expect(await svc.fileCount(ws.id)).toBe(2);

    // ...and the workspace is now over its limit, so ordinary creates stop.
    const blocked = await write(ws.id, "another.md", "x");
    expect(blocked.fileCountExceeded).toBe(true);
    expect(blocked.fileUsage).toEqual({ usedFiles: 2, limitFiles: 1 });
  });

  it("permits a move while over the limit", async () => {
    const ws = await freshWorkspace();
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "2";
    await write(ws.id, "a.md", "one");
    await write(ws.id, "b.md", "two");
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "1"; // retroactively over limit

    const moved = await svc.move({ workspaceId: ws.id, from: "a.md", to: "moved.md", actor });
    expect(moved.status).toBe("ok");
    expect(await svc.stat(ws.id, "moved.md", "trusted")).not.toBeNull();
  });

  it("is unlimited when no plan or override sets a count", async () => {
    const ws = await freshWorkspace();
    expect((await limitsForWorkspace(ws.id)).files).toBeNull();
    for (let i = 0; i < 5; i++) {
      expect((await write(ws.id, `f-${i}.md`, "x")).ok).toBe(true);
    }
  });
});

describe("per-file size limit", () => {
  it("rejects a body over the ceiling without storing anything", async () => {
    const ws = await freshWorkspace();
    process.env.MAX_FILE_BYTES = "16";

    const rejected = await write(ws.id, "big.md", "x".repeat(64));
    expect(rejected.ok).toBe(false);
    expect(rejected.fileTooLarge).toBe(true);
    expect(rejected.sizeLimit).toEqual({ bytes: 64, limitBytes: 16 });
    expect(await svc.stat(ws.id, "big.md", "trusted")).toBeNull();
    expect(await svc.fileCount(ws.id)).toBe(0);
  });

  it("accepts a body exactly on the ceiling", async () => {
    const ws = await freshWorkspace();
    process.env.MAX_FILE_BYTES = "16";
    expect((await write(ws.id, "ok.md", "x".repeat(16))).ok).toBe(true);
  });

  it("reports the size rejection before any version conflict", async () => {
    // Ordering matters: an oversized stale write must read as too-large, not as
    // a conflict, or a client retries a write that can never succeed.
    const ws = await freshWorkspace();
    await write(ws.id, "doc.md", "original");
    await write(ws.id, "doc.md", "second", 1);
    process.env.MAX_FILE_BYTES = "4";

    const res = await write(ws.id, "doc.md", "x".repeat(32), 1);
    expect(res.fileTooLarge).toBe(true);
    expect(res.conflict).toBeUndefined();
  });
});

describe("storage byte limit", () => {
  it("rejects a write that would exceed the quota and leaves usage unchanged", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "seed.md", "x".repeat(90));
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "100";

    const before = await svc.usage(ws.id);
    const rejected = await write(ws.id, "more.md", "y".repeat(50));
    expect(rejected.quotaExceeded).toBe(true);
    expect(rejected.usage).toEqual({ usedBytes: 90, limitBytes: 100 });
    expect(await svc.usage(ws.id)).toBe(before);
  });

  it("resumes writes once a delete frees space", async () => {
    const ws = await freshWorkspace();
    await write(ws.id, "big.md", "x".repeat(90));
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "100";
    expect((await write(ws.id, "more.md", "y".repeat(50))).quotaExceeded).toBe(true);

    await svc.remove({ workspaceId: ws.id, path: "big.md", baseVersion: 1, actor });
    expect((await write(ws.id, "more.md", "y".repeat(50))).ok).toBe(true);
  });
});

describe("limit precedence", () => {
  it("reports the file-count limit before the byte limit when both would trip", async () => {
    // Both are real, but only one can be reported. File count is the primary
    // limit, so it wins — telling the user to free bytes when the row cap is
    // what blocked them would send them down the wrong path.
    const ws = await freshWorkspace();
    await write(ws.id, "a.md", "x".repeat(90));
    process.env.DEFAULT_WORKSPACE_FILE_LIMIT = "1";
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "100";

    const res = await write(ws.id, "b.md", "y".repeat(50));
    expect(res.fileCountExceeded).toBe(true);
    expect(res.quotaExceeded).toBeUndefined();
  });

  it("caps a plan's file size at the instance ceiling", async () => {
    const ws = await freshWorkspace();
    process.env.MAX_FILE_BYTES = "1024";
    expect((await limitsForWorkspace(ws.id)).maxFileBytes).toBe(1024);
  });
});