<script lang="ts" setup>
// Images in docs pages are app screenshots: framed on a white card so they sit
// on the cream canvas instead of bleeding into it, lazy-loaded, and clickable
// to open full size. The alt text doubles as the caption the twin keeps.
const props = defineProps<{
  src: string;
  alt?: string;
  width?: string | number;
  height?: string | number;
}>();
</script>

<template>
  <a :href="props.src" target="_blank" rel="noopener" class="docs-shot not-prose my-7 block">
    <img
      :src="props.src"
      :alt="props.alt"
      :width="props.width"
      :height="props.height"
      loading="lazy"
      decoding="async"
      class="block w-full rounded-xl border border-border bg-surface shadow-md"
    />
  </a>
</template>