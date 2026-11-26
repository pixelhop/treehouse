<script lang="ts" setup>
// ::demo-video{src poster caption} - a short, silent screen recording in a page,
// framed like the screenshots. It plays on a loop while it's on screen, like a
// GIF, and pauses when it scrolls away. A button pauses it for good (it stays
// paused when it scrolls back into view). With reduced motion it waits on its
// poster with the player controls instead. The markdown twin
// (server/utils/docs-markdown.ts) renders the poster and a link to the video.
import IconPause from "~icons/solar/pause-bold";
import IconPlay from "~icons/solar/play-bold";

const props = defineProps<{
  src: string;
  poster?: string;
  caption?: string;
}>();

const video = ref<HTMLVideoElement>();
const controls = ref(false);
const playing = ref(false);
const pausedByReader = ref(false);

function toggle() {
  const el = video.value;
  if (!el) return;
  if (playing.value) {
    pausedByReader.value = true;
    el.pause();
  } else {
    pausedByReader.value = false;
    el.play().catch(() => (controls.value = true));
  }
}

onMounted(() => {
  const el = video.value;
  if (!el) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    controls.value = true;
    return;
  }
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting && !pausedByReader.value) {
        el.play().catch(() => (controls.value = true));
      } else {
        el.pause();
      }
    },
    { threshold: 0.4 },
  );
  observer.observe(el);
  onBeforeUnmount(() => observer.disconnect());
});
</script>

<template>
  <figure class="docs-video not-prose my-7">
    <div class="relative">
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
        @play="playing = true"
        @pause="playing = false"
      />
      <button
        v-if="!controls"
        type="button"
        :aria-label="playing ? 'Pause video' : 'Play video'"
        class="absolute bottom-3 right-3 flex size-9 items-center justify-center rounded-full bg-surface/90 text-fg shadow-sm ring-1 ring-border transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        @click="toggle"
      >
        <IconPause v-if="playing" aria-hidden="true" class="size-4" />
        <IconPlay v-else aria-hidden="true" class="size-4" />
      </button>
    </div>
    <figcaption v-if="props.caption" class="mt-2.5 text-center text-sm text-fg-subtle">
      {{ props.caption }}
    </figcaption>
  </figure>
</template>