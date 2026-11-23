import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { once } from "../src/streams";
import { type ApiClient, AuthError } from "../src/api-client";
import type { Config } from "../src/config";
import { type IndexMap, loadIndex, saveIndex } from "../src/index-store";
import { runSync } from "../src/sync";
import { reconcilePath, scanLocal, type SyncContext } from "../src/sync-core";

const cfg: Config = { apiBase: "https://x", apiKey: "k", workspaceId: "w" };
// A live synced root always carries `.treehouse/config.json` (written at login);
// seed it so the root-liveness guard treats these roots as present.
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "th-sync-"));
  mkdirSync(join(d, ".treehouse"), { recursive: true });
  writeFileSync(join(d, ".treehouse", "config.json"), JSON.stringify(cfg));
  return d;
};

// Minimal fake API: a remote file map + recorded puts/deletes. Enough to drive
// runSync's create/pull/delete/pushDelete apply paths.
function fakeApi(remote: Record<string, { bytes: Uint8Array; version: number }> = {}) {
  const puts: string[] = [];
  const deletes: string[] = [];
  const api = {
    list: () =>
      Promise.resolve(
        Object.entries(remote).map(([path, f]) => ({
          path,
          version: f.version,
          size: f.bytes.length,
          contentType: "text/plain",
        })),
      ),
    get: (path: string) => {
      const f = remote[path];
      return Promise.resolve(f ? { body: once(f.bytes), version: f.version } : null);
    },
    put: (path: string, bytes: Uint8Array) => {
      puts.push(path);
      remote[path] = { bytes, version: 1 };
      return Promise.resolve({ ok: true as const, version: 1 });
    },
    delete: (path: string) => {
      deletes.push(path);
      delete remote[path];
      return Promise.resolve("ok" as const);
    },
  };
  return { api: api as unknown as ApiClient, puts, deletes, remote };
}

// Seed `files` on disk and write a matching baseline so scanLocal sees them as
// unchanged (localChanged=false) — the state in which a missing remote would
// otherwise drive deleteLocal.
function seedSyncedFolder(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  const scanned = scanLocal(root, {});
  const index: IndexMap = {};
  for (const [path, e] of scanned)
    index[path] = { version: 1, hash: e.hash, mtime: e.mtime, size: e.size };
  saveIndex(root, index, cfg.workspaceId);
}

describe("runSync access-loss on the full pass", () => {
  it("drops a file as access-lost (no throw) when a re-push is forbidden (404)", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "secret.md": "S", "keep.md": "K" });
    // Empty remote (both files filtered out / privatized) would trip the
    // mass-delete guard into re-pushing. The server forbids the write to
    // secret.md (now private to another member); keep.md re-uploads fine.
    const puts: string[] = [];
    const api = {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      put: (path: string) => {
        puts.push(path);
        return path === "secret.md"
          ? Promise.resolve({ ok: false as const, forbidden: true as const })
          : Promise.resolve({ ok: true as const, version: 1 });
      },
      delete: () => Promise.resolve("ok" as const),
    } as unknown as ApiClient;

    const s = await runSync(root, cfg, api);

    // secret.md is removed locally (access-lost); the pass did not throw.
    expect(existsSync(join(root, "secret.md"))).toBe(false);
    expect(existsSync(join(root, "keep.md"))).toBe(true);
    expect(s.deleted).toContain("secret.md");
  });
});

describe("runSync mass-delete guard", () => {
  it("re-uploads instead of deleting when the remote came back empty", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "a.md": "A", "b.md": "B", "c.md": "C" });
    const { api, puts, deletes } = fakeApi(/* empty remote = reset */);

    const s = await runSync(root, cfg, api);

    // Nothing deleted on disk; all three kept and re-uploaded.
    expect(existsSync(join(root, "a.md"))).toBe(true);
    expect(existsSync(join(root, "b.md"))).toBe(true);
    expect(existsSync(join(root, "c.md"))).toBe(true);
    expect(deletes).toEqual([]);
    expect(puts.sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(s.refusedDeletes.sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(s.deleted).toEqual([]);
  });

  it("still deletes a single file when the remote is otherwise present (real deletion)", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "keep.md": "K", "gone.md": "G" });
    // Remote still has keep.md but not gone.md → gone.md was genuinely deleted.
    const { api, deletes } = fakeApi({ "keep.md": { bytes: new Uint8Array([75]), version: 1 } });

    const s = await runSync(root, cfg, api);

    expect(existsSync(join(root, "gone.md"))).toBe(false); // real delete propagates
    expect(deletes).toEqual([]); // no remote delete — this was a local delete
    expect(s.deleted).toEqual(["gone.md"]);
    expect(s.refusedDeletes).toEqual([]);
  });

  it("discards a baseline from another workspace (no deletes, re-creates)", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "a.md": "A" }); // baseline stamped with workspace "w"
    const otherWs: Config = { ...cfg, workspaceId: "different" };
    const { api, deletes, puts } = fakeApi();

    const s = await runSync(root, otherWs, api);

    // Baseline discarded → a.md is "new" → create, never delete.
    expect(existsSync(join(root, "a.md"))).toBe(true);
    expect(deletes).toEqual([]);
    expect(puts).toEqual(["a.md"]);
    expect(s.deleted).toEqual([]);
  });
});
describe("runSync root-liveness guard (R12)", () => {
  it("refuses the whole pass when the root's marker is gone — zero remote deletes", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "a.md": "A", "b.md": "B", "c.md": "C" });
    // Remote still has all three; a normal pass would see the (now unreadable)
    // tree as empty and pushDelete every file — the folder-move data-loss bug.
    const { api, puts, deletes } = fakeApi({
      "a.md": { bytes: new Uint8Array([65]), version: 1 },
      "b.md": { bytes: new Uint8Array([66]), version: 1 },
      "c.md": { bytes: new Uint8Array([67]), version: 1 },
    });

    // Simulate a Finder move: the folder (and its marker) is gone at this path.
    rmSync(join(root, ".treehouse", "config.json"), { force: true });

    const s = await runSync(root, cfg, api);

    expect(s.rootLost).toBe("missing");
    expect(deletes).toEqual([]); // nothing propagated to the team
    expect(puts).toEqual([]); // and nothing else touched
    expect(s.deleted).toEqual([]);
  });

  it("reports `unreadable` distinctly when the marker denies access (EPERM)", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "a.md": "A" });
    const { api } = fakeApi({ "a.md": { bytes: new Uint8Array([65]), version: 1 } });

    // Make the marker's parent directory unreadable so statSync throws EPERM.
    const treehouse = join(root, ".treehouse");
    let s: Awaited<ReturnType<typeof runSync>>;
    try {
      chmodSync(treehouse, 0o000);
      s = await runSync(root, cfg, api);
    } finally {
      chmodSync(treehouse, 0o755);
    }

    expect(s.rootLost).toBe("unreadable");
  });
});

describe("runSync ignored paths", () => {
  const LAYOUT = ".obsidian/workspace.json";

  function seedLayout(root: string, content: string): void {
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(join(root, LAYOUT), content);
  }

  it("never deletes an ignored file a client synced before it was ignored", async () => {
    // The upgrade case. The index still has the baseline and the scan no longer
    // reports the file, which reads as "deleted locally" unless the path is
    // skipped. Propagating that would delete it for the whole team.
    const root = tmp();
    seedLayout(root, "mine");
    const stale = { [LAYOUT]: { version: 3, hash: "stale", mtime: 1, size: 4 } };
    saveIndex(root, stale, cfg.workspaceId);
    const { api, deletes, puts, remote } = fakeApi({
      [LAYOUT]: { bytes: new Uint8Array([65]), version: 3 },
    });

    const s = await runSync(root, cfg, api);

    expect(deletes).toEqual([]);
    expect(puts).toEqual([]);
    expect(remote[LAYOUT]).toBeDefined();
    expect(readFileSync(join(root, LAYOUT), "utf8")).toBe("mine");
    expect(s.pulled).not.toContain(LAYOUT);
  });

  it("doesn't pull an ignored file down over the local one", async () => {
    const root = tmp();
    seedLayout(root, "mine");
    const { api } = fakeApi({ [LAYOUT]: { bytes: new Uint8Array([65]), version: 2 } });

    await runSync(root, cfg, api);

    expect(readFileSync(join(root, LAYOUT), "utf8")).toBe("mine");
  });

  it("doesn't create an ignored file that exists only in the workspace", async () => {
    const root = tmp();
    const { api } = fakeApi({ [LAYOUT]: { bytes: new Uint8Array([65]), version: 2 } });

    await runSync(root, cfg, api);

    expect(existsSync(join(root, LAYOUT))).toBe(false);
  });

  it("doesn't upload an ignored file, but syncs the settings beside it", async () => {
    const root = tmp();
    seedLayout(root, "mine");
    writeFileSync(join(root, ".obsidian/app.json"), "{}");
    const { api, puts } = fakeApi();

    await runSync(root, cfg, api);

    expect(puts).toEqual([".obsidian/app.json"]);
  });

  it("ignores a change-feed event for an ignored path", async () => {
    const root = tmp();
    seedLayout(root, "mine");
    const { api, deletes, puts } = fakeApi();
    const index: IndexMap = { [LAYOUT]: { version: 3, hash: "stale" } };
    const summary = { pushed: [], pulled: [], deletedLocal: [], deletedRemote: [], conflicts: [] };
    const ctx = { root, api, index, summary } as unknown as SyncContext;

    await reconcilePath(ctx, LAYOUT, { version: 4 });
    await reconcilePath(ctx, LAYOUT, undefined);

    expect(deletes).toEqual([]);
    expect(puts).toEqual([]);
    expect(readFileSync(join(root, LAYOUT), "utf8")).toBe("mine");
  });
});

describe("runSync .keep handling", () => {
  it("pulls a .keep to disk (folder materializes) but hides it from the summary", async () => {
    const root = tmp();
    const { api } = fakeApi({
      "notes/.keep": { bytes: new Uint8Array([10]), version: 1 },
      "notes/todo.md": { bytes: new Uint8Array([65]), version: 1 },
    });

    const s = await runSync(root, cfg, api);

    // The folder materializes locally via its .keep…
    expect(existsSync(join(root, "notes/.keep"))).toBe(true);
    expect(existsSync(join(root, "notes/todo.md"))).toBe(true);
    // …but .keep is not surfaced as user-facing sync churn.
    expect(s.pulled).toContain("notes/todo.md");
    expect(s.pulled).not.toContain("notes/.keep");
  });
});
describe("runSync per-path failure isolation", () => {
  it("keeps going past a failed transfer and still persists the baseline", async () => {
    const root = tmp();
    // A fresh folder pulling a workspace down: the middle file's download fails.
    const bytes = (n: number) => new Uint8Array([n]);
    const remote: Record<string, { bytes: Uint8Array; version: number }> = {
      "a.md": { bytes: bytes(65), version: 1 },
      "boom.md": { bytes: bytes(66), version: 1 },
      "c.md": { bytes: bytes(67), version: 1 },
    };
    const api = {
      list: () =>
        Promise.resolve(
          Object.entries(remote).map(([path, f]) => ({
            path,
            version: f.version,
            size: f.bytes.length,
            contentType: "text/plain",
          })),
        ),
      get: (path: string) =>
        path === "boom.md"
          ? Promise.reject(new Error("get boom.md failed: 500"))
          : Promise.resolve(
              remote[path]
                ? { body: once(remote[path].bytes), version: remote[path].version }
                : null,
            ),
      put: () => Promise.resolve({ ok: true as const, version: 1 }),
      delete: () => Promise.resolve("ok" as const),
    } as unknown as ApiClient;

    const s = await runSync(root, cfg, api);

    // The other two files landed and the failure is reported, not thrown.
    expect(existsSync(join(root, "a.md"))).toBe(true);
    expect(existsSync(join(root, "c.md"))).toBe(true);
    expect(s.pulled.sort()).toEqual(["a.md", "c.md"]);
    expect(s.failed.map((f) => f.path)).toEqual(["boom.md"]);
    expect(s.failed[0]?.reason).toContain("500");

    // The baseline for the successful paths is on disk. Without it, the next
    // pass would see local files with no baseline, reconcile them to `create`
    // and re-upload the whole workspace.
    const saved = loadIndex(root, cfg.workspaceId);
    expect(Object.keys(saved).sort()).toEqual(["a.md", "c.md"]);
  });

  it("does not re-upload already-pulled files on the pass after a failure", async () => {
    const root = tmp();
    const bytes = (n: number) => new Uint8Array([n]);
    const remote: Record<string, { bytes: Uint8Array; version: number }> = {
      "a.md": { bytes: bytes(65), version: 1 },
      "boom.md": { bytes: bytes(66), version: 1 },
    };
    let failGet = true;
    const puts: string[] = [];
    const api = {
      list: () =>
        Promise.resolve(
          Object.entries(remote).map(([path, f]) => ({
            path,
            version: f.version,
            size: f.bytes.length,
            contentType: "text/plain",
          })),
        ),
      get: (path: string) =>
        path === "boom.md" && failGet
          ? Promise.reject(new Error("get boom.md failed: 500"))
          : Promise.resolve(
              remote[path]
                ? { body: once(remote[path].bytes), version: remote[path].version }
                : null,
            ),
      put: (path: string) => {
        puts.push(path);
        return Promise.resolve({ ok: true as const, version: 1 });
      },
      delete: () => Promise.resolve("ok" as const),
    } as unknown as ApiClient;

    await runSync(root, cfg, api);
    failGet = false;
    const second = await runSync(root, cfg, api);

    expect(puts).toEqual([]); // nothing was ever pushed back up
    expect(second.pulled).toEqual(["boom.md"]); // only the leftover path
    expect(second.failed).toEqual([]);
  });

  it("stops on a revoked key but persists the baseline it earned first", async () => {
    const root = tmp();
    const bytes = (n: number) => new Uint8Array([n]);
    const paths = ["a.md", "b.md", "c.md", "d.md"];
    const remote = Object.fromEntries(
      paths.map((p, i) => [p, { bytes: bytes(65 + i), version: 1 }]),
    );
    let gets = 0;
    const api = {
      list: () =>
        Promise.resolve(
          paths.map((path) => ({ path, version: 1, size: 1, contentType: "text/plain" })),
        ),
      get: (path: string) => {
        // The key is revoked partway through the pass.
        if (++gets > 2) return Promise.reject(new AuthError(`get ${path} failed`, 401));
        return Promise.resolve(
          remote[path] ? { body: once(remote[path].bytes), version: remote[path].version } : null,
        );
      },
      put: () => Promise.resolve({ ok: true as const, version: 1 }),
      delete: () => Promise.resolve("ok" as const),
    } as unknown as ApiClient;

    await expect(runSync(root, cfg, api)).rejects.toBeInstanceOf(AuthError);

    // Auth loss is terminal, so the pass stops rather than 401-ing every
    // remaining path — but the two files it did pull keep their baseline.
    expect(gets).toBe(3);
    expect(Object.keys(loadIndex(root, cfg.workspaceId))).toHaveLength(2);
  });
});
describe("runSync scan-failure safety", () => {
  it("treats a file that vanishes mid-scan as deleted, without aborting the pass", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "a.md": "A", "gone.md": "G", "b.md": "B" });
    // Delete after the baseline is written: the pass sees it in the index, and
    // scanLocal's stat of it fails with ENOENT.
    rmSync(join(root, "gone.md"));
    const { api, deletes } = fakeApi({
      "a.md": { bytes: new Uint8Array([65]), version: 1 },
      "gone.md": { bytes: new Uint8Array([71]), version: 1 },
      "b.md": { bytes: new Uint8Array([66]), version: 1 },
    });

    const s = await runSync(root, cfg, api);

    // A genuine local delete still propagates, and the pass completes.
    expect(deletes).toEqual(["gone.md"]);
    expect(s.failed).toEqual([]);
    expect(Object.keys(loadIndex(root, cfg.workspaceId)).sort()).toEqual(["a.md", "b.md"]);
  });

  it("never deletes the remote copy of a file it merely cannot read", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "secret.md": "S", "b.md": "B" });
    // Force a re-read (mtime/size no longer match the baseline) and then make the
    // read fail. Reporting the file as absent here would push a remote delete of
    // a file that is still very much on disk.
    const index = loadIndex(root, cfg.workspaceId);
    index["secret.md"] = { ...index["secret.md"]!, mtime: 1, size: 999 };
    saveIndex(root, index, cfg.workspaceId);
    const { api, deletes, puts } = fakeApi({
      "secret.md": { bytes: new Uint8Array([83]), version: 1 },
      "b.md": { bytes: new Uint8Array([66]), version: 1 },
    });

    const abs = join(root, "secret.md");
    let s: Awaited<ReturnType<typeof runSync>>;
    try {
      chmodSync(abs, 0o000);
      s = await runSync(root, cfg, api);
    } finally {
      chmodSync(abs, 0o644);
    }

    expect(deletes).toEqual([]); // the whole point
    expect(puts).toEqual([]);
    expect(existsSync(abs)).toBe(true);
    expect(s.deleted).toEqual([]);
  });

  it("never overwrites an unreadable local edit when the remote also moved on", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "doc.md": "local edit", "b.md": "B" });
    // The dangerous combination: the local file holds an unpushed edit, it is
    // unreadable right now, AND the remote has moved on. Describing it as
    // "unchanged" makes that a pull, which overwrites the edit with no
    // conflicted copy — the one thing this sync promises never to do.
    const index = loadIndex(root, cfg.workspaceId);
    index["doc.md"] = { ...index["doc.md"]!, mtime: 1, size: 999 };
    saveIndex(root, index, cfg.workspaceId);
    const { api } = fakeApi({
      "doc.md": { bytes: new Uint8Array([82]), version: 9 }, // remote is newer
      "b.md": { bytes: new Uint8Array([66]), version: 1 },
    });

    const abs = join(root, "doc.md");
    let s: Awaited<ReturnType<typeof runSync>>;
    try {
      chmodSync(abs, 0o000);
      s = await runSync(root, cfg, api);
    } finally {
      chmodSync(abs, 0o644);
    }

    expect(readFileSync(abs, "utf8")).toBe("local edit"); // not clobbered
    expect(s.pulled).not.toContain("doc.md");
    expect(s.failed.map((f) => f.path)).toContain("doc.md"); // reported, not silent
    // The baseline is untouched, so the next readable pass reconciles it properly.
    expect(loadIndex(root, cfg.workspaceId)["doc.md"]?.version).toBe(1);
  });

  it("refuses the pass when the tree walk itself fails (no mass remote delete)", async () => {
    const root = tmp();
    seedSyncedFolder(root, { "a.md": "A", "b.md": "B", "c.md": "C" });
    const { api, deletes } = fakeApi({
      "a.md": { bytes: new Uint8Array([65]), version: 1 },
      "b.md": { bytes: new Uint8Array([66]), version: 1 },
      "c.md": { bytes: new Uint8Array([67]), version: 1 },
    });

    // An unreadable root gives readdirSync nothing — which must not read as
    // "every file was deleted". The `.treehouse` marker stays readable, so this
    // is the walk failing, not the root-liveness guard firing.
    let s: Awaited<ReturnType<typeof runSync>>;
    try {
      chmodSync(root, 0o000);
      s = await runSync(root, cfg, api);
    } finally {
      chmodSync(root, 0o755);
    }

    expect(s.rootLost).toBe("unreadable");
    expect(deletes).toEqual([]);
    expect(s.deleted).toEqual([]);
  });
});