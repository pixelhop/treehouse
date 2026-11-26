<script lang="ts" setup>
// ::demo-video{src poster caption} - a short, silent screen recording in a page,
// framed like the screenshots. It plays on a loop while it's on screen, like a
// GIF, and pauses when it scrolls away. With reduced motion it waits on its
// poster with the player controls instead. The markdown twin
// (server/utils/docs-markdown.ts) renders the poster and a link to the video.
const props = defineProps<{
  src: string;
  poster?: string;
  caption?: string;
}>();

const video = ref<HTMLVideoElement>();
const controls = ref(false);

onMounted(() => {
  const el = video.value;
  if (!el) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    controls.value = true;
    return;
  }
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) el.play().catch(() => (controls.value = true));
      else el.pause();
    },
    { threshold: 0.4 },
  );
  observer.observe(el);
  onBeforeUnmount(() => observer.disconnect());
});
</script>

<template>
  <figure class="docs-video not-prose my-7">
    <video
      ref="video"
      :src="props.src"
      :poster="props.poster"
      :controls="controls"
      :aria-label="props.caption"
      muted
      loop
      playsinline
      preload="none"
      class="block w-full rounded-xl border border-border bg-surface shadow-md"
    />
    <figcaption v-if="props.caption" class="mt-2.5 text-center text-sm text-fg-subtle">
      {{ props.caption }}
    </figcaption>
  </figure>
</template>