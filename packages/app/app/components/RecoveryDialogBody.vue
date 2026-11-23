<script setup lang="ts">
import type { RecoveryAction, RecoverySkip } from "shared";
import type { dialogNotices } from "~/utils/recovery";

// What the recovery dialog shows between its title and buttons: notices, the
// count of each kind of change, then the files changed and the files left alone.
defineProps<{
  loading: boolean;
  notices: ReturnType<typeof dialogNotices>;
  counts: string[];
  actions: RecoveryAction[];
  skipped: RecoverySkip[];
  done: boolean;
}>();

const NOTICE_CLASS = {
  danger: "border-danger/30 bg-danger/5 text-danger",
  warning: "border-warning/30 bg-warning/10 text-fg",
  muted: "border-transparent px-0 text-fg-muted",
} as const;
</script>

<template>
  <div class="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3 text-sm">
    <div v-if="loading" class="space-y-2" aria-busy="true">
      <div v-for="n in 3" :key="n" class="h-4 w-3/4 animate-pulse rounded bg-surface-2" />
    </div>
    <p
      v-for="n in notices"
      :key="n.text"
      :role="n.tone === 'danger' ? 'alert' : undefined"
      class="rounded-md border px-3 py-2"
      :class="NOTICE_CLASS[n.tone]"
    >
      {{ n.text }}
    </p>
    <ul v-if="counts.length" class="space-y-0.5 text-fg">
      <li v-for="line in counts" :key="line">{{ line }}</li>
    </ul>
    <RecoveryChangeList v-if="actions.length" :actions="actions" :done="done" />
    <RecoverySkipList v-if="skipped.length" :skipped="skipped" />
  </div>
</template>