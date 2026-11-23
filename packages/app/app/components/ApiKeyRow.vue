<script setup lang="ts">
import type { ApiKeyInfo } from "~/composables/useTreehouseApi";

// One key in the API keys list: its name, the start of the key, who it acts
// as, and what can be done with it.
defineProps<{ apiKey: ApiKeyInfo; canUndo: boolean }>();
const emit = defineEmits<{ undo: []; revoke: [] }>();
</script>

<template>
  <li class="flex items-center justify-between gap-2 py-2">
    <div class="min-w-0">
      <span class="text-fg">{{ apiKey.name ?? "(unnamed)" }}</span>
      <span class="ml-2 font-mono text-xs text-fg-subtle">{{ apiKey.start ?? "" }}…</span>
      <span
        v-if="apiKey.metadata?.actorType"
        class="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted"
        >{{ apiKey.metadata.actorType }}</span
      >
      <span
        v-if="apiKey.metadata?.scope?.access === 'read'"
        class="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted"
        >read only</span
      >
      <span
        v-if="apiKey.metadata?.scope?.folder"
        class="ph-mask ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted"
        >{{ apiKey.metadata.scope.folder }}</span
      >
    </div>
    <div class="flex shrink-0 items-center gap-3">
      <button
        v-if="canUndo"
        type="button"
        class="text-xs text-fg-muted hover:text-fg"
        @click="emit('undo')"
      >
        Undo changes…
      </button>
      <button type="button" class="text-xs text-danger hover:text-danger" @click="emit('revoke')">
        Revoke
      </button>
    </div>
  </li>
</template>