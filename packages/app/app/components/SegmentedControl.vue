<script setup lang="ts" generic="T extends string">
// The app's one segmented control.
//
// There were two of these in the file top bar, at different sizes, with
// different corner radii and different active treatments — a folder switcher
// and a rendered/source toggle sitting side by side, visibly from different
// products. One component, one style, so anything that picks between two or
// three views of the same thing looks like the same control.
//
// Segments are data, not markup: callers hide a segment by leaving it out of
// `options` (Source only exists for markdown/html; Changes only when there is a
// base to compare against), and the whole control is hidden by the caller when
// fewer than two segments would remain.
defineProps<{
  modelValue: T;
  options: readonly { value: T; label: string; title?: string; mask?: boolean }[];
  /** Accessible name for the group — "View", "Folder view". */
  label: string;
}>();
defineEmits<{ "update:modelValue": [T] }>();
</script>

<template>
  <div
    role="group"
    :aria-label="label"
    class="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5"
  >
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      :title="o.title"
      :aria-pressed="o.value === modelValue"
      class="rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition"
      :class="
        o.value === modelValue ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'
      "
      @click="$emit('update:modelValue', o.value)"
    >
      <!-- ph-mask: callers mark user-authored labels so session replay keeps
           the control's shape without recording file or folder names. -->
      <span :class="o.mask ? 'ph-mask' : undefined">{{ o.label }}</span>
    </button>
  </div>
</template>