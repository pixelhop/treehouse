<script setup lang="ts">
// Non-blocking banner shown above the editor when (a) the open file changed on
// the server while editing (serverChanged), or (b) a save lost the version race
// and the server kept our bytes as a conflict copy. Never blocks; the file
// service guarantees no data is lost.
import type { FileConflict } from "~/composables/useFileEditor";

defineProps<{ conflict: FileConflict | null; serverChanged: boolean }>();
const emit = defineEmits<{ reload: []; dismiss: [] }>();
</script>

<template>
  <div
    class="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-fg"
  >
    <template v-if="conflict">
      <span class="min-w-0 flex-1">
        This file changed on the server, so your save was kept as a copy:
        <span class="font-medium">{{ conflict.conflictCopyPath ?? "a conflict copy" }}</span
        >.
      </span>
      <button
        type="button"
        class="shrink-0 font-medium text-accent hover:underline"
        @click="emit('reload')"
      >
        Reload latest
      </button>
    </template>
    <template v-else>
      <span class="min-w-0 flex-1"
        >This file was changed on the server while you were editing.</span
      >
      <button
        type="button"
        class="shrink-0 font-medium text-accent hover:underline"
        @click="emit('reload')"
      >
        Reload
      </button>
      <button type="button" class="shrink-0 text-fg-muted hover:text-fg" @click="emit('dismiss')">
        Dismiss
      </button>
    </template>
  </div>
</template>