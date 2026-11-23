<script setup lang="ts">
import IconNone from "~icons/solar/forbidden-circle-linear";
import { BOARD_COLOR_NAMES, type BoardColor, dotStyle } from "~/utils/board";

// The board's colour picker: one row of the palette plus "no colour". Used for
// a column's colour and for each value of a card field.
defineProps<{ modelValue: BoardColor | null; label: string }>();
const emit = defineEmits<{ "update:modelValue": [BoardColor | null] }>();
</script>

<template>
  <div role="radiogroup" :aria-label="label" class="flex flex-wrap items-center gap-1">
    <button
      type="button"
      role="radio"
      :aria-checked="modelValue === null"
      aria-label="No colour"
      title="No colour"
      class="grid h-5 w-5 place-items-center rounded-full text-fg-subtle transition hover:text-fg"
      :class="modelValue === null ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''"
      @click="emit('update:modelValue', null)"
    >
      <IconNone class="h-4 w-4" />
    </button>
    <button
      v-for="c in BOARD_COLOR_NAMES"
      :key="c"
      type="button"
      role="radio"
      :aria-checked="modelValue === c"
      :aria-label="c"
      :title="c[0]!.toUpperCase() + c.slice(1)"
      class="h-5 w-5 rounded-full transition hover:scale-110"
      :class="modelValue === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''"
      :style="dotStyle(c)"
      @click="emit('update:modelValue', c)"
    />
  </div>
</template>