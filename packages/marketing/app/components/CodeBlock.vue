<script setup lang="ts">
/**
 * Renders a snippet highlighted at build time by build/snippets.ts.
 *
 * v-html is safe here by construction: the markup is produced by Shiki during
 * the build from source committed to this repo. Nothing user-supplied, and
 * nothing fetched, ever reaches it.
 */
defineProps<{ snippet: { label: string; html: string } }>();
</script>

<template>
  <div class="code-block overflow-hidden rounded-xl bg-charcoal">
    <div class="flex items-center gap-2 border-b border-cream/10 px-4 py-2">
      <span class="size-1.5 rounded-full bg-sage/50" aria-hidden="true" />
      <span class="text-[11px] font-bold uppercase tracking-[0.14em] text-cream/60">
        {{ snippet.label }}
      </span>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="code-block-body" v-html="snippet.html" />
  </div>
</template>

<style scoped>
/*
 * Shiki emits its own <pre class="shiki">, so the padding and scroll behaviour
 * are set here rather than on a wrapper — otherwise the background it inlines
 * sits inside our padding and leaves a charcoal box within a charcoal box.
 */
.code-block-body :deep(pre) {
  overflow-x: auto;
  padding: 0.875rem 1rem;
  background: transparent !important;
  font-size: 0.75rem;
  line-height: 1.65;
}

.code-block-body :deep(code) {
  font-family: var(--font-mono);
}
</style>