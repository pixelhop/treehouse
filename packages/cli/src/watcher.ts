import { relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { ignored } from "./sync-core";

// Filesystem-event source for one workspace root, behind a small seam so the
// backend is swappable (chokidar v4 today; @parcel/watcher later if needed).
// The watcher is only a LATENCY optimization for local->cloud — the change-feed
// poller and the periodic full reconcile are the correctness mechanisms — so a
// watch-limit failure (Linux inotify ENOSPC) degrades to polling instead of
// crashing.

export type WatchEventKind = "add" | "change" | "unlink";
export interface WatchEvent {
  kind: WatchEventKind;
  /** Workspace-relative POSIX path. */
  path: string;
}

export interface Watcher {
  /** Resolves once the initial scan is complete and events are flowing. */
  ready: Promise<void>;
  /** True once degraded to polling (e.g. after inotify ENOSPC/EMFILE). */
  degraded(): boolean;
  close(): Promise<void>;
}

export interface WatcherOptions {
  root: string;
  onEvent: (e: WatchEvent) => void;
  /** Called once if the watcher degrades to polling. */
  onDegrade?: (reason: string) => void;
  /** Start in polling mode (deterministic under CPU contention; used by tests). */
  usePolling?: boolean;
  /** Test seam: inject the chokidar watch factory (so the backend can be faked). */
  watchFactory?: (root: string, opts: { usePolling: boolean }) => FSWatcher;
}

/** Linux inotify watch-count / fd exhaustion — the trigger for polling fallback. */
export function isWatchLimitError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EMFILE";
}

export function startWatcher(opts: WatcherOptions): Watcher {
  const { root, onEvent, onDegrade } = opts;
  let degraded = false;
  let current: FSWatcher;

  const toRel = (abs: string): string => relative(root, abs).split(sep).join("/");
  const make = opts.watchFactory ?? ((r, o) => watch(r, o));

  const options = (usePolling: boolean) => ({
    ignoreInitial: true, // the engine bootstraps explicitly; don't replay the tree
    atomic: true, // collapse editor tmp+rename into one event
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    // Reuse the sync IGNORE set; never prune the root itself (toRel(root) === "").
    ignored: (p: string) => {
      const rel = toRel(p);
      return rel !== "" && ignored(rel);
    },
    usePolling,
  });

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const wire = (w: FSWatcher): FSWatcher => {
    w.on("add", (p) => onEvent({ kind: "add", path: toRel(p) }));
    w.on("change", (p) => onEvent({ kind: "change", path: toRel(p) }));
    w.on("unlink", (p) => onEvent({ kind: "unlink", path: toRel(p) }));
    w.on("ready", resolveReady);
    w.on("error", (err: unknown) => {
      if (degraded || !isWatchLimitError(err)) return;
      degraded = true;
      onDegrade?.((err as NodeJS.ErrnoException).code ?? "watch-limit");
      // Re-create in polling mode; inotify watch counts no longer apply.
      void current.close().then(() => {
        current = wire(make(root, options(true)));
      });
    });
    return w;
  };

  current = wire(make(root, options(opts.usePolling ?? false)));

  return {
    ready,
    degraded: () => degraded,
    close: () => current.close(),
  };
}