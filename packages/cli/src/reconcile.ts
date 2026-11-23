// Pure two-way reconcile core. Given the three states for a path — local
// (on disk), remote (cloud version), and index (last-synced baseline) — decide
// the single action to take. Keeping this pure makes the dangerous logic
// (especially deletes) unit-testable without any IO.
//
// The guiding rule, mirrored from the server: an edit always beats a stale
// delete (resurrection over loss); deletes propagate only when the other side
// didn't touch the file.

export interface LocalState {
  hash: string;
}
export interface RemoteState {
  version: number;
}
export interface IndexEntry {
  version: number;
  hash: string;
  // Optional fast-path metadata: when a file's mtime+size are unchanged from the
  // last sync, scanLocal reuses `hash` instead of re-reading and re-hashing.
  mtime?: number;
  size?: number;
}

export type Action =
  | { type: "noop" }
  | { type: "pull" } // download remote -> local, update index
  // Upload a new local file (If-None-Match: *); on 412 pull conflicted copy.
  // `onRemote`: the server already has this path too, so this is not really new.
  | { type: "create"; onRemote?: true }
  | { type: "push"; baseVersion: number } // update remote (If-Match); on 412 pull conflicted copy
  | { type: "pushDelete"; baseVersion: number } // delete remote (If-Match)
  | { type: "deleteLocal" } // remove local file, drop index
  | { type: "accessLost" } // server revoked our access: drop local + index, never re-push
  | { type: "dropIndex" }; // both gone; forget the path

// `accessLost` is NOT produced by reconcile() — it is driven externally by an
// `access_revoked` change-feed event (the owner made the node private). Unlike
// `deleteLocal` it must fire even when the file has unpushed local edits: the
// member has lost access, so the edit can't be pushed and the local copy must
// go. That is why it bypasses the resurrection-over-loss rule below.

export function reconcile(
  local: LocalState | undefined,
  remote: RemoteState | undefined,
  index: IndexEntry | undefined,
): Action {
  const localExists = local !== undefined;
  const remoteExists = remote !== undefined;

  // No baseline: the path is new to sync on one or both sides.
  if (!index) {
    if (localExists && remoteExists) return { type: "create", onRemote: true }; // both-new same path -> server arbitrates (412 -> pull copy)
    if (localExists) return { type: "create" };
    if (remoteExists) return { type: "pull" };
    return { type: "noop" };
  }

  const localChanged = localExists && local.hash !== index.hash;
  const remoteChanged = remoteExists && remote.version !== index.version;
  const localDeleted = !localExists;
  const remoteDeleted = !remoteExists;

  // Both sides deleted -> converge.
  if (localDeleted && remoteDeleted) return { type: "dropIndex" };

  // Delete vs edit -> the edit wins (resurrection over loss).
  if (localDeleted && remoteChanged) return { type: "pull" };
  if (remoteDeleted && localChanged) return { type: "create" };

  // Delete vs untouched -> propagate the delete.
  if (localDeleted) return { type: "pushDelete", baseVersion: index.version };
  if (remoteDeleted) return { type: "deleteLocal" };

  // Edits.
  if (localChanged && remoteChanged) return { type: "push", baseVersion: index.version }; // -> 412 -> pull conflicted copy
  if (localChanged) return { type: "push", baseVersion: index.version };
  if (remoteChanged) return { type: "pull" };

  return { type: "noop" };
}