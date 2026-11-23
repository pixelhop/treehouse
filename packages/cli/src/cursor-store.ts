import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The incremental sync cursor: the `seq` of the last change-feed event applied to
// this directory. Persisted at <root>/.treehouse/cursor.json. Absent or corrupt
// reads as `undefined`, which the engine treats as "no cursor — bootstrap from
// scratch" (a full reconcile, then set the cursor to head).

function cursorPath(root: string): string {
  return join(root, ".treehouse", "cursor.json");
}

/** Last applied seq, or undefined when absent/corrupt/invalid (→ bootstrap). */
export function loadCursor(root: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(root), "utf8")) as { seq?: unknown };
    const seq = parsed.seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : undefined;
  } catch {
    return undefined;
  }
}

export function saveCursor(root: string, seq: number): void {
  const path = cursorPath(root);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: a crash mid-write must not leave a truncated/garbage cursor
  // (which would otherwise wrongly suppress a bootstrap). Same pattern as
  // index-store.ts.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ seq }));
  renameSync(tmp, path);
}