<script setup lang="ts">
// One limited figure in the workspace details panel: a heading, "x of y used",
// and (when there is a fraction to draw) a bar that turns at-risk on warning.
defineProps<{
  heading: string;
  /** Fraction of the limit consumed, 0–1. Omit for a figure with no bar. */
  fraction?: number;
  warning?: boolean;
}>();
</script>

<template>
  <div class="space-y-1.5">
    <p class="panel-heading">{{ heading }}</p>
    <p class="text-sm" :class="warning ? 'text-warning' : 'text-fg-muted'"><slot /></p>
    <div v-if="fraction != null" class="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div
        class="h-full rounded-full transition-[width]"
        :class="warning ? 'bg-warning' : 'bg-accent'"
        :style="{ width: `${Math.round(fraction * 100)}%` }"
      />
    </div>
  </div>
</template>