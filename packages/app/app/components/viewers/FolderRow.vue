<script setup lang="ts">
import type { TreeNode } from "~/utils/treehouse";
import type { FolderColumn } from "./FolderView.vue";

// One row of the folder listing. `who` is null when the listing has no details
// (a public share), which drops the "Modified by" cell with its column.
defineProps<{ node: TreeNode; columns: FolderColumn[]; who: string | null }>();
const emit = defineEmits<{ select: [node: { path: string; isDir: boolean }] }>();
</script>

<template>
  <tr
    class="cursor-pointer transition hover:bg-app"
    @click="emit('select', { path: node.path, isDir: node.isDir })"
  >
    <td class="px-4 py-2.5">
      <!-- The row is the click target; the button makes it reachable by
           keyboard without nesting interactive elements. -->
      <button
        type="button"
        class="flex w-full min-w-0 text-left text-fg"
        @click.stop="emit('select', { path: node.path, isDir: node.isDir })"
      >
        <FolderRowName :node="node" />
      </button>
    </td>
    <td
      v-for="col in columns"
      :key="col.key"
      class="truncate px-3 py-2.5 text-fg-muted"
      :class="col.class"
      :title="col.cell(node).title"
    >
      {{ col.cell(node).text }}
    </td>
    <td v-if="who !== null" class="hidden truncate px-3 py-2.5 md:table-cell">
      <!-- ph-mask: a member's name is personal. -->
      <span
        class="ph-mask"
        :class="node.modifiedBy?.principal === 'agent' ? 'text-agent' : 'text-fg-muted'"
        >{{ who }}</span
      >
    </td>
  </tr>
</template>