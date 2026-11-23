import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IndexEntry } from "./reconcile";

// The local sync index — the "third state" that lets us tell a local edit apart
// from a remote change. Persisted as JSON at <root>/.treehouse/index.json.
//
// The baseline is bound to the workspace it was built against. A baseline only
// makes sense relative to one workspace's version history: if a folder is later
// pointed at a different workspace, the old baseline would make every local file
// look "deleted on the server" and the engine would delete the user's files. So
// on load we discard a baseline whose stamped workspaceId doesn't match the
// folder's current config — the files become fresh uploads, never deletes.
export type IndexMap = Record<string, IndexEntry>;

interface IndexFile {
  workspaceId?: string;
  entries: IndexMap;
}

function indexPath(root: string): string {
  return join(root, ".treehouse", "index.json");
}

/**
 * Load the baseline for `root`. When `workspaceId` is given and the stored
 * baseline was built against a different workspace, the baseline is discarded
 * (returns `{}`) so the folder re-syncs from scratch instead of deleting files.
 * Legacy flat-map files (no workspace stamp) are adopted as-is and re-stamped on
 * the next save.
 */
export function loadIndex(root: string, workspaceId?: string): IndexMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath(root), "utf8"));
  } catch {
    return {};
  }
  if (parsed && typeof parsed === "object" && "entries" in parsed) {
    const file = parsed as IndexFile;
    if (workspaceId && file.workspaceId && file.workspaceId !== workspaceId) {
      return {}; // baseline belongs to another workspace — don't trust it
    }
    return file.entries ?? {};
  }
  // Legacy format: a flat { path: IndexEntry } map with no workspace stamp.
  return (parsed as IndexMap) ?? {};
}

export function saveIndex(root: string, index: IndexMap, workspaceId?: string): void {
  const path = indexPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const file: IndexFile = { workspaceId, entries: index };
  // Atomic write: a crash mid-write must not corrupt/truncate the baseline.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}