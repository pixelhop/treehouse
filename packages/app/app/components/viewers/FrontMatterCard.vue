<script setup lang="ts">
// Front-matter shown above the body in the markdown viewer. Collapsed by default
// to a single summary bar so it never buries the reading column; click to expand
// the full type-aware list. Keys and values render as text only (KTD5).
import type { FrontMatterData } from "~/utils/frontmatterData";
import { frontMatterFieldKind } from "~/utils/frontmatterFields";

const props = defineProps<{ data: FrontMatterData }>();

const entries = computed(() => Object.entries(props.data));
const count = computed(() => entries.value.length);

// A couple of representative scalar values for the collapsed summary line.
const summary = computed(() => {
  const bits: string[] = [];
  for (const [, value] of entries.value) {
    const kind = frontMatterFieldKind(value);
    if (kind === "scalar" || kind === "date" || kind === "boolean") bits.push(String(value));
    if (bits.length >= 2) break;
  }
  return bits.join(" · ");
});

const expanded = ref(false);
</script>

<template>
  <section
    v-if="count"
    class="mb-6 overflow-hidden rounded-lg border border-border bg-surface-2/40"
    aria-label="Document metadata"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-fg-subtle transition hover:bg-surface-2/60"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="text-fg-muted">{{ expanded ? "▾" : "▸" }}</span>
      <span class="font-medium text-fg-muted">Metadata</span>
      <template v-if="summary && !expanded">
        <span>·</span>
        <span class="truncate text-fg-muted">{{ summary }}</span>
      </template>
      <span class="ml-auto shrink-0">{{ count }} {{ count === 1 ? "field" : "fields" }}</span>
    </button>
    <div v-if="expanded" class="border-t border-border px-4 py-3">
      <FrontMatterList :data="data" />
    </div>
  </section>
</template>