<script setup lang="ts">
// A row of tag chips, each a button, under an optional heading. Used for a
// file's tags in its details and for the tags a sidebar `#` search matches.
// Renders nothing when there are no tags. Tags are workspace content, so the
// row is masked from session capture.
const props = defineProps<{
  tags: { tag: string; count?: number }[];
  /** Tooltip for each chip; the tag is appended. */
  title?: string;
  /** A section heading; with one, the row is set off as a details section. */
  heading?: string;
  /** A small line under the chips. */
  note?: string;
  /** On the sidebar's background, chips need the lighter surface to show. */
  onSidebar?: boolean;
}>();
defineEmits<{ select: [tag: string] }>();

const section = computed(() => (props.heading ? "border-t border-border pt-3" : ""));
const surface = computed(() => (props.onSidebar ? "bg-surface" : "bg-surface-2"));
const tooltip = (tag: string) => (props.title ? `${props.title} #${tag}` : undefined);
</script>

<template>
  <div v-if="tags.length" :class="section">
    <h4 v-if="heading" class="panel-heading mb-2">
      {{ heading }}
    </h4>
    <ul class="ph-no-capture flex flex-wrap gap-1.5">
      <li v-for="t in tags" :key="t.tag">
        <button
          type="button"
          class="ph-mask rounded-full px-2 py-0.5 text-xs text-fg-muted transition hover:bg-accent/10 hover:text-accent"
          :class="surface"
          :title="tooltip(t.tag)"
          @click="$emit('select', t.tag)"
        >
          #{{ t.tag }}<span class="ml-1 text-fg-subtle empty:hidden">{{ t.count }}</span>
        </button>
      </li>
    </ul>
    <p v-if="note" class="mt-1.5 text-[11px] text-fg-subtle">{{ note }}</p>
  </div>
</template>