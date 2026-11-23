<script setup lang="ts">
// The recovery dialog's buttons: Cancel and confirm before, Done after.
defineProps<{ done: boolean; canApply: boolean; applying: boolean; confirmLabel: string }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <div class="flex shrink-0 justify-end gap-2 border-t border-border p-3">
    <button
      v-if="done"
      type="button"
      class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90"
      @click="emit('close')"
    >
      Done
    </button>
    <template v-else>
      <button
        type="button"
        class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
        :disabled="!canApply || applying"
        @click="emit('confirm')"
      >
        {{ applying ? "Working…" : confirmLabel }}
      </button>
    </template>
  </div>
</template>