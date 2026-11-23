// Sidebar file-tree UI state: which folders are expanded (persisted per
// workspace) and the current filter query. Shared via useState so the deeply
// recursive FileTree can read/toggle it without prop-drilling.
//
// Deliberately does NOT call useWorkspaceData(), for two independent reasons.
// Performance: that composable is unmemoised and builds four query observers plus
// a session subscription per call, and this one runs in every recursive FileTree
// instance (once per rendered folder). Correctness: it issues AUTHENTICATED
// queries, and the public share viewer renders this same tree with no session to
// issue them with. Reading the republished ACTIVE_WS_KEY state satisfies both —
// see useWorkspaceData.ts.
const EXPANDED_KEY = "th:tree-expanded";

/**
/**
 * Persisted expansion state, as `{ [scope]: { [folderPath]: true } }`.
 *
 * A keyed record rather than the array this used to be, because the shape
 * determines how much re-renders. Vue tracks reactive objects per key, so
 * setting or deleting one folder's key notifies only the rows that read that
 * folder. The previous shape derived a `new Set()` from the whole store on every
 * access and `commit()` replaced `store.value` wholesale, so expanding one
 * folder invalidated every row in the tree — ~540 Sets rebuilt and ~2,400 rows
 * re-rendered per chevron click, and `reveal()` made every file-open pay it too.
 */
export type ExpandedStore = Record<string, Record<string, true>>;

/**
 * Coerce whatever was persisted into the current shape, migrating the legacy
 * `string[]` buckets this used to write.
 *
 * Existing browsers hold arrays under this key. Indexing an array by a path
 * yields undefined (a silent one-time collapse of every folder), and assigning a
 * string key onto an Array produces a property `JSON.stringify` drops — so
 * expansion would quietly stop persisting until the bucket happened to be
 * replaced wholesale. Migrating on read avoids both.
 *
 * Pure and exported so the migration is unit-testable without a Nuxt runtime.
 */
export function normalizeExpanded(raw: unknown): ExpandedStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ExpandedStore = {};
  for (const [id, bucket] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(bucket)) {
      out[id] = Object.fromEntries(
        bucket.filter((p): p is string => typeof p === "string").map((p) => [p, true as const]),
      );
    } else if (bucket && typeof bucket === "object") {
      // Keep only truthy entries — a persisted `false` means "not expanded".
      out[id] = Object.fromEntries(
        Object.entries(bucket as Record<string, unknown>)
          .filter(([, v]) => v === true)
          .map(([k]) => [k, true as const]),
      );
    }
  }
  return out;
}

/** Read persisted expansion state from localStorage, migrating older shapes. */
function loadExpanded(): ExpandedStore {
  if (!import.meta.client) return {};
  try {
    return normalizeExpanded(JSON.parse(localStorage.getItem(EXPANDED_KEY) || "{}"));
  } catch {
    return {}; // corrupt storage — start clean rather than throwing on every render
  }
}

/**
 * `scope` names the tree whose expanded folders are being tracked. It defaults to
 * the open workspace; the public share viewer passes its share token instead.
 */
export type DropMode = "before" | "after" | "into";

/**
 * Where a drag over a row would land, from how far down the row the pointer is
 * (0–1). Folder rows have three zones (before / into / after); files have two.
 * When the tree isn't in its custom order there is no "between" to drop into,
 * so a folder row is all "into".
 */
export function dropModeAt(isDir: boolean, y: number, reorderable: boolean): DropMode {
  if (isDir && (!reorderable || (y >= 0.25 && y <= 0.75))) return "into";
  if (isDir) return y < 0.25 ? "before" : "after";
  return y < 0.5 ? "before" : "after";
}

export function useFileTreeUi(scope?: Ref<string>) {
  // Read only when no explicit scope was given. Note this composable never calls
  // useWorkspaceData() in either mode — see the header comment.
  const activeWorkspaceId = useState<string | null>(ACTIVE_WS_KEY, () => null);

  const store = useState<ExpandedStore>(EXPANDED_KEY, loadExpanded);
  function persist() {
    if (import.meta.client) localStorage.setItem(EXPANDED_KEY, JSON.stringify(store.value));
  }

  const wsId = computed(() => (scope ? scope.value : (activeWorkspaceId.value ?? "")));

  /** This workspace's bucket, created on demand. */
  function bucket(): Record<string, true> {
    const existing = store.value[wsId.value];
    if (existing) return existing;
    const created: Record<string, true> = {};
    store.value[wsId.value] = created;
    return store.value[wsId.value] as Record<string, true>;
  }

  function isExpanded(path: string): boolean {
    return store.value[wsId.value]?.[path] === true;
  }
  /** Per-key mutation: only rows reading THIS path re-render. */
  function toggle(path: string) {
    const b = bucket();
    if (b[path]) delete b[path];
    else b[path] = true;
    persist();
  }
  // The bulk operations change every key anyway, so they replace the bucket
  // wholesale — there is nothing to gain from per-key mutation here.
  function replaceBucket(paths: Iterable<string>) {
    store.value[wsId.value] = Object.fromEntries([...paths].map((p) => [p, true as const]));
    persist();
  }
  function expandAll(folderPaths: string[]) {
    replaceBucket(folderPaths);
  }
  function collapseAll() {
    replaceBucket([]);
  }
  // Expand the ancestor folders of a path (to reveal the open file). When the
  // path is itself a folder (deep-linked directory), expand it too so its
  // contents show. No-op if already expanded, so navigation won't thrash storage.
  function reveal(path: string, isDir = false) {
    if (!path) return;
    const parts = path.split("/");
    const limit = isDir ? parts.length : parts.length - 1;
    const b = bucket();
    let added = false;
    for (let i = 1; i <= limit; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (ancestor && !b[ancestor]) {
        b[ancestor] = true;
        added = true;
      }
    }
    if (added) persist();
  }

  // --- search ---
  // `filterQuery` is what the input is bound to, so typing never lags.
  // `debouncedQuery` is what actually drives scoring and the tree/results
  // switch. The 50ms delay is imperceptible but keeps a one-character query on a
  // large workspace from scoring on every keystroke.
  //
  // The watcher that connects them lives in AppSidebar, NOT here: this composable
  // runs in every recursive FileTree instance, so registering a watch and a timer
  // here would create one per rendered folder — all racing to write the same
  // value, and all disposed mid-flight the moment the first keystroke swaps the
  // tree out for the result list. AppSidebar has exactly one instance.
  const filterQuery = useState<string>("th:tree-filter", () => "");
  const debouncedQuery = useState<string>("th:tree-filter-debounced", () => "");
  // Derived from the DEBOUNCED value so that "is search active" and "what is
  // shown" can never disagree for 50ms — driving this from filterQuery would
  // swap the tree out on the first keystroke and then show nothing until the
  // debounce landed, which reads as a flicker.
  const isFiltering = computed(() => debouncedQuery.value.trim().length > 0);

  // --- locate ---
  // A one-shot request, from outside the tree (the breadcrumb's last crumb, the
  // tree menu), to show a node in the tree: AppSidebar consumes it, scrolls the
  // row into view, pulses it once, and clears it. Held as state rather than
  // fired as an event because the requester may first have to open a closed
  // sidebar, and the tree only mounts after that — a mounting AppSidebar picks
  // up a request that is still waiting.
  const locateRequest = useState<{ path: string } | null>("th:tree-locate", () => null);
  function locate(path: string) {
    // Search replaces the tree, so the row would have nowhere to show.
    filterQuery.value = "";
    debouncedQuery.value = "";
    // Ancestors only: locating a folder shows where it is, it doesn't open it.
    reveal(path);
    // A fresh object every time, so locating the same row twice still fires.
    locateRequest.value = { path };
  }

  // --- new-file draft ---
  // Which folder is showing an inline "new file" row ("" = the workspace root),
  // or null for none. Shared state so the row can be started from a folder's own
  // action button, from the sidebar's New file button, or from anywhere else,
  // and only ever one row is open at a time. Stamped with the workspace it was
  // started in so switching workspaces mid-draft drops it rather than reopening
  // the row against a same-named folder in the new workspace.
  const draft = useState<{ wsId: string; parent: string } | null>("th:tree-draft", () => null);
  const draftParent = computed(() =>
    draft.value && draft.value.wsId === wsId.value ? draft.value.parent : null,
  );
  function startDraft(parent: string) {
    // Search replaces the tree entirely, so the row would have nowhere to appear
    // — creating is not searching, so clear both halves of the query.
    filterQuery.value = "";
    debouncedQuery.value = "";
    // Reveal the folder so the row is actually visible where it will land.
    if (parent) reveal(parent, true);
    draft.value = { wsId: wsId.value, parent };
  }
  function cancelDraft() {
    draft.value = null;
  }

  // --- drag state (shared, so a drag started in one folder's list can be
  // dropped into another) ---
  const drag = useState<{ path: string; isDir: boolean; parent: string } | null>(
    "th:tree-drag",
    () => null,
  );
  const dropTarget = useState<{ path: string; mode: DropMode } | null>("th:tree-drop", () => null);

  function parentOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i === -1 ? "" : path.slice(0, i);
  }
  function startDrag(node: { path: string; isDir: boolean }) {
    drag.value = { path: node.path, isDir: node.isDir, parent: parentOf(node.path) };
  }
  function endDrag() {
    drag.value = null;
    dropTarget.value = null;
  }
  // Whether the active drag can land on `node` with `mode`. Without
  // `reorderable` (the tree is sorted by name or date) a drop between two rows
  // of the drag's own folder would only reorder, and there's no order to write.
  function canDrop(
    node: { path: string; isDir: boolean },
    mode: DropMode,
    reorderable = true,
  ): boolean {
    const d = drag.value;
    if (!d) return false;
    if (node.path === d.path) return false; // onto itself
    const destParent = mode === "into" ? node.path : parentOf(node.path);
    if (!reorderable && destParent === d.parent) return false;
    // A folder can't move into itself or its own descendants.
    if (d.isDir && (destParent === d.path || destParent.startsWith(`${d.path}/`))) return false;
    return true;
  }
  function setDrop(node: { path: string; isDir: boolean }, mode: DropMode, reorderable = true) {
    if (canDrop(node, mode, reorderable)) dropTarget.value = { path: node.path, mode };
    else dropTarget.value = null;
  }

  return {
    isExpanded,
    toggle,
    expandAll,
    collapseAll,
    reveal,
    filterQuery,
    debouncedQuery,
    isFiltering,
    locateRequest,
    locate,
    draftParent,
    startDraft,
    cancelDraft,
    drag,
    dropTarget,
    parentOf,
    startDrag,
    endDrag,
    canDrop,
    setDrop,
  };
}