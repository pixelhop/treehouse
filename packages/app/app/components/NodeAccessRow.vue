<script setup lang="ts">
import type { WorkspaceMember } from "~/composables/useTreehouseApi";

// One person in the access dialog. A workspace Viewer is only offered Viewer,
// because a grant can't give someone more than their role.
const props = defineProps<{ member: WorkspaceMember; level: string; isMe: boolean }>();
const emit = defineEmits<{ change: [level: string] }>();
const isViewer = computed(() => props.member.role === "viewer");
</script>

<template>
  <li class="flex items-center gap-3 py-2">
    <span class="min-w-0 flex-1 truncate text-fg">
      {{ member.name }}
      <span v-if="isMe" class="text-fg-subtle">(you)</span>
    </span>
    <span v-if="isMe" class="shrink-0 text-xs text-fg-subtle">Editor</span>
    <select
      v-else
      :value="level"
      :aria-label="`Access for ${member.name}`"
      class="shrink-0 rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none"
      @change="emit('change', ($event.target as HTMLSelectElement).value)"
    >
      <option value="none">No access</option>
      <option value="read">Viewer</option>
      <option v-if="!isViewer" value="write">Editor</option>
    </select>
  </li>
</template>