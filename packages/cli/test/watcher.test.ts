import { EventEmitter } from "node:events";
import type { FSWatcher } from "chokidar";
import { describe, expect, it } from "vite-plus/test";
import { ignored } from "../src/sync-core";
import { isWatchLimitError, startWatcher, type WatchEvent } from "../src/watcher";

// Deterministic tests: inject a fake chokidar watcher (an EventEmitter) instead
// of touching the real filesystem, so event-mapping and the ENOSPC→polling
// degrade are verified without timing flakes. The ignore-filtering logic is the
// shared `ignored` predicate, tested directly.

class FakeWatcher extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

function harness(onDegrade?: (r: string) => void) {
  const events: WatchEvent[] = [];
  const created: { fake: FakeWatcher; usePolling: boolean }[] = [];
  const watcher = startWatcher({
    root: "/work",
    onEvent: (e) => events.push(e),
    onDegrade,
    watchFactory: (_root, o) => {
      const fake = new FakeWatcher();
      created.push({ fake, usePolling: o.usePolling });
      return fake as unknown as FSWatcher;
    },
  });
  return { events, created, watcher, latest: () => created[created.length - 1]!.fake };
}

describe("startWatcher", () => {
  it("maps add/change/unlink to workspace-relative POSIX paths", async () => {
    const h = harness();
    h.latest().emit("ready");
    await h.watcher.ready;

    h.latest().emit("add", "/work/sub/b.md");
    h.latest().emit("change", "/work/sub/b.md");
    h.latest().emit("unlink", "/work/sub/b.md");

    expect(h.events).toEqual([
      { kind: "add", path: "sub/b.md" },
      { kind: "change", path: "sub/b.md" },
      { kind: "unlink", path: "sub/b.md" },
    ]);
  });

  it("degrades to polling on ENOSPC and re-creates the watcher", async () => {
    let reason = "";
    const h = harness((r) => {
      reason = r;
    });
    expect(h.created[0]?.usePolling).toBe(false); // started in native mode

    h.latest().emit("error", Object.assign(new Error("inotify"), { code: "ENOSPC" }));
    await new Promise((r) => setTimeout(r, 10)); // let close().then() re-create

    expect(reason).toBe("ENOSPC");
    expect(h.watcher.degraded()).toBe(true);
    expect(h.created[0]?.fake.closed).toBe(true); // old watcher closed
    expect(h.created[1]?.usePolling).toBe(true); // re-created in polling mode
  });

  it("ignore predicate matches .treehouse + editor temp files, not normal paths", () => {
    expect(ignored(".treehouse/cursor.json")).toBe(true);
    expect(ignored(".DS_Store")).toBe(true);
    expect(ignored("sub/draft.md.swp")).toBe(true);
    expect(ignored("sub/notes.md")).toBe(false);
  });

  it("classifies inotify watch-limit errors", () => {
    expect(isWatchLimitError({ code: "ENOSPC" })).toBe(true);
    expect(isWatchLimitError({ code: "EMFILE" })).toBe(true);
    expect(isWatchLimitError({ code: "EACCES" })).toBe(false);
    expect(isWatchLimitError(new Error("boom"))).toBe(false);
    expect(isWatchLimitError(undefined)).toBe(false);
  });
});