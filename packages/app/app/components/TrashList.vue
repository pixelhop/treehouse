<script setup lang="ts">
import type { TrashItem } from "shared";
import { groupByDay } from "~/utils/activity";

// The trash's entries grouped by day, with select-all. Selection lives in the
// parent, which owns the Restore button.
const props = defineProps<{
  items: TrashItem[];
  selected: Set<string>;
  allSelected: boolean;
  deletedBy: (item: TrashItem) => string;
  /** A viewer sees what was deleted but can't bring it back. */
  readonly?: boolean;
}>();
const emit = defineEmits<{ toggle: [path: string]; toggleAll: []; restore: [path: string] }>();
const days = computed(() => groupByDay(props.items, (i) => i.deletedAt));
</script>

<template>
  <label v-if="!readonly" class="mb-3 flex items-center gap-2 text-xs text-fg-muted">
    <input type="checkbox" :checked="allSelected" @change="emit('toggleAll')" />
    Select all
  </label>
  <section v-for="(day, di) in days" :key="day.label" :class="di > 0 ? 'mt-5' : ''">
    <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
      {{ day.label }}
    </h2>
    <ul class="divide-y divide-border">
      <TrashRow
        v-for="item in day.items"
        :key="`${item.path}:${item.seq}`"
        :item="item"
        :selected="selected.has(item.path)"
        :deleted-by="deletedBy(item)"
        :readonly="readonly"
        @toggle="emit('toggle', item.path)"
        @restore="emit('restore', item.path)"
      />
    </ul>
  </section>
</template>