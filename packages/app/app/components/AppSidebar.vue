<script setup lang="ts">
import IconDashboard from "~icons/solar/chart-2-bold-duotone";
import IconKey from "~icons/solar/key-bold-duotone";
import IconMembers from "~icons/solar/users-group-rounded-bold-duotone";
import IconPalette from "~icons/solar/palette-bold-duotone";
import IconCollapse from "~icons/solar/minimize-square-minimalistic-linear";
import IconExpand from "~icons/solar/maximize-square-minimalistic-linear";
import IconLocate from "~icons/solar/gps-linear";
import IconSearch from "~icons/solar/magnifer-linear";
import IconMore from "~icons/solar/menu-dots-bold";
import IconAdd from "~icons/solar/add-linear";
import IconHistory from "~icons/solar/history-2-linear";
import IconTrash from "~icons/solar/trash-bin-minimalistic-linear";
import IconTabs from "~icons/solar/window-frame-linear";
import { openIntent } from "~/utils/tabs";
import IconSignOut from "~icons/solar/logout-2-bold-duotone";
import IconBoard from "~icons/solar/clipboard-list-linear";
import { Icon } from "@iconify/vue";
import { useQuery } from "@tanstack/vue-query";
import { isSafeRelPath, searchPaths, type SearchItem } from "shared";
import { isTagQuery, tagSearch, tagSearchEmptyText } from "~/utils/tagSearch";
import { newBoardReadme } from "~/utils/board";
import { withDefaultExtension } from "~/utils/newFile";
import IconCheck from "~icons/solar/check-linear";
import {
  collectFolderPaths,
  isHiddenPath,
  sortTreeBy,
  TREE_SORT_LABELS,
  TREE_SORTS,
  visibleNodes,
} from "~/utils/treehouse";
import type { TreeNode } from "~/utils/treehouse";

const ws = useWorkspaceData();
const api = useTreehouseApi();
const treeUi = useFileTreeUi();
const tabs = useWorkspaceTabs();
const tabsFlag = useTabsEnabled();
// A search result clicked with ⌘/Ctrl or the middle button opens in a tab and
// leaves the results up, so several can be opened from one search.
function onResultSelect(node: { path: string; isDir: boolean }, e?: MouseEvent) {
  if (e && tabs.openPath(node.path, openIntent(e))) return;
  openResult(node);
}
const authClient = useAuthClient();
const session = authClient.useSession();
const restoreTo = useRestoreTo();
const sb = useSidebar();

// On a compact screen the sidebar overlays the document, so using it has to
// dismiss it — otherwise every navigation leaves you looking at the tree you
// just finished with instead of the file you asked for.
function selectNode(node: { path: string; isDir: boolean }) {
  ws.select(node);
  if (!node.isDir) sb.close();
}
// The root has no path, so it can't go through selectNode. Like selecting a
// folder, this leaves the sidebar open on a compact screen — you selected a
// place to work, not a document to read.
function selectRoot() {
  ws.select(null);
}

// The node the tree asked to move, driving MoveNodeDialog. Lives here rather
// than in FileTree because the picker needs the WHOLE tree to list destinations,
// and a FileTree instance only knows its own level.
const movingNode = ref<{ path: string; isDir: boolean; name: string } | null>(null);
async function moveNode(args: { from: string; isDir: boolean; destParent: string }) {
  movingNode.value = null;
  try {
    await ws.moveNode(args);
    if (args.destParent) treeUi.reveal(args.destParent, true);
  } catch (err) {
    window.alert(`Couldn't move: ${(err as Error).message}`);
  }
}

const menuOpen = ref(false);
const keysOpen = ref(false);
const membersOpen = ref(false);
const themeOpen = ref(false);
const treeMenuOpen = ref(false);
const newMenuOpen = ref(false);
const dropZone = ref<{ openPicker: () => void } | null>(null);

// Your own view of the tree. "Custom" is the workspace's shared drag order;
// the others re-sort a copy, and switch off drag-to-reorder while they're on.
// Hidden (dot-named) files drop out of the tree AND search unless shown.
const { treeSort, setTreeSort, showHidden, setShowHidden } = useSortPrefs();
const visibleTree = computed(() => visibleNodes(ws.tree.value, showHidden.value));
const allFolders = computed(() => collectFolderPaths(visibleTree.value));
const sortedTree = computed(() => sortTreeBy(visibleTree.value, treeSort.value));

// --- search ---------------------------------------------------------------
// Typing shows a flat ranked list instead of the tree. See FileSearchResults
// for why a list rather than a pruned tree.

// Flattened once per file-list change, not per keystroke. Built from the tree
// rather than from `ws.entries` because entries are files only, and people
// expect to find folders too — the tree already carries synthesized folders and
// already hides `.keep` placeholders.
const flatNodes = computed<SearchItem[]>(() => {
  const out: SearchItem[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push({ path: n.path, name: n.name, isDir: n.isDir });
      if (n.isDir) walk(n.children);
    }
  };
  walk(visibleTree.value);
  return out;
});

// The input stays bound to `filterQuery` so typed characters never lag; only the
// value that drives scoring is debounced. Clearing is NOT debounced — dismissing
// search should feel instant, and an empty query does no work anyway.
// This watcher is registered here, in the sidebar's single instance, rather than
// in useFileTreeUi (which runs once per rendered folder).
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => treeUi.filterQuery.value,
  (q) => {
    clearTimeout(debounceTimer);
    if (!q.trim()) {
      treeUi.debouncedQuery.value = "";
      return;
    }
    debounceTimer = setTimeout(() => {
      treeUi.debouncedQuery.value = q;
    }, 50);
  },
  // Immediate: selecting a tag sets the query from outside, and on a phone (or
  // with the sidebar closed) this component only mounts afterwards.
  { immediate: true },
);
onScopeDispose(() => clearTimeout(debounceTimer));

// A query starting with `#` searches tags instead (see utils/tagSearch). Tags
// come from the server, the only place that has read every note, and only the
// notes this member may read. They're only fetched in tag mode, where they stay
// current by polling: quickly while older notes are still being indexed (each
// request indexes more), and otherwise at the activity feed's pace.
const tagMode = computed(() => isTagQuery(treeUi.filterQuery.value));
const tagsQuery = useQuery({
  queryKey: computed(() => ["tags", ws.workspaceId.value]),
  queryFn: () => api.tags(ws.workspaceId.value as string),
  enabled: computed(() => tagMode.value && !!ws.workspaceId.value),
  refetchInterval: (query) => (query.state.data?.complete === false ? 2_000 : 15_000),
});
// Tags come from the server, not the tree, so hidden notes are dropped here to
// keep tag search in line with "Show hidden files".
const tagList = computed(() => {
  const tags = tagsQuery.data.value?.tags ?? [];
  if (showHidden.value) return tags;
  return tags
    .map((t) => ({ ...t, paths: t.paths.filter((p) => !isHiddenPath(p)) }))
    .filter((t) => t.paths.length > 0);
});
const tagsIndexing = computed(() => tagsQuery.data.value?.complete === false);
const tagsNote = computed(() =>
  tagsIndexing.value ? "Still indexing older notes, so this list may grow." : undefined,
);

/** Results for a query: file names, or for `#…` the notes with matching tags. */
function runSearch(q: string) {
  return isTagQuery(q) ? tagSearch(q, tagList.value).outcome : searchPaths(q, flatNodes.value);
}

const search = computed(() => runSearch(treeUi.debouncedQuery.value));

/** What to say when a search finds nothing. */
const noResults = computed(() => {
  const q = treeUi.debouncedQuery.value.trim();
  if (!isTagQuery(q)) return `No files match “${q}”.`;
  return tagSearchEmptyText(q, {
    pending: tagsQuery.isPending.value,
    indexing: tagsIndexing.value,
    anyTags: tagList.value.length > 0,
  });
});
const matchedTags = computed(() =>
  isTagQuery(treeUi.debouncedQuery.value)
    ? tagSearch(treeUi.debouncedQuery.value, tagList.value).tags
    : [],
);
const results = computed(() => search.value.results);

// How well search works is a question we cannot answer from the outside, and
// "people search and get nothing" is exactly the kind of quiet failure that
// never gets reported. Watching the DEBOUNCED query means one event per search
// rather than one per keystroke.
//
// The query itself NEVER leaves the browser — someone searching their own files
// is searching their own file names. Only its length goes out, which is enough
// to tell "one-letter fumble" from "typed a real phrase and got nothing".
const analytics = useAnalytics();
watch(
  () => treeUi.debouncedQuery.value,
  (query) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    analytics.capture("search_performed", {
      query_length: trimmed.length,
      result_count: search.value.totalMatches,
    });
  },
);

// Reset to the best match (not "none") on every query change: typing and
// immediately pressing Enter is the common path, and an unset cursor makes that
// silently do nothing, which reads as broken rather than unhelpful.
const activeIndex = ref(0);
watch(results, () => {
  activeIndex.value = 0;
});

function moveActive(delta: number) {
  if (!results.value.length) return;
  const n = results.value.length;
  activeIndex.value = (activeIndex.value + delta + n) % n;
  nextTick(() => {
    document
      .getElementById(`th-search-result-${activeIndex.value}`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

function clearSearch() {
  treeUi.filterQuery.value = "";
  treeUi.debouncedQuery.value = "";
}

/**
 * Open a result and hand the user back to the tree.
 *
 * Result rows are navigate-only — no drag, rename, delete or create — so the
 * round-trip is what keeps that acceptable: selecting anything clears the query
 * and reveals the row in the tree, where every management action is one click
 * away. A folder additionally expands, since there is no chevron here to do it.
 */
function openResult(node: { path: string; isDir: boolean }) {
  clearSearch();
  // selectNode, not ws.select: on a compact screen the sidebar overlays the
  // document, so opening a file has to dismiss it or you end up looking at the
  // tree you just searched instead of the file you asked for.
  selectNode(node);
  treeUi.reveal(node.path, node.isDir);
}

/**
 * Open the highlighted result — acting on what is TYPED, not on whatever the
 * debounce has caught up to.
 *
 * `results` is derived from `debouncedQuery`, so pressing Enter inside the 50ms
 * window would otherwise use the previous query's list: a first query would do
 * nothing at all, and an edited query would open a result the user is no longer
 * looking at. Type-then-immediately-Enter is the most common way to use this, so
 * it has to be the case that works.
 */
function onSearchEnter() {
  const typed = treeUi.filterQuery.value;
  const settled = typed === treeUi.debouncedQuery.value;
  // Score the live query when the debounce has not landed yet. It is one extra
  // pass over an in-memory list, on a single keypress.
  const list = settled ? results.value : runSearch(typed).results;
  // A cursor position only means something for a list the user has actually
  // seen; if the query moved on, the best match is the only defensible target.
  const r = list[settled ? activeIndex.value : 0];
  if (r) openResult({ path: r.path, isDir: r.isDir });
}

// --- Showing the open file in the tree --------------------------------------
// Expanding the open file's folders is not enough on its own: in a long tree the
// row lands below the fold, and the tree still looks like you are nowhere. So
// every navigation also scrolls the row into view, and an explicit "locate"
// (the breadcrumb's last crumb, the tree menu) additionally pulses it.
const treeScroller = ref<HTMLElement | null>(null);

// The row still to be brought into view. The row may not exist yet — a deep
// link resolves before the tree loads, and expanded folders render their
// children on the next flush — so this waits until it does. Once found it is
// cleared, so a later tree refresh never drags the tree back after the user has
// scrolled away.
let pendingRow: { path: string; pulse: boolean } | null = null;

function scrollToPendingRow() {
  if (!pendingRow) return;
  void nextTick(() => {
    const want = pendingRow;
    const box = treeScroller.value;
    if (!want || !box) return;
    const row = box.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(want.path)}"]`);
    if (!row) return;
    pendingRow = null;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    // A row already in view stays put, so clicking around inside the tree never
    // makes it jump. Off-screen rows go to the middle rather than the nearest
    // edge, where they would sit half-hidden under the bottom fade.
    if (r.top < b.top || r.bottom > b.bottom) {
      row.scrollIntoView({ block: "center", behavior: want.pulse && !reduce ? "smooth" : "auto" });
    }
    if (want.pulse) {
      // Restart the animation if the row is already pulsing.
      row.classList.remove("th-locate");
      void row.offsetWidth;
      row.classList.add("th-locate");
      row.addEventListener("animationend", () => row.classList.remove("th-locate"), {
        once: true,
      });
    }
  });
}

// Reveal the open file's folders on load / navigation. Watch selectedFolder too
// so a deep-linked directory (resolved once the tree loads) expands itself.
watch(
  [() => ws.selectedPath.value, () => ws.selectedFolder.value],
  ([p, folder]) => {
    if (!p) return;
    treeUi.reveal(p, !!folder);
    pendingRow = { path: p, pulse: false };
    scrollToPendingRow();
  },
  { immediate: true },
);

// Registered after the navigation watcher, so a request waiting when the
// sidebar mounts wins over the plain scroll that mounting also queues.
watch(
  () => treeUi.locateRequest.value,
  (req) => {
    if (!req) return;
    treeUi.locateRequest.value = null;
    pendingRow = { path: req.path, pulse: true };
    scrollToPendingRow();
  },
  { immediate: true },
);

// Retry a row that wasn't rendered yet once the tree (or the search swap back
// to it) catches up.
watch([() => ws.tree.value, () => treeUi.isFiltering.value], scrollToPendingRow);

// Leaving a workspace discards its half-typed new-file row rather than parking
// it to reopen on return. (The draft is workspace-stamped too, so it can never
// show against another workspace's tree even for a frame.)
watch(
  () => ws.workspaceId.value,
  () => treeUi.cancelDraft(),
);

// --- Activity ---------------------------------------------------------------
// Workspace-scoped, so it belongs beside the tree rather than in the file top
// bar, where it sat among controls that all acted on the open document. The
// feed and the watermark ride the vue-query cache under stable keys, so this
// second reader shares the workspace surface's polling rather than doubling it.
const activityUi = useActivityUi();
const activityFeed = useActivityFeed(ws.workspaceId);
const { badge: activityBadge } = useActivityWatermark(ws.workspaceId, {
  events: activityFeed.events,
  head: activityFeed.head,
});
function openActivity() {
  // The glance drawer is rendered by the workspace surface. On a surface that
  // has no drawer to open (the full activity page, the dashboard) this goes to
  // the activity page instead of setting a flag nothing is listening to.
  if (activityUi.canGlance.value) {
    activityUi.open.value = true;
    // Compact: the sidebar overlays the document, and so does the drawer.
    if (sb.compact.value) sb.close();
    return;
  }
  const id = ws.workspaceId.value;
  if (id) void navigateTo(`/w/${id}/activity`);
}

const userName = computed(
  () => session.value.data?.user?.name || session.value.data?.user?.email || "Account",
);
const initial = computed(() => userName.value.charAt(0).toUpperCase());

/** The footer's icon buttons (activity, trash, what's new) share one shape. */
const FOOTER_ICON =
  "relative grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-subtle no-underline transition hover:bg-surface hover:text-fg";

async function signOut() {
  menuOpen.value = false;
  await authClient.signOut();
  // Open tabs can name private files; the next person to sign in here must not inherit them.
  tabs.forget();
  await navigateTo("/sign-in");
}

// New file/folder/upload are created relative to the selected folder (or the
// open file's folder, or the root). The root is reachable the same way every
// folder is — by selecting it in the tree — because the tree renders a row for
// it (see the root row below).
/**
 * The workspace is held read-only by billing — a lapsed subscription, or one
 * that was never started.
 *
 * Every write is refused by the server anyway; without this the buttons stay lit
 * and clicking one does nothing at all, which reads as a broken app rather than
 * as the state the banner at the top of the page is explaining.
 */
const billingReadOnly = computed(() => ws.usage.value?.billing.readOnly === true);

/** Why the write controls are off, on hover. The banner carries the full story. */
const readOnlyReason = "This workspace is read-only until its subscription is sorted out.";

/** Billing is a passing state, so its controls stay visible, greyed. A viewer's
 * isn't, so theirs are simply not offered (see the template). */
const writesOff = computed(() => billingReadOnly.value || ws.viewOnly.value);

// Nothing new can land in the folder that's open if it's view-only for this member.
const targetBlocked = computed(() => billingReadOnly.value || !ws.canWritePath(targetDir.value));
const targetBlockedReason = computed(() =>
  billingReadOnly.value ? readOnlyReason : "You have view-only access to this folder",
);

const targetDir = computed(() => {
  if (ws.selectedFolder.value) return ws.selectedFolder.value.path;
  const p = ws.selectedPath.value;
  return p && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
});
const atRoot = computed(() => !ws.selectedPath.value);
function joinDir(name: string): string {
  const d = targetDir.value;
  return d ? `${d}/${name}` : name;
}
// Create a file from the tree's inline new-file row. `parent` is the folder the
// row was opened in — the row itself is the naming UI, so there's no prompt.
async function createFile(args: { parent: string; name: string }) {
  const name = withDefaultExtension(args.name);
  if (!name) return;
  if (name.includes("/") || !isSafeRelPath(name)) return void window.alert("Invalid file name.");
  const path = args.parent ? `${args.parent}/${name}` : name;
  try {
    const res = await ws.createFile(path);
    if (res && !res.ok) window.alert("A file with that name already exists.");
  } catch (err) {
    window.alert(`Couldn't create file: ${(err as Error).message}`);
  }
}
// A new board: a folder whose README declares `view: board` with starter
// columns, opened straight onto the (empty) board. Nothing app-only — it's the
// same README an agent would write when asked to "make a board for X".
async function newBoard() {
  const name = window.prompt("New board name")?.trim();
  if (!name) return;
  if (!isSafeRelPath(name) || name.includes("/")) return void window.alert("Invalid board name.");
  const id = ws.workspaceId.value;
  if (!id) return;
  const path = joinDir(name);
  if (ws.entries.value.some((e) => e.path === path || e.path.startsWith(`${path}/`))) {
    return void window.alert("A folder with that name already exists.");
  }
  try {
    const res = await api.createFile(id, `${path}/README.md`, await newBoardReadme(name));
    if (!res.ok) return void window.alert("A folder with that name already exists.");
    treeUi.reveal(path, true);
    await ws.select({ path, isDir: true });
  } catch (err) {
    window.alert(`Couldn't create board: ${(err as Error).message}`);
  } finally {
    ws.refresh();
  }
}
async function newFolder() {
  const name = window.prompt("New folder name")?.trim();
  if (!name) return;
  if (!isSafeRelPath(name)) return void window.alert("Invalid folder name.");
  const path = joinDir(name);
  try {
    await ws.createFolder(path);
    treeUi.reveal(path, true);
  } catch (err) {
    window.alert(`Couldn't create folder: ${(err as Error).message}`);
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-surface-2">
    <WorkspaceSwitcher />

    <!-- Search, create, tree options: one row. Creating anything (file, folder,
         board, upload) sits behind the single "+" rather than a second row of
         labelled buttons, which crowded the top of the sidebar. The input and
         both buttons share one explicit height (h-9, lg:h-7.5) so they line up;
         change them together. -->
    <div v-if="ws.workspace.value" class="flex items-center gap-1 px-2 pt-1">
      <!-- An empty workspace has nothing to search; the tree says so. -->
      <div v-if="!ws.entries.value.length" class="flex-1" />
      <div v-else class="relative flex-1">
        <IconSearch
          class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
        />
        <input
          v-model="treeUi.filterQuery.value"
          type="search"
          placeholder="Search files or #tags…"
          role="combobox"
          aria-label="Search files"
          aria-controls="th-search-listbox"
          :aria-expanded="treeUi.isFiltering.value"
          :aria-activedescendant="
            treeUi.isFiltering.value && results.length
              ? `th-search-result-${activeIndex}`
              : undefined
          "
          class="h-9 w-full rounded-md border border-border bg-surface pr-2 pl-7 text-base text-fg outline-none transition focus:border-accent lg:h-7.5 lg:text-sm"
          @keydown.down.prevent="moveActive(1)"
          @keydown.up.prevent="moveActive(-1)"
          @keydown.enter.prevent="onSearchEnter()"
          @keydown.esc.prevent="clearSearch()"
        />
      </div>
      <!-- Screen readers get no signal from a list that silently repopulates as
           you type, so announce the count. -->
      <p class="sr-only" role="status" aria-live="polite">
        {{
          treeUi.isFiltering.value
            ? `${search.totalMatches} result${search.totalMatches === 1 ? "" : "s"}`
            : ""
        }}
      </p>
      <div v-if="!ws.viewOnly.value" class="relative shrink-0">
        <button
          type="button"
          :disabled="billingReadOnly"
          :title="billingReadOnly ? readOnlyReason : 'New file, folder or upload'"
          aria-haspopup="menu"
          :aria-expanded="newMenuOpen"
          class="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border text-fg-muted transition hover:bg-surface hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent lg:h-7.5 lg:w-7.5"
          :class="newMenuOpen ? 'bg-surface text-fg' : ''"
          @click="newMenuOpen = !newMenuOpen"
        >
          <IconAdd class="h-4 w-4" />
        </button>
        <!-- Items land in the selected folder (or the open file's folder, or
             the root) — see targetDir. -->
        <div
          v-if="newMenuOpen"
          role="menu"
          class="absolute top-full right-0 z-30 mt-1 w-48 rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            :disabled="targetBlocked"
            :title="targetBlocked ? targetBlockedReason : undefined"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            @click="
              newMenuOpen = false;
              treeUi.startDraft(targetDir);
            "
          >
            <Icon icon="solar:file-text-linear" class="h-4 w-4 text-fg-subtle" /> New file
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="targetBlocked"
            :title="targetBlocked ? targetBlockedReason : undefined"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            @click="
              newMenuOpen = false;
              newFolder();
            "
          >
            <Icon icon="solar:folder-with-files-linear" class="h-4 w-4 text-fg-subtle" /> New folder
          </button>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
            @click="
              newMenuOpen = false;
              newBoard();
            "
          >
            <IconBoard class="h-4 w-4 text-fg-subtle" /> New board
          </button>
          <div class="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            :disabled="targetBlocked"
            :title="targetBlocked ? targetBlockedReason : undefined"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            @click="
              newMenuOpen = false;
              dropZone?.openPicker();
            "
          >
            <Icon icon="solar:upload-minimalistic-linear" class="h-4 w-4 text-fg-subtle" />
            Upload files…
          </button>
        </div>
        <div v-if="newMenuOpen" class="fixed inset-0 z-20" @click="newMenuOpen = false" />
      </div>
      <div class="relative shrink-0">
        <button
          type="button"
          title="Tree options"
          class="grid h-9 w-9 place-items-center rounded-md text-fg-subtle transition hover:bg-surface-2 hover:text-fg lg:h-7.5 lg:w-7.5"
          :class="treeMenuOpen ? 'bg-surface-2 text-fg' : ''"
          @click="treeMenuOpen = !treeMenuOpen"
        >
          <IconMore class="h-4 w-4" />
        </button>
        <div
          v-if="treeMenuOpen"
          class="absolute top-full right-0 z-30 mt-1 w-48 rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          <button
            type="button"
            :disabled="!ws.selectedPath.value"
            :title="ws.selectedPath.value ? undefined : 'Open a file or folder first'"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            @click="
              treeMenuOpen = false;
              treeUi.locate(ws.selectedPath.value);
            "
          >
            <IconLocate class="h-4 w-4 text-fg-subtle" /> Reveal open file
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
            @click="
              treeUi.expandAll(allFolders);
              treeMenuOpen = false;
            "
          >
            <IconExpand class="h-4 w-4 text-fg-subtle" /> Expand all
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
            @click="
              treeUi.collapseAll();
              treeMenuOpen = false;
            "
          >
            <IconCollapse class="h-4 w-4 text-fg-subtle" /> Collapse all
          </button>
          <!-- Dot-named files (.claude, .obsidian) are tool config; off by
               default, and the folder listing follows the same choice. -->
          <button
            type="button"
            role="menuitemcheckbox"
            :aria-checked="showHidden"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
            @click="
              setShowHidden(!showHidden);
              treeMenuOpen = false;
            "
          >
            <IconCheck class="h-4 w-4" :class="showHidden ? 'text-accent' : 'text-transparent'" />
            Show hidden files
          </button>
          <div class="my-1 border-t border-border" />
          <p class="px-2 pt-1 pb-0.5 text-xs text-fg-subtle">Sort by</p>
          <button
            v-for="mode in TREE_SORTS"
            :key="mode"
            type="button"
            role="menuitemradio"
            :aria-checked="treeSort === mode"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
            @click="
              setTreeSort(mode);
              treeMenuOpen = false;
            "
          >
            <IconCheck
              class="h-4 w-4"
              :class="treeSort === mode ? 'text-accent' : 'text-transparent'"
            />
            {{ TREE_SORT_LABELS[mode] }}
          </button>
          <template v-if="!ws.viewOnly.value">
            <div class="my-1 border-t border-border" />
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
              @click="
                treeMenuOpen = false;
                restoreTo.open(null);
              "
            >
              <Icon icon="solar:history-linear" class="h-4 w-4 text-fg-subtle" /> Restore workspace…
            </button>
          </template>
        </div>
        <div v-if="treeMenuOpen" class="fixed inset-0 z-20" @click="treeMenuOpen = false" />
      </div>
    </div>

    <p v-if="ws.workspace.value && ws.viewOnly.value" class="px-3 pt-2 text-xs text-fg-subtle">
      View only. You can read everything here and leave comments.
    </p>

    <!-- File tree (also the upload drop zone) -->
    <UploadDropZone ref="dropZone" :dest-dir="targetDir" :disabled="writesOff || targetBlocked">
      <div ref="treeScroller" class="min-h-0 flex-1 overflow-auto px-2 pt-1 pb-2">
        <!-- The tree's root row. Every folder is selectable and carries a "New
             file in this folder" button; the workspace root had neither, so once
             you clicked into a nested folder there was no way to aim back at the
             top — which is what this fixes. It is always present, so nothing
             below it moves when the selection changes.

             Lives here rather than in FileTree because FileTree is recursive
             (one instance per rendered folder) and is also what the public share
             viewer mounts — a share is a subtree, with no workspace root to
             offer. Hidden while searching, since results replace the tree. -->
        <!-- Styled as the tree's section heading rather than as a row: the
             workspace's name is already at the top of the sidebar, and a second
             copy here read as one more peer of the folders below it. -->
        <div
          v-if="ws.workspace.value && !treeUi.isFiltering.value"
          class="group relative mb-0.5 flex min-h-11 items-center rounded-md pr-1 transition lg:min-h-0"
          :class="atRoot ? 'bg-accent/10' : 'hover:bg-fg/5'"
          :data-root-selected="atRoot || undefined"
        >
          <button
            type="button"
            title="Select the workspace root — new files, folders and uploads land here"
            class="flex min-w-0 flex-1 items-center gap-1.5 py-2.5 pl-1.5 text-left text-xs font-semibold tracking-wide uppercase transition lg:py-1.5"
            :class="atRoot ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted'"
            @click="selectRoot()"
          >
            <Icon icon="solar:home-2-linear" class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate">Files</span>
          </button>
          <button
            v-if="!writesOff"
            type="button"
            title="New file in the workspace root"
            class="grid h-6 w-6 place-items-center rounded text-fg-subtle opacity-0 transition group-hover:opacity-100 hover:bg-fg/10 hover:text-fg focus-visible:opacity-100"
            @click.stop="treeUi.startDraft('')"
          >
            <Icon icon="solar:add-circle-linear" class="h-3.5 w-3.5" />
          </button>
        </div>
        <!-- Tag mode: the tags the query matches, each narrowing to itself
             (nothing outside tag mode, where none match). -->
        <TagChips
          class="mb-1.5 px-1"
          on-sidebar
          :tags="matchedTags.slice(0, 24)"
          :note="tagsNote"
          @select="treeUi.filterQuery.value = `#${$event}`"
        />
        <p v-if="ws.loading.value && !ws.entries.value.length" class="px-1 text-sm text-fg-subtle">
          Loading…
        </p>
        <!-- An empty workspace still renders the tree while the root's new-file
             row is open, so the very first file can be created inline. -->
        <p
          v-else-if="!ws.entries.value.length && treeUi.draftParent.value === null"
          class="px-1 text-sm text-fg-subtle"
        >
          No files yet. Drop files here, or connect an agent or the CLI.
        </p>
        <p
          v-else-if="treeUi.isFiltering.value && !results.length"
          class="px-1 text-sm text-fg-subtle"
        >
          {{ noResults }}
        </p>
        <FileSearchResults
          v-else-if="treeUi.isFiltering.value"
          :results="results"
          :active-index="activeIndex"
          :open-path="ws.selectedPath.value || null"
          :icons="ws.icons.value"
          :total-matches="search.totalMatches"
          @select="onResultSelect"
        />
        <FileTree
          v-else
          :nodes="sortedTree"
          :readonly="writesOff"
          :can-write="ws.canWritePath"
          :reorderable="treeSort === 'custom'"
          :selected="ws.selectedPath.value || null"
          @select="selectNode($event)"
          @request-move="movingNode = $event"
          @create="createFile($event)"
          @edit-icon="ws.editIcon($event)"
          @reorder="ws.reorder($event)"
          @move="ws.moveNode($event)"
          @rename="ws.renameNode($event)"
          @delete="ws.deleteNode($event)"
          @set-private="ws.setPrivate($event)"
          @manage-access="ws.editingAccess.value = $event"
        />
      </div>
    </UploadDropZone>

    <!-- Account, activity, trash, what's new: one row. They used to be four
         full-width rows, which took a sixth of a laptop-height sidebar away from
         the tree — the part people actually use. -->
    <div class="relative flex items-center gap-0.5 border-t border-border px-2 py-1.5">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-left transition hover:bg-surface"
        :class="menuOpen ? 'bg-surface' : ''"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        :title="userName"
        @click="menuOpen = !menuOpen"
      >
        <span
          class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-semibold text-accent"
        >
          {{ initial }}
        </span>
        <span class="min-w-0 flex-1 truncate text-sm text-fg">{{ userName }}</span>
      </button>
      <!-- Everything that happened in THIS workspace, with its unread count. -->
      <button
        v-if="ws.workspaceId.value"
        type="button"
        title="Activity"
        :class="FOOTER_ICON"
        @click="openActivity()"
      >
        <IconHistory class="h-4 w-4" />
        <span class="sr-only">Activity</span>
        <span
          v-if="activityBadge"
          role="status"
          aria-live="polite"
          class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 py-px text-center text-[10px] font-semibold leading-3 text-accent-fg ring-2 ring-surface-2"
        >
          {{ activityBadge }}
          <span class="sr-only">unread changes</span>
        </span>
      </button>
      <!-- Deleted files, to bring back. Beside Activity because that's where
           people look when something has gone missing. -->
      <NuxtLink
        v-if="ws.workspaceId.value"
        :to="`/w/${ws.workspaceId.value}/trash`"
        title="Trash"
        :class="FOOTER_ICON"
      >
        <IconTrash class="h-4 w-4" />
        <span class="sr-only">Trash</span>
      </NuxtLink>
      <!-- Treehouse's own release notes. -->
      <WhatsNew :class="FOOTER_ICON" />

      <div
        v-if="menuOpen"
        class="absolute inset-x-2 bottom-full z-50 mb-1 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <!-- The product-level beta tag: the workspace view has no Treehouse
             logo to sit beside, so it goes in the app's own menu. -->
        <div class="flex items-center gap-2 px-2 pt-1.5 pb-2">
          <span class="ph-mask min-w-0 flex-1 truncate text-xs text-fg-subtle">
            {{ session.data?.user?.email }}
          </span>
          <BetaBadge title="Treehouse is in beta" />
        </div>
        <NuxtLink
          to="/dashboard"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg no-underline transition hover:bg-surface-2"
          @click="menuOpen = false"
        >
          <IconDashboard class="h-4 w-4 text-fg-subtle" /> Dashboard
        </NuxtLink>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
          @click="
            menuOpen = false;
            membersOpen = true;
          "
        >
          <IconMembers class="h-4 w-4 text-fg-subtle" /> Members
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
          @click="
            menuOpen = false;
            keysOpen = true;
          "
        >
          <IconKey class="h-4 w-4 text-fg-subtle" /> Agents &amp; API keys
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
          @click="
            menuOpen = false;
            themeOpen = true;
          "
        >
          <IconPalette class="h-4 w-4 text-fg-subtle" /> Appearance
        </button>
        <!-- Tabs are on by default; this turns them off (or back on). -->
        <button
          v-if="tabsFlag.canToggle.value"
          type="button"
          role="menuitemcheckbox"
          :aria-checked="tabsFlag.on.value"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
          @click="tabsFlag.setOn(!tabsFlag.on.value)"
        >
          <IconTabs class="h-4 w-4 text-fg-subtle" /> Tabs
          <span
            class="ml-auto inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition"
            :class="tabsFlag.on.value ? 'bg-accent' : 'bg-fg/15'"
            aria-hidden="true"
          >
            <span
              class="h-3 w-3 rounded-full bg-surface shadow transition"
              :class="tabsFlag.on.value ? 'translate-x-3' : ''"
            />
          </span>
        </button>
        <hr class="my-1 border-border" />
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
          @click="signOut"
        >
          <IconSignOut class="h-4 w-4 text-fg-subtle" /> Sign out
        </button>
      </div>
      <!-- click-away -->
      <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false" />
    </div>

    <!-- Agents & API keys modal (OAuth connections + user-scoped keys; both reach every workspace) -->
    <div
      v-if="keysOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="keysOpen = false"
    >
      <div
        class="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-border bg-surface p-6 shadow-xl"
      >
        <ApiKeys @undo="keysOpen = false" />
        <div class="mt-4 flex justify-end">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2"
            @click="keysOpen = false"
          >
            Close
          </button>
        </div>
      </div>
    </div>

    <!-- Members of the CURRENT workspace (membership is per-workspace) -->
    <div
      v-if="membersOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="membersOpen = false"
    >
      <div
        class="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-surface p-6 shadow-xl"
      >
        <WorkspaceMembers />
        <div class="mt-4 flex justify-end">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2"
            @click="membersOpen = false"
          >
            Close
          </button>
        </div>
      </div>
    </div>

    <MoveNodeDialog
      :node="movingNode"
      :tree="ws.tree.value"
      @close="movingNode = null"
      @move="moveNode($event)"
    />

    <NodeIconDialog />
    <NodeAccessDialog />
    <ThemeDialog v-model:open="themeOpen" />
  </div>
</template>