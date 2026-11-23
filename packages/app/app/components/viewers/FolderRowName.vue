<script setup lang="ts">
import type { TreeNode } from "~/utils/treehouse";

// The name cell of a folder listing row: icon, name, and the row's markers —
// new to you, or a conflicted copy.
defineProps<{ node: TreeNode }>();
</script>

<template>
  <span class="flex min-w-0 items-center gap-2">
    <NodeIcon :icon="node.icon" :is-dir="node.isDir" class="h-4 w-4 shrink-0 text-fg-subtle" />
    <!-- ph-mask: user-authored file/folder name; masked in session replay (see app/plugins/posthog.client.ts). -->
    <span class="ph-mask truncate" :class="{ 'font-medium': node.unseen }">{{ node.name }}</span>
    <span
      v-if="node.unseen"
      :title="node.isDir ? 'Something in here is new to you' : 'New since you last looked'"
      class="h-2 w-2 shrink-0 rounded-full bg-accent"
    >
      <span class="sr-only">New</span>
    </span>
    <span
      v-if="node.conflicted"
      title="Conflicted copy — both versions kept; resolve manually"
      class="ml-auto text-warning"
      >⚠</span
    >
  </span>
</template>