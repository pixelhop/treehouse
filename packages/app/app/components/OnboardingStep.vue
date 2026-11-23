<script setup lang="ts">
// One shape for every onboarding step, so the flow feels like one thing rather
// than three pages that happen to share a palette.
//
// Two columns: words on the left, an illustration on the right earning the width
// that was previously dead space. The illustration fades into the canvas rather
// than sitting in a hard-cropped rectangle — /design.md's rule for the raster art,
// and the difference between "illustrated" and "a picture stuck on".
//
// Type sizes come from the spec too: Fraunces is reserved for 40px+, so the
// headline is 44px and nothing smaller uses the display face.
defineProps<{
  eyebrow?: string;
  title: string;
  /** Illustration URL. Omit for a text-only step. */
  illustration?: string;
  /** Alt text is empty by design when the art is decorative — the headline
   * already says what the step is, so announcing it twice is noise. */
  illustrationAlt?: string;
}>();
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-8 py-10 sm:py-16">
    <div class="th-grow-in grid gap-10 md:grid-cols-[1.05fr_0.95fr] md:items-center">
      <div>
        <p
          v-if="eyebrow"
          class="th-rise text-[13px] font-semibold tracking-[0.18em] text-accent uppercase"
        >
          {{ eyebrow }}
        </p>
        <h1
          class="th-rise mt-3 font-display text-[44px] leading-[1.05] font-semibold tracking-tight text-fg"
          style="--th-delay: 60ms"
        >
          {{ title }}
        </h1>
        <div
          class="th-rise mt-4 text-[16px] leading-relaxed text-fg-muted"
          style="--th-delay: 120ms"
        >
          <slot name="body" />
        </div>
        <div class="th-rise mt-8" style="--th-delay: 180ms">
          <slot />
        </div>
      </div>

      <div v-if="illustration" class="relative hidden justify-center md:flex">
        <img
          :src="illustration"
          :alt="illustrationAlt ?? ''"
          class="th-sway h-64 w-auto object-contain"
        />
        <!-- Fade into the canvas, never a hard edge. -->
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-app to-transparent"
        />
      </div>
    </div>
  </div>
</template>