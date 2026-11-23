import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { describe, expect, it } from "vite-plus/test";
import { once } from "../src/streams";
import { AuthError, type ApiClient, type RemoteChange } from "../src/api-client";
import type { SyncNotice } from "../src/sync-core";
import type { Config } from "../src/config";
import { loadCursor, saveCursor } from "../src/cursor-store";
import {
  coalesceHint,
  createEngine,
  type EngineState,
  type Hint,
  shouldSkipChange,
} from "../src/engine";
import { loadIndex } from "../src/index-store";

// A fake chokidar watcher that reports "ready" immediately and fires no file
// events — so engine.start() can be driven deterministically without real I/O.
class IdleWatcher extends EventEmitter {
  close() {
    return Promise.resolve();
  }
}
const idleWatchFactory = (): FSWatcher => {
  const w = new IdleWatcher();
  setImmediate(() => w.emit("ready"));
  return w as unknown as FSWatcher;
};

const cfg: Config = { apiBase: "https://x", apiKey: "k", workspaceId: "w" };
// A live synced root always carries `.treehouse/config.json` (written at login);
// seed it so the root-liveness guard treats these roots as present. Removing the
// marker simulates a Finder move/trash of the folder.
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "th-engine-"));
  mkdirSync(join(d, ".treehouse"), { recursive: true });
  writeFileSync(join(d, ".treehouse", "config.json"), JSON.stringify(cfg));
  return d;
};
const text = (s: string) => new Uint8Array(Buffer.from(s));

// In-memory server: file store + a seq-stamped change feed, mirroring the real
// endpoints the engine drives (list/get/put/delete/changes) and the server's CAS.
class FakeServer {
  files = new Map<string, { bytes: Uint8Array; version: number }>();
  feed: RemoteChange[] = [];
  seq = 0;
  #record(path: string, op: RemoteChange["op"], version: number | null) {
    this.seq += 1;
    this.feed.push({ path, op, version, seq: this.seq });
  }
  /** Pre-existing remote file (records a write event, like a prior sync would). */
  seed(path: string, content: string, version = 1) {
    this.files.set(path, { bytes: text(content), version });
    this.#record(path, "write", version);
  }
  /** Brought back from the trash: a fresh v1 with a `restore` event. */
  restoreFromTrash(path: string, content: string) {
    this.files.set(path, { bytes: text(content), version: 1 });
    this.#record(path, "restore", 1);
  }
  /** Owner made `path` private: it vanishes from this caller's view (list omits
   * it) and an access_revoked marker lands on the feed. */
  revoke(path: string) {
    this.files.delete(path);
    this.#record(path, "access_revoked", null);
  }
  /** Owner made a FOLDER private: every descendant file leaves this caller's view
   * and ONE access_revoked marker lands at the folder root (real server shape). */
  revokeFolder(folderPath: string) {
    const prefix = `${folderPath}/`;
    for (const p of this.files.keys()) {
      if (p === folderPath || p.startsWith(prefix)) this.files.delete(p);
    }
    this.#record(folderPath, "access_revoked", null);
  }
  puts: string[] = [];
  /** Set to refuse every change the way a view-only caller is: `refused` with this reason. */
  readOnly?: string;
  /** Every request the read-only refusal answered: what a retry loop would inflate. */
  refusals = 0;
  list() {
    return Promise.resolve(
      [...this.files].map(([path, f]) => ({
        path,
        version: f.version,
        size: f.bytes.length,
        contentType: "text/plain",
      })),
    );
  }
  failGet = new Set<string>();
  failGetOnce(path: string) {
    this.failGet.add(path);
  }
  // Inject a failure on the TRANSFER endpoints (get/put/delete) rather than the
  // feed — the path a revoked key hits mid-drain, after `changes()` has already
  // succeeded for the window.
  failTransfersWith?: Error;
  get(path: string) {
    if (this.failTransfersWith) return Promise.reject(this.failTransfersWith);
    if (this.failGet.has(path)) {
      this.failGet.delete(path);
      return Promise.reject(new Error(`injected get failure for ${path}`));
    }
    const f = this.files.get(path);
    return Promise.resolve(f ? { body: once(f.bytes), version: f.version } : null);
  }
  put(path: string, bytes: Uint8Array, opts: { create: true } | { baseVersion: number }) {
    if (this.failTransfersWith) return Promise.reject(this.failTransfersWith);
    if (this.readOnly) {
      this.refusals += 1;
      return Promise.resolve({ ok: false as const, refused: this.readOnly });
    }
    this.puts.push(path);
    const existing = this.files.get(path);
    const conflict = () => ({
      ok: false as const,
      conflict: true as const,
      currentVersion: existing?.version ?? null,
      conflictCopyPath: `conflicted copy - ${path}`,
    });
    if ("create" in opts) {
      if (existing) return Promise.resolve(conflict());
      this.files.set(path, { bytes, version: 1 });
      this.#record(path, "write", 1);
      return Promise.resolve({ ok: true as const, version: 1 });
    }
    if (!existing) {
      this.files.set(path, { bytes, version: 1 });
      this.#record(path, "write", 1);
      return Promise.resolve({ ok: true as const, version: 1 });
    }
    if (existing.version === opts.baseVersion) {
      const version = existing.version + 1;
      this.files.set(path, { bytes, version });
      this.#record(path, "write", version);
      return Promise.resolve({ ok: true as const, version });
    }
    return Promise.resolve(conflict());
  }
  delete(path: string, baseVersion: number) {
    if (this.failTransfersWith) return Promise.reject(this.failTransfersWith);
    if (this.readOnly) {
      this.refusals += 1;
      return Promise.resolve({ ok: false as const, refused: this.readOnly });
    }
    const existing = this.files.get(path);
    if (!existing) return Promise.resolve("not_found" as const);
    if (existing.version === baseVersion) {
      this.files.delete(path);
      this.#record(path, "delete", baseVersion);
      return Promise.resolve("ok" as const);
    }
    return Promise.resolve("conflict" as const);
  }
  // Paths withheld from THIS caller's feed (ACL-filtered) but still scanned
  // server-side — so `nextSeq` covers them even though `changes` omits them.
  hidden = new Set<string>();
  hide(path: string) {
    this.hidden.add(path);
  }
  // Inject a changes()-feed failure (network drop or an AuthError) to drive the
  // engine's transient-error / auth-lost state reporting.
  failChangesWith?: Error;
  /** How many times the feed has been polled — lets a test assert that a stopped
   * engine really is idle, not merely quiet this instant. */
  pollCount = 0;
  changes(sinceSeq: number, limit?: number) {
    this.pollCount += 1;
    if (this.failChangesWith) return Promise.reject(this.failChangesWith);
    const all = this.feed.filter((e) => e.seq > sinceSeq);
    // The page the server *scans* (bounded by the limit), before ACL filtering.
    const scanned = limit === undefined ? all : all.slice(0, limit);
    const changes = scanned.filter((e) => !this.hidden.has(e.path));
    // nextSeq = last scanned seq (ACL-blind), or the request cursor when empty.
    const nextSeq = scanned.length ? scanned[scanned.length - 1].seq : sinceSeq;
    return Promise.resolve({ changes, head: this.seq, nextSeq });
  }
  asApi(): ApiClient {
    return this as unknown as ApiClient;
  }
}

describe("engine pure helpers", () => {
  it("coalesceHint: poller hint always wins; watcher never clobbers a poller hint", () => {
    const local: Hint = { local: true };
    const remote: Hint = { remote: { version: 3 } };
    expect(coalesceHint(undefined, local)).toEqual(local);
    expect(coalesceHint(undefined, remote)).toEqual(remote);
    expect(coalesceHint(remote, local)).toEqual(remote); // local doesn't override remote
    expect(coalesceHint(local, remote)).toEqual(remote); // remote overrides local
    expect(coalesceHint(remote, { remote: { version: 9 } })).toEqual({ remote: { version: 9 } });
  });

  it("coalesceHint: losing access supersedes any pending hint and is sticky", () => {
    const lost: Hint = { accessLost: true };
    expect(coalesceHint({ local: true }, lost)).toEqual(lost);
    expect(coalesceHint({ remote: { version: 3 } }, lost)).toEqual(lost);
    expect(coalesceHint(lost, { local: true })).toEqual(lost); // a later edit can't undo it
    expect(coalesceHint(lost, { remote: { version: 9 } })).toEqual(lost);
  });

  it("shouldSkipChange: skips already-applied non-deletes, never deletes", () => {
    const index = { "a.md": { version: 5, hash: "h" } };
    expect(shouldSkipChange(index, { path: "a.md", op: "write", version: 5, seq: 1 })).toBe(true);
    expect(shouldSkipChange(index, { path: "a.md", op: "write", version: 6, seq: 2 })).toBe(false);
    expect(shouldSkipChange(index, { path: "a.md", op: "delete", version: 5, seq: 3 })).toBe(false);
    expect(shouldSkipChange(index, { path: "new.md", op: "write", version: 1, seq: 4 })).toBe(
      false,
    );
  });

  it("shouldSkipChange: never skips a path an earlier event in the page queued", () => {
    const index = { "a.md": { version: 1, hash: "h" } };
    const restore = { path: "a.md", op: "restore", version: 1, seq: 9 } as const;
    expect(shouldSkipChange(index, restore)).toBe(true);
    expect(shouldSkipChange(index, restore, new Set(["a.md"]))).toBe(false);
  });
});

describe("engine integration (in-memory server)", () => {
  it("bootstrap populates an empty dir and sets the cursor to the pre-list head", async () => {
    const server = new FakeServer();
    server.seed("a.md", "AAA");
    server.seed("b.md", "BBB");
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });

    await engine.bootstrap();

    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("AAA");
    expect(readFileSync(join(root, "b.md"), "utf8")).toBe("BBB");
    expect(loadCursor(root)).toBe(2); // head was 2 before the list
  });

  it("pollOnce applies a new remote create incrementally", async () => {
    const server = new FakeServer();
    server.seed("a.md", "AAA");
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();
    expect(loadCursor(root)).toBe(1);

    server.seed("c.md", "CCC"); // a new remote file → feed seq 2

    const r = await engine.pollOnce();
    expect(r.applied).toBe(1);
    expect(readFileSync(join(root, "c.md"), "utf8")).toBe("CCC");
    expect(loadCursor(root)).toBe(2);

    // Caught up: a second poll applies nothing and leaves the cursor put.
    const r2 = await engine.pollOnce();
    expect(r2.applied).toBe(0);
    expect(loadCursor(root)).toBe(2);
  });

  it("keeps a file deleted and brought back from the trash within one poll", async () => {
    const server = new FakeServer();
    server.seed("a.md", "AAA"); // v1, never edited
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();

    await server.delete("a.md", 1);
    server.restoreFromTrash("a.md", "AAA"); // back as v1 — the version the index holds

    await engine.pollOnce();
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("AAA");
  });

  it("advances the cursor past a fully ACL-filtered page instead of livelocking (U1)", async () => {
    const server = new FakeServer();
    server.seed("visible.md", "V"); // seq 1, visible to us
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();
    expect(loadCursor(root)).toBe(1);

    // A burst of events all private to another member: scanned server-side but
    // withheld from our feed, so `changes` comes back empty with nextSeq beyond.
    server.hide("priv/a.md");
    server.seed("priv/a.md", "a"); // seq 2 (hidden)
    server.hide("priv/b.md");
    server.seed("priv/b.md", "b"); // seq 3 (hidden)

    const r = await engine.pollOnce();
    expect(r.applied).toBe(0); // nothing visible applied
    expect(server.puts).toHaveLength(0); // and nothing pushed
    // The cursor jumped past the filtered window in one cycle (no re-fetch).
    expect(loadCursor(root)).toBe(3);

    // A follow-up poll is caught up — it does not re-scan the filtered window.
    const r2 = await engine.pollOnce();
    expect(r2.applied).toBe(0);
    expect(loadCursor(root)).toBe(3);

    // A visible event beyond the filtered window still lands.
    server.seed("after.md", "AFTER"); // seq 4, visible
    const r3 = await engine.pollOnce();
    expect(r3.applied).toBe(1);
    expect(readFileSync(join(root, "after.md"), "utf8")).toBe("AFTER");
    expect(loadCursor(root)).toBe(4);
  });

  describe("read-only access: revert and notify", () => {
    // Everything a view-only folder must never produce, checked after every pass.
    const expectNothingLeaked = (server: FakeServer, root: string) => {
      expect(server.puts).toEqual([]);
      expect([...server.files.keys()].filter((p) => p.includes("conflict"))).toEqual([]);
      expect(readdirSync(root).filter((p) => p.includes("conflict"))).toEqual([]);
    };

    async function viewerFolder() {
      const server = new FakeServer();
      server.seed("notes/a.md", "SERVER");
      const root = tmp();
      const notices: SyncNotice[] = [];
      const lines: string[] = [];
      const engine = createEngine(root, cfg, {
        api: server.asApi(),
        onNotice: (ns) => notices.push(...ns),
        log: (m) => lines.push(m),
      });
      await engine.bootstrap();
      server.readOnly = "role";
      return { server, root, engine, notices, lines };
    }

    it("restores the server version, saves the edit, says so, and stops", async () => {
      const { server, root, engine, notices, lines } = await viewerFolder();
      writeFileSync(join(root, "notes/a.md"), "MY EDIT");

      await engine.bootstrap();

      expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("SERVER");
      expect(notices).toEqual([
        {
          path: "notes/a.md",
          outcome: "reverted",
          reason: "role",
          savedTo: expect.stringMatching(/^\.treehouse\/reverted\/notes\/a\.[0-9a-f]{12}\.md$/),
        },
      ]);
      const savedTo = notices[0]!.savedTo as string;
      expect(readFileSync(join(root, savedTo), "utf8")).toBe("MY EDIT");
      expect(lines.join("\n")).toContain("view-only access to this workspace");
      expect(lines.join("\n")).toContain(savedTo);
      expectNothingLeaked(server, root);

      // The loop test: more passes, including full ones, ask the server nothing.
      expect(server.refusals).toBe(1);
      await engine.bootstrap();
      await engine.pollOnce();
      await engine.bootstrap();
      expect(server.refusals).toBe(1);
      expect(notices).toHaveLength(1);
    });

    it("the saved edit never syncs", async () => {
      const { server, root, engine } = await viewerFolder();
      writeFileSync(join(root, "notes/a.md"), "MY EDIT");
      await engine.bootstrap();
      server.readOnly = undefined; // even once the caller could write
      await engine.bootstrap();
      expect([...server.files.keys()]).toEqual(["notes/a.md"]);
      expect(server.puts).toEqual([]);
    });

    it("each further edit is its own refusal, and neither saved edit replaces the other", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      writeFileSync(join(root, "notes/a.md"), "FIRST");
      await engine.bootstrap();
      // A different length from "SERVER": written in the same mtime tick as the
      // restore, an equal size would look unchanged to the scan's fast path.
      writeFileSync(join(root, "notes/a.md"), "SECOND EDIT");
      await engine.bootstrap();
      expect(server.refusals).toBe(2);
      const saved = notices.map((n) => readFileSync(join(root, n.savedTo as string), "utf8"));
      expect(saved).toEqual(["FIRST", "SECOND EDIT"]);
      expectNothingLeaked(server, root);
    });

    it("the same edit refused twice is one saved file", async () => {
      const { root, engine, notices } = await viewerFolder();
      for (let i = 0; i < 2; i += 1) {
        writeFileSync(join(root, "notes/a.md"), "SAME EDIT");
        await engine.bootstrap();
      }
      expect(notices.map((n) => n.savedTo)).toHaveLength(2);
      expect(new Set(notices.map((n) => n.savedTo)).size).toBe(1);
    });

    it("saves an extensionless file under a name that still sorts with it", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      server.readOnly = undefined;
      server.seed("LICENSE", "SERVER");
      await engine.bootstrap();
      server.readOnly = "role";
      writeFileSync(join(root, "LICENSE"), "MINE");
      await engine.bootstrap();
      expect(notices[0]?.savedTo).toMatch(/^\.treehouse\/reverted\/LICENSE\.[0-9a-f]{12}$/);
    });

    it("a folder linked with files of its own still gets remote updates", async () => {
      // Exists on both sides with no baseline: reconcile says `create`, but this
      // isn't a new file, and refusing it must not strand it unsynced for good.
      const server = new FakeServer();
      server.seed("notes/a.md", "SERVER V1");
      const root = tmp();
      mkdirSync(join(root, "notes"), { recursive: true });
      writeFileSync(join(root, "notes/a.md"), "ALREADY HERE");
      const notices: SyncNotice[] = [];
      server.readOnly = "role";
      const engine = createEngine(root, cfg, {
        api: server.asApi(),
        onNotice: (ns) => notices.push(...ns),
      });

      await engine.bootstrap();

      expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("SERVER V1");
      expect(notices).toMatchObject([{ path: "notes/a.md", outcome: "reverted" }]);
      expect(readFileSync(join(root, notices[0]!.savedTo as string), "utf8")).toBe("ALREADY HERE");
      expect(loadIndex(root, cfg.workspaceId)["notes/a.md"]?.version).toBe(1);

      server.readOnly = undefined;
      server.seed("notes/a.md", "SERVER V2", 2);
      server.readOnly = "role";
      await engine.pollOnce();
      expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("SERVER V2");
    });

    it("linking a folder that already matches the server says nothing and saves nothing", async () => {
      const server = new FakeServer();
      server.seed("a.md", "SAME");
      const root = tmp();
      writeFileSync(join(root, "a.md"), "SAME");
      const notices: SyncNotice[] = [];
      server.readOnly = "role";
      const engine = createEngine(root, cfg, {
        api: server.asApi(),
        onNotice: (ns) => notices.push(...ns),
      });
      await engine.bootstrap();
      expect(notices).toEqual([]);
      expect(readdirSync(join(root, ".treehouse/reverted"))).toEqual([]);
      expect(loadIndex(root, cfg.workspaceId)["a.md"]?.version).toBe(1);
    });

    it("a refused new file gives way once someone creates that path on the server", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      writeFileSync(join(root, "plan.md"), "MY DRAFT");
      await engine.bootstrap();
      expect(notices).toMatchObject([{ path: "plan.md", outcome: "kept" }]);

      server.readOnly = undefined;
      server.seed("plan.md", "THEIR PLAN");
      server.readOnly = "role";
      await engine.bootstrap();

      expect(readFileSync(join(root, "plan.md"), "utf8")).toBe("THEIR PLAN");
      const reverted = notices.find((n) => n.outcome === "reverted");
      expect(readFileSync(join(root, reverted?.savedTo as string), "utf8")).toBe("MY DRAFT");
    });

    it("doesn't replace a file recreated while a refused delete was in flight", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      rmSync(join(root, "notes/a.md"));
      const realGet = server.get.bind(server);
      server.get = (path: string) => {
        writeFileSync(join(root, "notes/a.md"), "RECREATED");
        return realGet(path);
      };

      await engine.bootstrap();

      expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("RECREATED");
      expect(notices).toEqual([]);
    });

    it("downloads a deleted file again", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      server.seed("notes/b.md", "B");
      server.readOnly = undefined;
      await engine.bootstrap();
      server.readOnly = "role";
      rmSync(join(root, "notes/b.md"));

      await engine.bootstrap();

      expect(readFileSync(join(root, "notes/b.md"), "utf8")).toBe("B");
      expect(notices).toEqual([{ path: "notes/b.md", outcome: "restored", reason: "role" }]);
      expect(server.files.has("notes/b.md")).toBe(true);
      await engine.bootstrap();
      expect(notices).toHaveLength(1);
    });

    it("leaves a new local file alone, and offers it once", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      writeFileSync(join(root, "mine.md"), "NEW WORK");

      await engine.bootstrap();
      await engine.bootstrap();
      await engine.bootstrap();

      // Deleting someone's work over a permission would be the wrong way round.
      expect(readFileSync(join(root, "mine.md"), "utf8")).toBe("NEW WORK");
      expect(server.refusals).toBe(1);
      expect(notices).toEqual([{ path: "mine.md", outcome: "kept", reason: "role" }]);
      expectNothingLeaked(server, root);
    });

    it("offers a new file again once it changes", async () => {
      const { server, root, engine } = await viewerFolder();
      writeFileSync(join(root, "mine.md"), "NEW WORK");
      await engine.bootstrap();
      writeFileSync(join(root, "mine.md"), "MORE WORK");
      await engine.bootstrap();
      expect(server.refusals).toBe(2);
    });

    it("a daemon restart offers new files once more, so a promotion uploads them", async () => {
      const { server, root, engine } = await viewerFolder();
      writeFileSync(join(root, "mine.md"), "NEW WORK");
      await engine.bootstrap();

      server.readOnly = undefined; // promoted to member
      const restarted = createEngine(root, cfg, { api: server.asApi() });
      await restarted.bootstrap();

      expect(server.files.has("mine.md")).toBe(true);
    });

    it("doesn't overwrite an edit made while the rejection was in flight", async () => {
      const { server, root, engine, notices } = await viewerFolder();
      writeFileSync(join(root, "notes/a.md"), "IN FLIGHT");
      const realPut = server.put.bind(server);
      server.put = (...args: Parameters<typeof realPut>) => {
        writeFileSync(join(root, "notes/a.md"), "NEWER STILL");
        return realPut(...args);
      };

      await engine.bootstrap();

      expect(readFileSync(join(root, "notes/a.md"), "utf8")).toBe("NEWER STILL");
      expect(notices).toEqual([]);
    });
  });

  it("access_revoked removes the local copy and index, and never re-pushes (AE4)", async () => {
    const server = new FakeServer();
    server.seed("secret.md", "PRIVATE");
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();
    expect(readFileSync(join(root, "secret.md"), "utf8")).toBe("PRIVATE");

    // The owner makes it private: it leaves our view and a marker hits the feed.
    server.revoke("secret.md");
    const r = await engine.pollOnce();
    expect(r.applied).toBe(1);

    // Local copy and baseline are gone; we never tried to re-upload it.
    expect(existsSync(join(root, "secret.md"))).toBe(false);
    expect(loadIndex(root, cfg.workspaceId)["secret.md"]).toBeUndefined();
    expect(server.puts).not.toContain("secret.md");
  });

  it("access_revoked wins over an unpushed local edit — the edit is dropped, not resurrected", async () => {
    const server = new FakeServer();
    server.seed("secret.md", "PRIVATE");
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();

    // An unpushed local edit, then the owner privatizes the file before it syncs.
    writeFileSync(join(root, "secret.md"), "MY UNPUSHED EDIT");
    server.revoke("secret.md");

    await engine.pollOnce();

    // The local edit is discarded (access lost); nothing is pushed to the server.
    expect(existsSync(join(root, "secret.md"))).toBe(false);
    expect(server.puts).not.toContain("secret.md");
    expect(server.files.has("secret.md")).toBe(false);
  });

  it("privatizing a FOLDER removes its whole subtree from one access_revoked event", async () => {
    const server = new FakeServer();
    server.seed("priv/a.md", "A");
    server.seed("priv/b.md", "B");
    server.seed("priv/sub/c.md", "C");
    server.seed("top.md", "TOP");
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();
    expect(existsSync(join(root, "priv/sub/c.md"))).toBe(true);

    // The owner privatizes the folder: descendants vanish, ONE marker at "priv".
    server.revokeFolder("priv");
    const r = await engine.pollOnce();
    expect(r.applied).toBe(1);

    // The whole subtree is gone from disk and index; the sibling is untouched.
    expect(existsSync(join(root, "priv"))).toBe(false);
    expect(existsSync(join(root, "top.md"))).toBe(true);
    const idx = loadIndex(root, cfg.workspaceId);
    expect(Object.keys(idx).some((k) => k.startsWith("priv/"))).toBe(false);
    expect(idx["top.md"]).toBeDefined();
    expect(server.puts).not.toContain("priv/a.md");
  });

  it("bulk privatization removes many files without re-pushing any (AE6)", async () => {
    const server = new FakeServer();
    for (let i = 0; i < 30; i++) server.seed(`priv/f${i}.md`, `v${i}`);
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();
    for (let i = 0; i < 30; i++) {
      expect(existsSync(join(root, `priv/f${i}.md`))).toBe(true);
    }

    for (let i = 0; i < 30; i++) server.revoke(`priv/f${i}.md`);
    server.puts = [];
    const r = await engine.pollOnce();
    expect(r.applied).toBe(30);

    for (let i = 0; i < 30; i++) {
      expect(existsSync(join(root, `priv/f${i}.md`))).toBe(false);
    }
    expect(server.puts).toHaveLength(0); // no re-push, no mass-delete refusal
  });

  it("does not advance the cursor past a failed reconcile (retries next poll)", async () => {
    const server = new FakeServer();
    server.seed("a.md", "AAA");
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();
    expect(loadCursor(root)).toBe(1);

    server.seed("b.md", "BBB"); // feed seq 2
    server.failGetOnce("b.md"); // its pull will throw this once

    // The window failed → cursor stays at 1, b.md not written.
    await engine.pollOnce();
    expect(loadCursor(root)).toBe(1);
    expect(existsSync(join(root, "b.md"))).toBe(false);

    // Next poll re-fetches the same window and succeeds.
    await engine.pollOnce();
    expect(readFileSync(join(root, "b.md"), "utf8")).toBe("BBB");
    expect(loadCursor(root)).toBe(2);
  });

  it("applies a batch larger than the concurrency limit in one poll", async () => {
    const server = new FakeServer();
    const root = tmp();
    const engine = createEngine(root, cfg, { api: server.asApi() });
    await engine.bootstrap();

    for (let i = 0; i < 20; i++) server.seed(`f${i}.md`, `v${i}`); // > CONCURRENCY (8)

    const r = await engine.pollOnce();
    expect(r.applied).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(readFileSync(join(root, `f${i}.md`), "utf8")).toBe(`v${i}`);
    }
    expect(loadCursor(root)).toBe(20);
  });

  it("watcher unlink flood after a folder move issues zero pushDeletes and flips to error (R12)", async () => {
    const server = new FakeServer();
    server.seed("a.md", "A");
    server.seed("b.md", "B");
    const root = tmp();

    // A controllable watcher so the test can fire the per-file `unlink` flood
    // chokidar emits when a synced folder is dragged away in Finder.
    let watcher: EventEmitter | undefined;
    const watchFactory = ((): FSWatcher => {
      const w = new (class extends EventEmitter {
        close() {
          return Promise.resolve();
        }
      })();
      watcher = w;
      setImmediate(() => w.emit("ready"));
      return w as unknown as FSWatcher;
    }) as never;

    const states: EngineState[] = [];
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      watchFactory,
      reconcileIntervalMs: 1_000_000,
      onState: (s) => states.push(s),
    });
    await engine.start(); // bootstrap pulls a.md + b.md to disk
    expect(existsSync(join(root, "a.md"))).toBe(true);

    // Finder move: the folder (marker + files) is gone from this path.
    rmSync(root, { recursive: true, force: true });
    watcher?.emit("unlink", join(root, "a.md"));
    watcher?.emit("unlink", join(root, "b.md"));
    await engine.stop(); // awaits the in-flight watcher drain

    // Not one delete reached the server — the team's files are intact.
    expect(server.files.has("a.md")).toBe(true);
    expect(server.files.has("b.md")).toBe(true);
    expect(server.puts).toHaveLength(0);
    // The folder flipped to an error state carrying a reason.
    const err = states.find((s) => s.state === "error");
    expect(err && err.state === "error" && err.reason).toMatch(/moved|deleted/);
  });

  it("never recreates the root or .treehouse while lost (no pull into a dead root)", async () => {
    const server = new FakeServer();
    const root = tmp();
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      watchFactory: idleWatchFactory,
      reconcileIntervalMs: 1_000_000,
    });
    await engine.start();

    rmSync(root, { recursive: true, force: true }); // folder trashed
    server.seed("c.md", "C"); // a remote create waits — must NOT be pulled into a dead path
    await engine.pollOnce();
    await engine.stop();

    expect(existsSync(root)).toBe(false); // the engine created nothing under the lost path
  });

  it("re-attaches when the marker reappears and resumes without re-uploading unchanged files", async () => {
    const server = new FakeServer();
    const root = tmp();
    writeFileSync(join(root, "a.md"), "A");
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      watchFactory: idleWatchFactory,
      reconcileIntervalMs: 1_000_000,
    });
    await engine.start(); // bootstrap pushes a.md
    expect(server.files.has("a.md")).toBe(true);
    server.puts = [];

    // Move away: the marker is gone (the files follow it in a real move).
    rmSync(join(root, ".treehouse", "config.json"), { force: true });
    await engine.pollOnce(); // detects lost — does nothing
    expect(server.puts).toHaveLength(0);

    // An empty directory reappears at the path but WITHOUT the marker — this must
    // NOT count as a re-attach.
    await engine.pollOnce();
    expect(server.puts).toHaveLength(0);

    // Marker restored (folder moved back): the on-disk index came with it, so the
    // unchanged a.md reconciles to a no-op — no re-upload.
    writeFileSync(join(root, ".treehouse", "config.json"), JSON.stringify(cfg));
    await engine.pollOnce(); // recovery reconcile
    await engine.stop();
    expect(server.puts).toHaveLength(0);
  });

  it("reports `unreadable` (permission denied) distinctly from a missing root", async () => {
    const server = new FakeServer();
    const root = tmp();
    const states: EngineState[] = [];
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      watchFactory: idleWatchFactory,
      reconcileIntervalMs: 1_000_000,
      onState: (s) => states.push(s),
    });
    await engine.start();

    const treehouse = join(root, ".treehouse");
    try {
      chmodSync(treehouse, 0o000); // deny access to the marker → EACCES on stat
      await engine.pollOnce();
    } finally {
      chmodSync(treehouse, 0o755);
    }
    await engine.stop();

    const err = states.find((s) => s.state === "error");
    expect(err && err.state === "error" && err.reason).toMatch(/unreadable|permission/);
  });

  it("on restart (cursor present) reconciles immediately, uploading pre-existing local files", async () => {
    const server = new FakeServer();
    const root = tmp();
    // A file already on disk before the daemon starts, plus a saved cursor so
    // start() skips bootstrap (the restart path) and the idle watcher never
    // fires for it. Without the immediate reconcile this would wait for the
    // (here, effectively disabled) periodic timer.
    writeFileSync(join(root, "pre-existing.md"), "LOCAL");
    saveCursor(root, 0);

    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      watchFactory: idleWatchFactory,
      reconcileIntervalMs: 1_000_000, // the upload must come from the on-start reconcile
    });

    await engine.start();
    // The reconcile is fire-and-forget; wait generously so the assertion isn't
    // flaky under parallel test load (the in-memory reconcile itself is fast).
    for (let i = 0; i < 500 && !server.files.has("pre-existing.md"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await engine.stop();

    expect(server.files.has("pre-existing.md")).toBe(true);
  });
});
describe("oversized-file reporting in watch mode (U2)", () => {
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
    "reports a file skipped by a full pass, once per process, not silently",
    withSmallCap(async () => {
      const server = new FakeServer();
      const root = tmp();
      writeFileSync(join(root, "big.md"), "0123456789"); // 10 bytes > 8
      const logs: string[] = [];
      const engine = createEngine(root, cfg, { api: server.asApi(), log: (m) => logs.push(m) });

      await engine.bootstrap();

      expect(server.files.has("big.md")).toBe(false); // never pushed
      expect(logs.filter((l) => l.includes("big.md"))).toHaveLength(1);
      expect(logs.find((l) => l.includes("big.md"))).toContain("skipped");

      // A later full pass (periodic reconcile / access regain) shares the
      // engine's warned-set, so the same file isn't re-reported every 5 minutes.
      logs.length = 0;
      await engine.bootstrap();
      expect(logs.filter((l) => l.includes("big.md"))).toEqual([]);
    }),
  );
});

describe("engine live status reporting (U2)", () => {
  it("reports auth-lost (terminal) on a 401/403, not endless syncing", async () => {
    const server = new FakeServer();
    server.seed("a.md", "A");
    const root = tmp();
    const states: EngineState[] = [];
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      onState: (s) => states.push(s),
    });
    await engine.bootstrap();

    server.failChangesWith = new AuthError("changes failed", 403);
    await expect(engine.pollOnce()).rejects.toBeInstanceOf(AuthError);

    const auth = states.find((s) => s.state === "auth-lost");
    expect(auth).toBeDefined();
    expect(auth && auth.state === "auth-lost" && auth.reason).toMatch(/sign-in|revoked|expired/);
  });

  it("reports auth-lost when the key is revoked mid-TRANSFER, not just on the feed", async () => {
    const server = new FakeServer();
    const root = tmp();
    const states: EngineState[] = [];
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      onState: (s) => states.push(s),
    });
    await engine.bootstrap();
    await engine.pollOnce(); // synced

    // The key is revoked after `changes()` has already returned this window, so
    // the 403 lands on the pull itself. Reported as a per-path failure only, the
    // drain would close with `synced` and the daemon would look healthy while
    // every transfer 403s.
    server.seed("c.md", "C");
    server.failTransfersWith = new AuthError("get c.md failed", 403);
    await expect(engine.pollOnce()).rejects.toBeInstanceOf(AuthError);

    expect(states.at(-1)).toEqual({
      state: "auth-lost",
      reason: "sign-in required — the workspace key was revoked or expired",
    });
    // Crucially it did NOT settle back to `synced` after the failed drain.
    expect(states.at(-1)?.state).not.toBe("synced");
  });

  it("shows a transient error on a network drop and returns to synced on recovery (AE4)", async () => {
    const server = new FakeServer();
    server.seed("a.md", "A");
    const root = tmp();
    const states: EngineState[] = [];
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      onState: (s) => states.push(s),
    });
    await engine.bootstrap();
    await engine.pollOnce(); // caught up → synced
    expect(states.at(-1)).toEqual({ state: "synced" });

    // Network drops: the poll fails, folder leaves `synced` for a transient error.
    server.failChangesWith = new Error("network down");
    await expect(engine.pollOnce()).rejects.toThrow(/network/);
    expect(states.some((s) => s.state === "error")).toBe(true);
    // The error is NOT auth-lost — a transient failure must not read as terminal.
    expect(states.some((s) => s.state === "auth-lost")).toBe(false);

    // Connectivity returns with no user action → back to synced.
    server.failChangesWith = undefined;
    await engine.pollOnce();
    expect(states.at(-1)).toEqual({ state: "synced" });
  });

  it("reports transferring during an active pull, then settles to synced", async () => {
    const server = new FakeServer();
    const root = tmp();
    const states: EngineState[] = [];
    const engine = createEngine(root, cfg, {
      api: server.asApi(),
      onState: (s) => states.push(s),
    });
    await engine.bootstrap();
    await engine.pollOnce(); // synced (nothing to do)

    server.seed("c.md", "C"); // a remote create the next poll must transfer
    await engine.pollOnce();

    const seq = states.map((s) => s.state);
    expect(seq).toContain("transferring");
    expect(seq.at(-1)).toBe("synced");
    expect(readFileSync(join(root, "c.md"), "utf8")).toBe("C");
  });
});
// The supervisor claims a root before `engine.start()` resolves (see startDir in
// daemon.ts), because start() is a long bootstrap and a `reload` landing inside
// it used to bring up a second engine on the same folder. This is the engine's
// half of that contract: a stop() arriving mid-bootstrap must leave nothing
// running, or the "replaced" engine keeps watching the folder alongside its
// replacement — two writers answering one filesystem event.
describe("stop() during a slow start()", () => {
  it("brings nothing up after the bootstrap it interrupted", async () => {
    const root = tmp();
    const server = new FakeServer();
    writeFileSync(join(root, "a.md"), "local");

    let releaseBootstrap: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      releaseBootstrap = r;
    });
    const slow = Object.create(server) as FakeServer & { list: () => Promise<unknown> };
    slow.list = async () => {
      await blocked;
      return server.list();
    };

    const watchers: IdleWatcher[] = [];
    const engine = createEngine(root, cfg, {
      api: slow as unknown as ApiClient,
      pollIntervalMs: 5,
      watchFactory: () => {
        const w = new IdleWatcher();
        watchers.push(w);
        setImmediate(() => w.emit("ready"));
        return w as unknown as FSWatcher;
      },
    });

    const starting = engine.start();
    await engine.stop(); // the supervisor tearing this folder down mid-bootstrap
    releaseBootstrap();
    await starting;

    // No watcher was ever wired up, so no filesystem event can reach this
    // engine — it is not a second writer on the folder.
    expect(watchers).toHaveLength(0);
    // And no poll loop is running: give it several intervals and the feed is
    // still untouched by this engine.
    const before = server.pollCount;
    await new Promise((r) => setTimeout(r, 40));
    expect(server.pollCount).toBe(before);
  });
});