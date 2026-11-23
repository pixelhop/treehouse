<script setup lang="ts">
import IconSortDown from "~icons/solar/alt-arrow-down-linear";
import IconSortUp from "~icons/solar/alt-arrow-up-linear";
import type { FileModifier } from "~/composables/useTreehouseApi";
import { exactTime, relativeTime } from "~/utils/activity";
import { prettyBytes } from "~/utils/format";
import { compareNodes, type ListSortKey, type TreeNode } from "~/utils/treehouse";

// The folder listing: a table you can sort by clicking a column. With details
// (the workspace's own listing) it also shows when each row was changed and
// created, its size and who last changed it; a public share's listing carries
// none of that, so it gets the name column alone.
//
// `whoName` turns a modifier into a display name ("You", a member, an agent's
// label). It is the workspace's to resolve — a share has no member list.
const props = defineProps<{
  name: string;
  icon?: string | null;
  children: TreeNode[];
  whoName?: (m: FileModifier) => string;
}>();
const emit = defineEmits<{ select: [node: { path: string; isDir: boolean }] }>();

const { listSort, toggleListSort } = useSortPrefs();

const hasDetails = computed(() => props.children.some((c) => c.updatedAt !== null));

// Without a chosen column the folder keeps its own order (custom, then A–Z),
// exactly as the sidebar shows it.
const rows = computed(() => {
  const sort = listSort.value;
  if (!sort) return props.children;
  return [...props.children].sort((a, b) => compareNodes(a, b, sort.key, sort.dir));
});

export interface FolderColumn {
  key: ListSortKey;
  label: string;
  // Narrow screens keep Name and Modified; the rest appear as room allows.
  class: string;
  headClass: string;
  cell: (n: TreeNode) => { text: string; title?: string };
}

const when = (iso: string | null) =>
  iso ? { text: relativeTime(iso), title: exactTime(iso) } : { text: "" };

const DETAIL_COLUMNS: FolderColumn[] = [
  {
    key: "modified",
    label: "Modified",
    class: "w-28",
    headClass: "px-3",
    cell: (n) => when(n.updatedAt),
  },
  {
    key: "created",
    label: "Created",
    class: "hidden w-28 lg:table-cell",
    headClass: "px-3",
    cell: (n) => when(n.createdAt),
  },
  {
    key: "size",
    label: "Size",
    class: "hidden w-20 text-right tabular-nums sm:table-cell",
    headClass: "justify-end px-3",
    // A folder shows its total, the same number the column sorts it by.
    cell: (n) => ({ text: n.size === null ? "" : prettyBytes(n.size) }),
  },
];
const columns = computed(() => (hasDetails.value ? DETAIL_COLUMNS : []));
// Name is always there and always sortable, details or not.
const NAME_HEADER = { key: "name", label: "Name", class: "", headClass: "px-4 text-left" } as const;
const headers = computed(() => [NAME_HEADER, ...columns.value]);

function sortIcon(key: ListSortKey) {
  if (listSort.value?.key !== key) return null;
  return listSort.value.dir === "asc" ? IconSortUp : IconSortDown;
}
function ariaSort(key: ListSortKey) {
  if (listSort.value?.key !== key) return "none";
  return listSort.value.dir === "asc" ? "ascending" : "descending";
}

function who(m: FileModifier | null): string {
  return m && props.whoName ? props.whoName(m) : "";
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="flex items-center gap-2 text-lg font-semibold text-fg">
      <NodeIcon :icon="icon" :is-dir="true" class="h-5 w-5 shrink-0 text-fg-subtle" />
      <!-- ph-mask: folder headings are user-authored names. -->
      <span v-if="name" class="ph-mask min-w-0 truncate">{{ name }}</span>
      <span v-else>Workspace</span>
    </h2>

    <p v-if="children.length === 0" class="text-sm text-fg-muted">This folder is empty.</p>

    <div v-else class="overflow-hidden rounded-lg border border-border">
      <table class="w-full table-fixed text-sm">
        <thead class="border-b border-border bg-surface-2/60 text-xs text-fg-subtle">
          <tr>
            <th
              v-for="col in headers"
              :key="col.key"
              scope="col"
              class="font-medium"
              :class="col.class"
              :aria-sort="ariaSort(col.key)"
            >
              <button
                type="button"
                class="flex w-full items-center gap-1 py-2 transition hover:text-fg"
                :class="col.headClass"
                @click="toggleListSort(col.key)"
              >
                {{ col.label }} <component :is="sortIcon(col.key)" class="h-3 w-3" />
              </button>
            </th>
            <th
              v-if="hasDetails"
              scope="col"
              class="hidden w-36 px-3 py-2 text-left font-medium md:table-cell"
            >
              Modified by
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <FolderRow
            v-for="node in rows"
            :key="node.path"
            :node="node"
            :columns="columns"
            :who="hasDetails ? who(node.modifiedBy) : null"
            @select="emit('select', $event)"
          />
        </tbody>
      </table>
    </div>
  </div>
</template>