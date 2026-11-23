<script setup lang="ts">
import type { Component } from "vue";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import type { TreeRowAction, TreeRowMenuItem } from "~/utils/treeRowMenu";

// One line of the sidebar tree's row menu (TreeRowMenu): an action, or a note
// standing in for one.
defineProps<{ item: TreeRowMenuItem; icon?: Component }>();
const emit = defineEmits<{ run: [action: TreeRowAction] }>();
</script>

<template>
  <button
    v-if="item.kind === 'action'"
    type="button"
    class="flex w-full items-center gap-2.5 rounded-md px-2 py-2.5 text-left text-sm transition focus-visible:bg-surface-2 lg:py-1.5"
    :class="item.danger ? 'text-danger hover:bg-danger/10' : 'text-fg hover:bg-surface-2'"
    @click="emit('run', item.action)"
  >
    <component :is="icon" class="h-4 w-4 shrink-0" :class="{ 'text-fg-subtle': !item.danger }" />
    {{ item.label }}
    <span v-if="item.hint" class="ml-auto text-xs text-fg-subtle">{{ item.hint }}</span>
  </button>
  <p v-else class="flex items-start gap-2.5 px-2 py-1.5 text-left text-xs text-fg-subtle">
    <IconLock class="mt-0.5 h-4 w-4 shrink-0" />
    {{ item.text }}
  </p>
</template>