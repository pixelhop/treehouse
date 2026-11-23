<script setup lang="ts">
// The placeholder a document shows while its bytes (or its viewer's code) are
// on the way: a few soft bars shaped like a heading and paragraphs, in the
// spot the text will land, so the page doesn't jump when it arrives.
//
// It stays invisible for the first `delay` ms. Most opens are served from the
// cache or a prefetch and finish well inside that, and a skeleton that blinks
// on and straight off reads as flicker, not as speed.
const props = withDefaults(defineProps<{ delay?: number }>(), { delay: 180 });

const shown = ref(props.delay <= 0);
let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (!shown.value) timer = setTimeout(() => (shown.value = true), props.delay);
});
onBeforeUnmount(() => clearTimeout(timer));

// Line widths, as a fraction of the column: a title, then two ragged paragraphs.
const paragraphs = [
  [100, 96, 98, 72],
  [100, 94, 88, 99, 54],
];
</script>

<template>
  <div role="status" aria-live="polite" :aria-busy="true" class="w-full">
    <span class="sr-only">Loading</span>
    <div
      aria-hidden="true"
      class="th-file-loading space-y-6 transition-opacity duration-300"
      :class="shown ? 'opacity-100' : 'opacity-0'"
    >
      <div class="h-7 w-2/5 rounded-md bg-fg/[0.07]" />
      <div v-for="(lines, p) in paragraphs" :key="p" class="space-y-2.5">
        <div
          v-for="(w, i) in lines"
          :key="i"
          class="h-3.5 rounded bg-fg/[0.06]"
          :style="{ width: `${w}%` }"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A slow breathe rather than a sweeping shimmer: calmer next to a document,
 * and it doesn't pull the eye away from whatever else is on screen. */
.th-file-loading > * {
  animation: th-file-loading-pulse 1.6s ease-in-out infinite;
}
.th-file-loading > *:nth-child(2) {
  animation-delay: 120ms;
}
.th-file-loading > *:nth-child(3) {
  animation-delay: 240ms;
}
@keyframes th-file-loading-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
@media (prefers-reduced-motion: reduce) {
  .th-file-loading > * {
    animation: none;
  }
}
</style>