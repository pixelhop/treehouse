import type { RestoreMode } from "~/utils/recovery";
import { ACTIVE_WS_KEY } from "~/utils/workspaceState";

// What the "Restore to an earlier time" dialog is open for: a folder (or null,
// the whole workspace), or one API key's changes to undo; undefined when it's
// closed. Shared so the file tree, the sidebar, the API keys list and the
// activity feed can all open the one dialog the app layout mounts. `at`
// pre-fills the moment, exactly (to the millisecond), when the caller knows it,
// as "restore to before this" does.
//
// The workspace is captured when it opens: the dialog outlives navigation, and
// a preview taken in one workspace must never be applied to another.
export function useRestoreTo() {
  const mode = useState<RestoreMode | undefined>("restore-to-mode", () => undefined);
  const presetAt = useState<string | null>("restore-to-at", () => null);
  const workspaceId = useState<string | null>("restore-to-workspace", () => null);
  // The republished current workspace, not useWorkspaceData(): this is called
  // from every file-tree row, and that composable is heavy (see the note there).
  const activeWorkspaceId = useState<string | null>(ACTIVE_WS_KEY, () => null);
  function start(next: RestoreMode, at?: Date) {
    workspaceId.value = activeWorkspaceId.value;
    presetAt.value = at ? at.toISOString() : null;
    mode.value = next;
  }
  return {
    mode,
    presetAt,
    workspaceId,
    open: (path: string | null, at?: Date) => start({ kind: "restore", path }, at),
    openUndo: (keyId: string, label: string, at?: Date) =>
      start({ kind: "undo", keyId, label }, at),
    close: () => {
      mode.value = undefined;
      presetAt.value = null;
      workspaceId.value = null;
    },
  };
}