<script setup lang="ts">
import { Icon } from "@iconify/vue";
import { collectFolderPaths } from "~/utils/treehouse";
import type { TreeNode } from "~/utils/treehouse";

// Pick a destination folder for a file or folder.
//
// Moving used to be drag-and-drop only, and HTML5 drag events do not fire from
// touch input — so on a phone a file could not be moved out of the folder it
// landed in at all. This is the same operation with a target you can tap.
//
// ModalSurface supplies the dialog semantics, Escape, focus trapping and focus
// restoration; this component only decides what goes inside.
const props = defineProps<{
  /** The node being moved, or null when the dialog is closed. */
  node: { path: string; isDir: boolean; name: string } | null;
  /** The whole tree, to enumerate candidate destinations. */
  tree: TreeNode[];
}>();

const emit = defineEmits<{
  close: [];
  move: [args: { from: string; isDir: boolean; destParent: string }];
}>();

const parentOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
};

// Every folder, plus the root, minus the destinations that would be a no-op or
// impossible: the node's current parent, the node itself, and — for a folder —
// anything inside it.
const destinations = computed(() => {
  const node = props.node;
  if (!node) return [];
  const current = parentOf(node.path);
  return ["", ...collectFolderPaths(props.tree)]
    .filter((path) => path !== current)
    .filter((path) => !(node.isDir && (path === node.path || path.startsWith(`${node.path}/`))))
    .sort((a, b) => a.localeCompare(b));
});
</script>

<template>
  <ModalSurface
    v-if="node"
    :label="`Move ${node.name}`"
    placement="sheet"
    panel-class="w-full rounded-t-xl sm:rounded-xl flex flex-col"
    @close="emit('close')"
  >
    <div class="shrink-0 border-b border-border px-4 py-3">
      <p class="text-xs tracking-wide text-fg-subtle uppercase">Move</p>
      <!-- ph-mask: user-authored file/folder name; masked in session replay (see app/plugins/posthog.client.ts). -->
      <p class="ph-mask truncate text-sm font-medium text-fg">{{ node.name }}</p>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-2">
      <p v-if="!destinations.length" class="px-2 py-4 text-sm text-fg-subtle">
        There's nowhere else to put this yet — create a folder first.
      </p>
      <button
        v-for="dest in destinations"
        :key="dest || '/'"
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm text-fg transition hover:bg-surface-2 focus-visible:bg-surface-2"
        @click="emit('move', { from: node.path, isDir: node.isDir, destParent: dest })"
      >
        <Icon
          :icon="dest ? 'solar:folder-with-files-linear' : 'solar:home-2-linear'"
          class="h-4 w-4 shrink-0 text-fg-subtle"
        />
        <span class="truncate">{{ dest || "Workspace root" }}</span>
      </button>
    </div>

    <div class="shrink-0 border-t border-border p-2">
      <button
        type="button"
        class="w-full rounded-md border border-border px-3 py-2 text-sm text-fg transition hover:bg-surface-2 focus-visible:bg-surface-2"
        @click="emit('close')"
      >
        Cancel
      </button>
    </div>
  </ModalSurface>
</template>