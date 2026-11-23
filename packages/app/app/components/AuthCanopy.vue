<script setup lang="ts">
import foliageUrl from "design/assets/raster/foliage-overhang.webp";
import logoUrl from "design/assets/logo/treehouse.svg";

// The canopy backdrop for the auth screens: whole leaves hanging over the cream,
// the logo tucked underneath, a card below.
//
// The art is deliberately NOT masked. `foliage-overhang.webp` already tapers on
// its own — its alpha falls from ~80% at the crown to ~5% at the final row — so a
// gradient mask stacks a second, artificial fade on top of a real one, which reads
// as a grey band floating across the page rather than as leaves. The marketing
// hero hangs this same asset unmasked for the same reason; if you find yourself
// reaching for `mask-image` here, that is the bug, not the fix.
//
// ONE copy, full width. Two copies were tried and both failed for the same
// underlying reason — the source's left and right edges cut straight through
// leaves, so any second copy brings a visible edge with it:
//   - mirrored halves: no seam (the join lands on two matching edges) and stays
//     crisp, but the symmetry is obvious and reads as a graphic, not a tree;
//   - overlapping copies at different scales: asymmetric, but the upper copy's
//     hard left edge slices a vertical line through the leaves below it.
// A single copy upscales ~1.4x at desktop widths and softens slightly. On art
// this painterly that is the cheapest of the three costs.
//
// The crop is a negative margin in % — which resolves against the CONTAINER's
// width, not the image's own. They happen to be equal here; they were NOT when
// this was two half-width copies, which is why an early pass cropped twice as
// hard as intended and showed a 60px sliver of leaves.
//
// Removing the canopy is deleting the <img> below; the card and spacing stand on
// their own against plain cream.
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <div
    class="relative flex min-h-screen flex-col items-center overflow-hidden bg-app px-6 pb-16 pt-[11rem] short:pb-8 short:pt-[6.5rem] sm:pt-[13rem] sm:short:pt-[7.5rem]"
  >
    <!-- Corner sprigs, not a ceiling. Spanning the art across the full width forces
         it to render ~1.4x its native size, and at that scale the leaves stop being
         decoration and start being the subject. Two smaller clusters tucked into the
         top corners render at well under native size (crisp), leave the middle of the
         canvas calm, and keep the card the thing you look at.
         Different widths and drops on the two sides (46/32, -13%/-9%): the right
         copy is flipped, but at a different size and height the pair no longer
         reads as a mirror the way two matched halves did. -->
    <img
      :src="foliageUrl"
      alt=""
      aria-hidden="true"
      class="pointer-events-none absolute top-0 left-0 -mt-[13%] w-[46%] max-w-[560px] min-w-[300px] select-none"
    />
    <img
      :src="foliageUrl"
      alt=""
      aria-hidden="true"
      class="pointer-events-none absolute top-0 right-0 -mt-[9%] w-[32%] max-w-[400px] min-w-[210px] -scale-x-100 select-none"
    />
    <!-- Warm light spilling through the leaves. -->
    <div
      class="pointer-events-none absolute inset-0"
      style="background: radial-gradient(70% 45% at 50% 8%, rgba(200, 154, 91, 0.16), transparent)"
    />

    <div class="th-rise relative w-full max-w-[420px]">
      <div class="flex flex-col items-center text-center">
        <img
          :src="logoUrl"
          alt="Treehouse"
          class="h-16 w-16 drop-shadow-sm short:h-12 short:w-12"
        />
        <BetaBadge class="mt-2" />
        <h1
          class="mt-4 font-display text-[34px] leading-[1.1] font-semibold tracking-tight text-fg short:mt-3 short:text-[28px]"
        >
          {{ title }}
        </h1>
        <p v-if="subtitle" class="mt-2 text-[15px] text-fg-muted">{{ subtitle }}</p>
      </div>

      <div
        class="th-grow-in mt-7 rounded-[26px] border border-white/80 bg-surface/85 p-8 shadow-[0_2px_4px_rgba(43,47,51,0.04),0_24px_60px_-20px_rgba(43,47,51,0.22)] backdrop-blur-sm short:mt-5 short:p-6"
      >
        <slot />
      </div>

      <p class="mt-6 text-center text-[14px] text-fg-muted short:mt-4">
        <slot name="footer" />
      </p>
    </div>
  </div>
</template>