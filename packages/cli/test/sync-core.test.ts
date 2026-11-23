import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { collect, once } from "../src/streams";
import type { ApiClient } from "../src/api-client";
import type { IndexMap } from "../src/index-store";
import { reconcilePath, scanLocal, type SyncContext, type SyncSummary } from "../src/sync-core";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "th-core-"));

// In-memory stand-in for the server's file service, mirroring its CAS semantics:
// create-only fails (conflict copy) when the path exists; a baseVersion write
// bumps on match, resurrects when absent, and conflict-copies on a stale base.
class FakeApi {
  files = new Map<string, { bytes: Uint8Array; version: number }>();
  /** The content type each path was last pushed with. */
  types = new Map<string, string | undefined>();
  set(path: string, content: string, version: number) {
    this.files.set(path, { bytes: new Uint8Array(Buffer.from(content)), version });
  }
  get(path: string) {
    const f = this.files.get(path);
    return Promise.resolve(f ? { body: once(f.bytes), version: f.version } : null);
  }
  /** Paths whose upload arrived as a stream rather than bytes in memory. */
  streamed = new Set<string>();
  async put(
    path: string,
    content: Uint8Array | AsyncIterable<Uint8Array>,
    opts: { create: true } | { baseVersion: number },
    contentType?: string,
  ) {
    this.types.set(path, contentType);
    if (!(content instanceof Uint8Array)) this.streamed.add(path);
    const bytes = content instanceof Uint8Array ? content : await collect(content);
    const existing = this.files.get(path);
    // Like the server, a losing write keeps its bytes under the copy name.
    const conflict = () => {
      const conflictCopyPath = `conflicted copy - ${path}`;
      this.files.set(conflictCopyPath, { bytes, version: 1 });
      return {
        ok: false as const,
        conflict: true as const,
        currentVersion: existing?.version ?? null,
        conflictCopyPath,
      };
    };
    if ("create" in opts) {
      if (existing) return Promise.resolve(conflict());
      this.files.set(path, { bytes, version: 1 });
      return Promise.resolve({ ok: true as const, version: 1 });
    }
    if (!existing) {
      this.files.set(path, { bytes, version: 1 }); // resurrect
      return Promise.resolve({ ok: true as const, version: 1 });
    }
    if (existing.version === opts.baseVersion) {
      const version = existing.version + 1;
      this.files.set(path, { bytes, version });
      return Promise.resolve({ ok: true as const, version });
    }
    return Promise.resolve(conflict());
  }
  delete(path: string, baseVersion: number) {
    const existing = this.files.get(path);
    if (!existing) return Promise.resolve("not_found" as const);
    if (existing.version === baseVersion) {
      this.files.delete(path);
      return Promise.resolve("ok" as const);
    }
    return Promise.resolve("conflict" as const);
  }
}

function ctxFor(root: string, index: IndexMap = {}) {
  const api = new FakeApi();
  const summary: SyncSummary = {
    pulled: [],
    pushed: [],
    deleted: [],
    conflicts: [],
    refusedDeletes: [],
    oversize: [],
    readOnly: [],
    failed: [],
  };
  const ctx: SyncContext = {
    root,
    api: api as unknown as ApiClient,
    index,
    summary,
    oversizeWarned: new Set(),
  };
  return { ctx, api, index, summary };
}

// Build an index entry that matches the file currently on disk (so the file
// reads as UNCHANGED via the mtime+size fast path).
function unchangedBaseline(root: string, rel: string, content: string, version: number) {
  const st = statSync(join(root, rel));
  return { version, hash: sha(content), mtime: st.mtimeMs, size: st.size };
}

describe("reconcilePath", () => {
  it("pushes a brand-new local file (create)", async () => {
    const root = tmp();
    writeFileSync(join(root, "new.md"), "hello");
    const { ctx, api, summary } = ctxFor(root);

    await reconcilePath(ctx, "new.md", undefined);

    expect(summary.pushed).toContain("new.md");
    expect(api.files.get("new.md")?.version).toBe(1);
    expect(ctx.index["new.md"]?.version).toBe(1);
  });

  it("pushes with the content type from the shared file-type table", async () => {
    // Older CLIs sent application/octet-stream for any extension the table
    // lacked, so a synced .yaml or .sh showed as "not previewable".
    const root = tmp();
    writeFileSync(join(root, "config.yaml"), "a: 1\n");
    writeFileSync(join(root, "deploy.sh"), "echo hi\n");
    writeFileSync(join(root, "movie.mov"), "bytes");
    writeFileSync(join(root, "movie.mkv"), "bytes");
    const { ctx, api } = ctxFor(root);

    await reconcilePath(ctx, "config.yaml", undefined);
    await reconcilePath(ctx, "deploy.sh", undefined);
    await reconcilePath(ctx, "movie.mov", undefined);
    await reconcilePath(ctx, "movie.mkv", undefined);

    expect(api.types.get("config.yaml")).toBe("application/yaml");
    expect(api.types.get("deploy.sh")).toBe("application/x-sh");
    expect(api.types.get("movie.mov")).toBe("video/quicktime");
    // An extension the table still lacks goes up as bytes.
    expect(api.types.get("movie.mkv")).toBe("application/octet-stream");
  });

  it("pulls a remote-only file", async () => {
    const root = tmp();
    const { ctx, api, summary } = ctxFor(root);
    api.set("r.md", "remote", 1);

    await reconcilePath(ctx, "r.md", { version: 1 });

    expect(summary.pulled).toContain("r.md");
    expect(readFileSync(join(root, "r.md"), "utf8")).toBe("remote");
    expect(ctx.index["r.md"]?.version).toBe(1);
  });

  it("deletes locally when remote is gone and local was untouched", async () => {
    const root = tmp();
    writeFileSync(join(root, "d.md"), "same");
    const index: IndexMap = { "d.md": unchangedBaseline(root, "d.md", "same", 1) };
    const { ctx, summary } = ctxFor(root, index);

    await reconcilePath(ctx, "d.md", undefined); // remote absent

    expect(summary.deleted).toContain("d.md");
    expect(existsSync(join(root, "d.md"))).toBe(false);
    expect(ctx.index["d.md"]).toBeUndefined();
  });

  it("resurrects (create) a locally-edited file whose remote was deleted", async () => {
    const root = tmp();
    writeFileSync(join(root, "e.md"), "edited");
    // index reflects OLD content + stale mtime/size, so the file reads as CHANGED.
    const index: IndexMap = { "e.md": { version: 3, hash: sha("old"), mtime: 1, size: 1 } };
    const { ctx, api, summary } = ctxFor(root, index);

    await reconcilePath(ctx, "e.md", undefined); // remote absent + local changed -> create

    expect(summary.pushed).toContain("e.md");
    expect(Buffer.from(api.files.get("e.md")?.bytes ?? new Uint8Array()).toString()).toBe("edited");
  });

  it("keeps both versions on a concurrent edit (conflict copy + adopt winner)", async () => {
    const root = tmp();
    writeFileSync(join(root, "c.md"), "mine");
    // local changed from base v1; remote has advanced to v2 under us.
    const index: IndexMap = { "c.md": { version: 1, hash: sha("base"), mtime: 1, size: 1 } };
    const { ctx, api, summary } = ctxFor(root, index);
    api.set("c.md", "theirs", 2);

    await reconcilePath(ctx, "c.md", { version: 2 }); // both changed -> push -> 412

    // Our bytes preserved under the server's conflict name...
    expect(summary.conflicts).toContain("conflicted copy - c.md");
    expect(readFileSync(join(root, "conflicted copy - c.md"), "utf8")).toBe("mine");
    // ...and the winner adopted locally + re-baselined.
    expect(readFileSync(join(root, "c.md"), "utf8")).toBe("theirs");
    expect(ctx.index["c.md"]?.version).toBe(2);
  });
});

describe("oversized-file skip (U2)", () => {
  // A tiny cap so a small test file counts as "oversized".
  const prev = process.env.TREEHOUSE_MAX_FILE_BYTES;
  const withSmallCap = (fn: () => Promise<void>) => async () => {
    process.env.TREEHOUSE_MAX_FILE_BYTES = "8";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.TREEHOUSE_MAX_FILE_BYTES;
      else process.env.TREEHOUSE_MAX_FILE_BYTES = prev;
    }
  };

  it(
    "skips a file over the cap, reports it once, and pushes nothing for it",
    withSmallCap(async () => {
      const root = tmp();
      writeFileSync(join(root, "big.md"), "0123456789"); // 10 bytes > 8
      const { ctx, api, summary } = ctxFor(root);

      await reconcilePath(ctx, "big.md", undefined);

      expect(summary.oversize).toEqual(["big.md"]);
      expect(api.files.has("big.md")).toBe(false); // never pushed
      expect(ctx.index["big.md"]).toBeUndefined(); // index untouched

      // A second reconcile with the SAME warned-set does not re-report it.
      summary.oversize.length = 0;
      await reconcilePath(ctx, "big.md", undefined);
      expect(summary.oversize).toEqual([]);
      expect(api.files.has("big.md")).toBe(false);
    }),
  );

  it(
    "keeps syncing the other files in the folder",
    withSmallCap(async () => {
      const root = tmp();
      writeFileSync(join(root, "big.md"), "0123456789"); // 10 bytes > 8
      writeFileSync(join(root, "small.md"), "hi"); // 2 bytes, fine
      const { ctx, api, summary } = ctxFor(root);

      await reconcilePath(ctx, "big.md", undefined);
      await reconcilePath(ctx, "small.md", undefined);

      expect(summary.oversize).toEqual(["big.md"]);
      expect(summary.pushed).toContain("small.md");
      expect(api.files.has("small.md")).toBe(true);
      expect(api.files.has("big.md")).toBe(false);
    }),
  );
});
// A push is read-bytes -> network -> baseline, and an agent editing the folder
// can rewrite the file inside that window (copy a note, rebase its links). The
// baseline must then describe the bytes that were UPLOADED, never the newer file
// on disk: pairing the uploaded hash with the newer mtime+size makes scanOne's
// fast path read the edit as "unchanged", so it is never pushed and the folder
// reports itself synced while local and cloud disagree. Observed in the wild —
// a snapshot note whose link-rebase never reached the workspace.
describe("baseline after a push that raced a local edit", () => {
  it("does not let the newer bytes look unchanged", async () => {
    const root = tmp();
    const abs = join(root, "plan.md");
    writeFileSync(abs, "original");
    const { ctx, api } = ctxFor(root);
    // Rewrite the file while the upload is in flight, exactly as the daemon's
    // watcher-driven push races an editor.
    const put = api.put.bind(api);
    api.put = (path, bytes, opts) => {
      writeFileSync(abs, "rebased!"); // same byte length — only the CONTENT differs
      // A real edit lands while the upload is on the network, well after the
      // engine's stat. Here the fake API answers instantly, and Linux stamps
      // files from a coarse clock (1-4 ms), so on a fast machine both writes
      // can share one mtime and the test would measure the clock, not the
      // engine. Stamp the edit a second later, as the real gap would.
      const later = new Date(statSync(abs).mtimeMs + 1000);
      utimesSync(abs, later, later);
      return put(path, bytes, opts);
    };

    await reconcilePath(ctx, "plan.md", undefined);

    // The upload carried the original bytes, so that is what the baseline must
    // claim — and its stat must not vouch for the newer file.
    expect(api.files.get("plan.md")?.version).toBe(1);
    expect(Buffer.from(api.files.get("plan.md")!.bytes).toString()).toBe("original");
    const entry = ctx.index["plan.md"];
    expect(entry?.hash).toBe(sha("original"));
    const st = statSync(abs);
    const looksUnchanged = entry?.mtime === st.mtimeMs && entry?.size === st.size;
    expect(looksUnchanged).toBe(false);

    // Concretely: the next pass sees the edit and uploads it.
    await reconcilePath(ctx, "plan.md", { version: 1 });
    expect(Buffer.from(api.files.get("plan.md")!.bytes).toString()).toBe("rebased!");
    expect(api.files.get("plan.md")?.version).toBe(2);
  });
});
// Large files move as streams: never read whole for a push, a pull or a scan.
describe("streaming large files", () => {
  const MIB = 1024 * 1024;
  // Past the 8 MiB push threshold and across many 1 MiB hash chunks.
  const big = () => new Uint8Array(randomBytes(9 * MIB + 123));
  const shaBytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  it("streams a large push and baselines the hash of exactly what was sent", async () => {
    const root = tmp();
    const content = big();
    writeFileSync(join(root, "clip.mov"), content);
    const { ctx, api } = ctxFor(root);

    await reconcilePath(ctx, "clip.mov", undefined);

    expect(api.streamed.has("clip.mov")).toBe(true);
    expect(Buffer.from(api.files.get("clip.mov")!.bytes).equals(Buffer.from(content))).toBe(true);
    expect(ctx.index["clip.mov"]?.hash).toBe(shaBytes(content));
    expect(ctx.index["clip.mov"]?.size).toBe(content.byteLength);
  });

  it("still pushes a small file from memory", async () => {
    const root = tmp();
    writeFileSync(join(root, "note.md"), "# hi");
    const { ctx, api } = ctxFor(root);
    await reconcilePath(ctx, "note.md", undefined);
    expect(api.streamed.has("note.md")).toBe(false);
  });

  it("pulls a large file to disk, arriving in pieces, and baselines it", async () => {
    const root = tmp();
    const content = big();
    const { ctx, api } = ctxFor(root);
    api.files.set("clip.mov", { bytes: content, version: 4 });
    api.get = (path: string) => {
      const f = api.files.get(path);
      if (!f) return Promise.resolve(null);
      const pieces = async function* () {
        for (let i = 0; i < f.bytes.byteLength; i += 300_007)
          yield f.bytes.subarray(i, i + 300_007);
      };
      return Promise.resolve({ body: pieces(), version: f.version });
    };

    await reconcilePath(ctx, "clip.mov", { version: 4 });

    expect(readFileSync(join(root, "clip.mov")).equals(Buffer.from(content))).toBe(true);
    const entry = ctx.index["clip.mov"];
    expect(entry?.version).toBe(4);
    expect(entry?.hash).toBe(shaBytes(content));
    expect(entry?.size).toBe(content.byteLength);
  });

  it("leaves the existing file untouched and no temp file when a pull fails part way", async () => {
    const root = tmp();
    writeFileSync(join(root, "clip.mov"), "previous");
    const { ctx, api } = ctxFor(root, {
      "clip.mov": unchangedBaseline(root, "clip.mov", "previous", 1),
    });
    api.get = () =>
      Promise.resolve({
        version: 2,
        body: (async function* () {
          yield new Uint8Array(MIB);
          throw new Error("connection reset");
        })(),
      });

    await expect(reconcilePath(ctx, "clip.mov", { version: 2 })).rejects.toThrow(
      /connection reset/,
    );

    expect(readFileSync(join(root, "clip.mov"), "utf8")).toBe("previous");
    expect(readdirSync(root).filter((n) => n.includes("treehouse-tmp"))).toEqual([]);
    expect(ctx.index["clip.mov"]?.version).toBe(1);
  });

  it("mirrors the server's conflicted copy of a streamed file, then adopts the winner", async () => {
    const root = tmp();
    const mine = big();
    writeFileSync(join(root, "clip.mov"), mine);
    const { ctx, api, summary } = ctxFor(root, { "clip.mov": { version: 1, hash: "stale" } });
    api.set("clip.mov", "theirs", 2);

    await reconcilePath(ctx, "clip.mov", { version: 2 });

    const copy = "conflicted copy - clip.mov";
    expect(summary.conflicts).toContain(copy);
    // The local copy is the server's copy, byte for byte, and baselined as such.
    expect(readFileSync(join(root, copy)).equals(Buffer.from(mine))).toBe(true);
    expect(ctx.index[copy]?.hash).toBe(shaBytes(mine));
    // The original path now holds the winner.
    expect(readFileSync(join(root, "clip.mov"), "utf8")).toBe("theirs");
    expect(ctx.index["clip.mov"]?.version).toBe(2);
  });

  it("keeps a large file rewritten during an upload that then loses a conflict", async () => {
    const root = tmp();
    const abs = join(root, "clip.mov");
    const first = big();
    const rewritten = big();
    writeFileSync(abs, first);
    const { ctx, api, summary } = ctxFor(root, { "clip.mov": { version: 1, hash: "stale" } });
    api.set("clip.mov", "theirs", 2);
    // The file is rewritten while its upload is on the wire.
    const put = api.put.bind(api);
    api.put = async (path, content, opts, contentType) => {
      const res = await put(path, content, opts, contentType);
      writeFileSync(abs, rewritten);
      return res;
    };

    await reconcilePath(ctx, "clip.mov", { version: 2 });

    // Nothing overwrote the only complete copy of the new content.
    expect(readFileSync(abs).equals(Buffer.from(rewritten))).toBe(true);
    expect(summary.failed.map((f) => f.path)).toEqual(["clip.mov"]);
    expect(ctx.index["clip.mov"]).toEqual({ version: 1, hash: "stale" });

    // The next pass resolves the conflict with the whole new file.
    api.put = put;
    await reconcilePath(ctx, "clip.mov", { version: 2 });
    const copy = "conflicted copy - clip.mov";
    expect(readFileSync(join(root, copy)).equals(Buffer.from(rewritten))).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("theirs");
  });

  // Conflict resolution ends by replacing the local file with the winner. An
  // edit at any point before that replacement must survive it.
  function conflictSetup(content: Uint8Array) {
    const root = tmp();
    const abs = join(root, "clip.mov");
    writeFileSync(abs, content);
    const setup = ctxFor(root, { "clip.mov": { version: 1, hash: "stale" } });
    setup.api.set("clip.mov", "theirs", 2);
    return { ...setup, abs };
  }

  /** Rewrite the local file just as `path` is fetched, then serve it as usual. */
  function editDuringGet(api: FakeApi, path: string, abs: string, edited: Uint8Array) {
    const get = api.get.bind(api);
    api.get = (p: string) => {
      if (p === path) writeFileSync(abs, edited);
      return get(p);
    };
  }

  it("keeps an edit made while the conflicted copy downloads", async () => {
    const { ctx, api, summary, abs } = conflictSetup(big());
    const edited = big();
    editDuringGet(api, "conflicted copy - clip.mov", abs, edited);
    await reconcilePath(ctx, "clip.mov", { version: 2 });
    expect(readFileSync(abs).equals(Buffer.from(edited))).toBe(true);
    expect(summary.failed.map((f) => f.path)).toEqual(["clip.mov"]);
    expect(ctx.index["clip.mov"]).toEqual({ version: 1, hash: "stale" });
  });

  it.each([
    ["a large file", big],
    ["a small file", () => new Uint8Array(Buffer.from("mine"))],
  ])("keeps an edit made while the winner downloads (%s)", async (_, make) => {
    const { ctx, api, summary, abs } = conflictSetup(make());
    const edited = new Uint8Array(Buffer.from("edited while the winner downloaded"));
    editDuringGet(api, "clip.mov", abs, edited);
    await reconcilePath(ctx, "clip.mov", { version: 2 });
    expect(readFileSync(abs, "utf8")).toBe("edited while the winner downloaded");
    expect(summary.failed.map((f) => f.path)).toEqual(["clip.mov"]);
    expect(ctx.index["clip.mov"]).toEqual({ version: 1, hash: "stale" });
  });

  it("does not adopt the winner when the conflicted copy was changed before we fetched it", async () => {
    const original = big();
    const { ctx, api, summary, abs } = conflictSetup(original);
    // Another client edits the copy between the 412 and our fetch of it.
    const put = api.put.bind(api);
    api.put = async (path, content, opts, contentType) => {
      const res = await put(path, content, opts, contentType);
      api.set("conflicted copy - clip.mov", "someone else's edit", 2);
      return res;
    };
    await reconcilePath(ctx, "clip.mov", { version: 2 });
    // Our losing version survives in the original file, for the next pass.
    expect(readFileSync(abs).equals(Buffer.from(original))).toBe(true);
    expect(summary.conflicts).toEqual([]);
    expect(summary.failed.map((f) => f.path)).toEqual(["clip.mov"]);
  });

  it("does not adopt the winner when the server's conflicted copy has gone", async () => {
    const original = big();
    const { ctx, api, summary, abs } = conflictSetup(original);
    // Another client removes the copy between the 412 and our fetch of it.
    const put = api.put.bind(api);
    api.put = async (path, content, opts, contentType) => {
      const res = await put(path, content, opts, contentType);
      api.files.delete("conflicted copy - clip.mov");
      return res;
    };
    await reconcilePath(ctx, "clip.mov", { version: 2 });
    expect(readFileSync(abs).equals(Buffer.from(original))).toBe(true);
    expect(summary.conflicts).toEqual([]);
    expect(summary.failed.map((f) => f.path)).toEqual(["clip.mov"]);
  });

  it("hashes a large file in the scan without keeping its bytes", () => {
    const root = tmp();
    const content = big();
    writeFileSync(join(root, "clip.mov"), content);
    const entry = scanLocal(root, {}).get("clip.mov");
    expect(entry?.hash).toBe(shaBytes(content));
    expect(entry && "bytes" in entry).toBe(false);
  });
});