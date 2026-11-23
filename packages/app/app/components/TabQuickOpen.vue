<script setup lang="ts">
import { searchPaths, type SearchItem } from "shared";
import IconSearch from "~icons/solar/magnifer-linear";
import IconHome from "~icons/solar/home-2-linear";
import { relativeTime, type FeedEvent } from "~/utils/activity";
import { basename } from "~/utils/format";
import { recentlyChanged } from "~/utils/tabs";
import { flattenTree, type TreeNode } from "~/utils/treehouse";

// What the tab row's "+" (and ⌥T) opens: a file search that opens its pick in
// a new tab. Treehouse has no "untitled page" to put in an empty tab, so a new
// tab starts as the question "which file?" — with the workspace's recently
// changed files under it, since that is usually the answer.
const props = defineProps<{
  tree: TreeNode[];
  icons: Record<string, string>;
  events: FeedEvent[];
  existing: Set<string>;
  /** Who made a change, as the row should name them ("You", a member, an agent's label). */
  actorName: (e: FeedEvent) => string;
  at: { x: number; y: number };
}>();
const emit = defineEmits<{ open: [path: string]; close: [] }>();

const query = ref("");
const active = ref(0);

const items = computed<SearchItem[]>(() => flattenTree(props.tree));

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  parent: string;
  who?: { label: string; agent: boolean; when: string };
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// The newest change per still-existing file, a handful deep.
const recent = computed<Row[]>(() =>
  recentlyChanged(props.events, (p) => props.existing.has(p), 6).map((e) => ({
    path: e.path,
    name: basename(e.path),
    isDir: false,
    parent: parentOf(e.path),
    who: {
      label: props.actorName(e),
      agent: e.principal === "agent",
      when: relativeTime(e.createdAt),
    },
  })),
);

const rows = computed<Row[]>(() => {
  if (!query.value.trim()) return recent.value;
  return searchPaths(query.value, items.value, { limit: 8 }).results.map((r) => ({
    path: r.path,
    name: r.name,
    isDir: r.isDir,
    parent: parentOf(r.path),
  }));
});
watch(rows, () => {
  active.value = 0;
});

function move(delta: number) {
  const n = rows.value.length;
  if (n) active.value = (active.value + delta + n) % n;
}
function pick(path: string) {
  emit("open", path);
}
function onEnter() {
  const row = rows.value[active.value];
  if (row) pick(row.path);
}
</script>

<template>
  <ModalSurface
    label="Open a file in a new tab"
    placement="point"
    :at="at"
    :scrim="false"
    panel-class="w-[26rem] rounded-xl p-2"
    @close="emit('close')"
  >
    <label
      class="flex items-center gap-2 rounded-lg border border-accent px-3 py-2 ring-3 ring-accent/15"
    >
      <IconSearch class="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <input
        v-model="query"
        type="text"
        placeholder="Open a file…"
        aria-label="Open a file in a new tab"
        class="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="onEnter()"
      />
    </label>

    <p
      v-if="!query.trim() && rows.length"
      class="mt-3 mb-1 px-2 text-[11px] font-bold tracking-[0.12em] text-fg-subtle"
    >
      RECENTLY CHANGED
    </p>
    <ul class="mt-1 space-y-0.5" role="listbox" aria-label="Files">
      <li v-for="(r, i) in rows" :key="r.path" role="option" :aria-selected="i === active">
        <button
          type="button"
          tabindex="-1"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition"
          :class="i === active ? 'bg-surface-2' : 'hover:bg-surface-2'"
          @mouseenter="active = i"
          @click="pick(r.path)"
        >
          <NodeIcon
            :icon="icons[r.path] ?? null"
            :is-dir="r.isDir"
            class="h-4 w-4 shrink-0 text-fg-subtle"
          />
          <span class="ph-mask min-w-0 truncate">{{ r.name }}</span>
          <span v-if="r.parent" class="ph-mask min-w-0 truncate text-xs text-fg-subtle">{{
            r.parent
          }}</span>
          <span
            v-if="r.who"
            class="ml-auto shrink-0 text-xs font-semibold"
            :class="r.who.agent ? 'text-agent' : 'text-human'"
            >{{ r.who.label }} · {{ r.who.when }}</span
          >
        </button>
      </li>
    </ul>
    <p v-if="query.trim() && !rows.length" class="px-2 py-3 text-sm text-fg-subtle">
      No files match.
    </p>
    <button
      v-if="!query.trim()"
      type="button"
      tabindex="-1"
      class="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted transition hover:bg-surface-2"
      @click="pick('')"
    >
      <IconHome class="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      Workspace home
    </button>
  </ModalSurface>
</template>