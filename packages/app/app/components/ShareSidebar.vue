<script setup lang="ts">
import IconSearch from "~icons/solar/magnifer-linear";
import logoUrl from "design/assets/logo/treehouse.svg";
import { searchPaths, type SearchItem } from "shared";
import type { TreeNode } from "~/utils/treehouse";

// The public share viewer's sidebar — the same shape as AppSidebar (identity
// block, filter, tree), with the workspace switcher replaced by the workspace's
// own identity (it isn't switchable here) and the account menu replaced by the
// sign-up invitation. The tree itself is the app's FileTree in readonly mode, so
// a shared folder browses exactly like it does inside the workspace.
const props = defineProps<{
  token: string;
  name: string;
  icon: string | null;
  workspace: { id: string | null; name: string; icon: string | null; color: string | null };
  nodes: TreeNode[];
  selected: string | null;
  loading: boolean;
}>();
const emit = defineEmits<{ select: [node: { path: string; isDir: boolean } | null] }>();

const treeUi = useFileTreeUi(computed(() => props.token));
const sb = useSidebar();

// Compact: the sidebar overlays the document, so opening a file dismisses it.
function selectNode(node: { path: string; isDir: boolean }) {
  emit("select", node);
  if (!node.isDir) sb.close();
}
// Same ranked fuzzy search as the workspace sidebar, over the same shared
// scorer. `filterTree` (a substring match that pruned the tree in place) is gone:
// a folder-name match unfurled its entire subtree, so a one- or two-character
// query mounted most of the tree and unmounted it on the next keystroke. Using
// the same search here is also what this component says it is for — "a shared
// folder browses exactly like it does inside the workspace".
const flatNodes = computed<SearchItem[]>(() => {
  const out: SearchItem[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push({ path: n.path, name: n.name, isDir: n.isDir });
      if (n.isDir) walk(n.children);
    }
  };
  walk(props.nodes);
  return out;
});

// Debounced exactly as in AppSidebar: the input never lags, clearing is instant.
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
);
onScopeDispose(() => clearTimeout(debounceTimer));

const search = computed(() => searchPaths(treeUi.debouncedQuery.value, flatNodes.value));
const results = computed(() => search.value.results);

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

/** Open a result, then hand the visitor back to the tree with it revealed. */
function openResult(node: { path: string; isDir: boolean }) {
  clearSearch();
  selectNode(node);
  treeUi.reveal(node.path, node.isDir);
}

function onSearchEnter() {
  // Enter must act on what is typed, not on what the debounce caught up to.
  const typed = treeUi.filterQuery.value;
  const settled = typed === treeUi.debouncedQuery.value;
  const list = settled ? results.value : searchPaths(typed, flatNodes.value).results;
  const r = list[settled ? activeIndex.value : 0];
  if (r) openResult({ path: r.path, isDir: r.isDir });
}

// Reveal the open file's ancestor folders, so a deep link into a shared subtree
// opens with the tree already expanded around it.
watch(
  () => props.selected,
  (p) => {
    if (p) treeUi.reveal(p, false);
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full flex-col bg-surface-2">
    <!-- Where the workspace switcher sits in the app, carrying the same icon
         tile, colour and name — a visitor should recognise whose workspace this
         is. Not a button: there is nothing to switch to from here. -->
    <div class="flex items-center gap-2 px-3 py-3">
      <WorkspaceIcon :icon="workspace.icon" :color="workspace.color" :workspace-id="workspace.id" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-fg" :title="workspace.name">
          {{ workspace.name || "Shared" }}
        </span>
        <span class="block truncate text-xs text-fg-muted">Workspace</span>
      </span>
    </div>
    <button
      type="button"
      class="flex items-center gap-2 border-y border-border px-3 py-2 text-left transition hover:bg-surface"
      :title="name"
      @click="emit('select', null)"
    >
      <NodeIcon :icon="icon" :is-dir="true" class="h-4 w-4 shrink-0 text-fg-subtle" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-fg">{{ name }}</span>
        <span class="block truncate text-xs text-fg-muted">Shared folder</span>
      </span>
    </button>

    <!-- Filter -->
    <div v-if="nodes.length" class="px-2 pt-2">
      <div class="relative">
        <IconSearch
          class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
        />
        <input
          v-model="treeUi.filterQuery.value"
          type="search"
          placeholder="Search files…"
          role="combobox"
          aria-label="Search files"
          aria-controls="th-search-listbox"
          :aria-expanded="treeUi.isFiltering.value"
          :aria-activedescendant="
            treeUi.isFiltering.value && results.length
              ? `th-search-result-${activeIndex}`
              : undefined
          "
          class="w-full rounded-md border border-border bg-surface py-1.5 pr-2 pl-7 text-base text-fg outline-none transition focus:border-accent lg:py-1 lg:text-sm"
          @keydown.down.prevent="moveActive(1)"
          @keydown.up.prevent="moveActive(-1)"
          @keydown.enter.prevent="onSearchEnter()"
          @keydown.esc.prevent="clearSearch()"
        />
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-2 pt-1 pb-2">
      <p v-if="loading && !nodes.length" class="px-1 text-sm text-fg-subtle">Loading…</p>
      <p v-else-if="!nodes.length" class="px-1 text-sm text-fg-subtle">This folder is empty.</p>
      <p
        v-else-if="treeUi.isFiltering.value && !results.length"
        class="px-1 text-sm text-fg-subtle"
      >
        No files match “{{ treeUi.debouncedQuery.value }}”.
      </p>
      <FileSearchResults
        v-else-if="treeUi.isFiltering.value"
        :results="results"
        :active-index="activeIndex"
        :open-path="selected"
        :icons="{}"
        :total-matches="search.totalMatches"
        @select="openResult($event)"
      />
      <FileTree
        v-else
        readonly
        :scope="token"
        :nodes="nodes"
        :selected="selected"
        @select="selectNode($event)"
      />
    </div>

    <!-- Where the account menu sits in the app. A share is often someone's first
         sight of Treehouse, so this is the one place the product asks for
         anything — a link, not a banner. -->
    <div class="flex items-center gap-2.5 border-t border-border p-3">
      <img :src="logoUrl" alt="" aria-hidden="true" class="h-7 w-7 shrink-0" />
      <span class="min-w-0">
        <span class="block truncate text-xs text-fg-muted">Shared with Treehouse</span>
        <NuxtLink
          to="/sign-up"
          class="block truncate text-sm font-medium text-accent no-underline transition hover:underline"
        >
          Create your own workspace →
        </NuxtLink>
      </span>
    </div>
  </div>
</template>