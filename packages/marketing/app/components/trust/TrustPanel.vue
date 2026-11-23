<script setup lang="ts">
/**
 * The trust section: a deep-green slab that gives the page a moment of tonal
 * weight between two cream bands.
 *
 * The tree straddles the slab's top edge — canopy in the light, roots below the
 * surface — so the picture makes the same claim the copy does: that the
 * guarantee is structural rather than a policy.
 *
 * Two things keep that alignment stable:
 *
 *  - The art is anchored to the slab, not to the section container, so its
 *    offset and the section's padding stay independent. Otherwise every
 *    padding change silently drags the soil line off the edge.
 *  - It sits outside the slab, which clips, so the canopy is not cut — and
 *    above it in z-order, so the roots read as being under the surface.
 *
 * The soil line is 61% down the art; -64% lifts the grass just clear of the
 * edge, so the slab reads as ground the tree stands on rather than a box the
 * art is glued to. Headroom for the canopy is reserved only at the breakpoints
 * where the art is shown, so small screens keep their normal rhythm.
 */
import { trustArt, trustHeading, trustPoints } from "~/composables/useTrustContent";
</script>

<template>
  <section class="relative border-b border-border/70">
    <div
      class="relative mx-auto w-full max-w-7xl px-6 pb-16 pt-16 md:pb-24 md:pt-24 lg:pt-[19rem] xl:pt-[22rem]"
    >
      <div class="relative">
        <img
          :src="trustArt"
          alt=""
          aria-hidden="true"
          class="pointer-events-none absolute right-6 top-0 z-10 hidden h-[26rem] max-w-none -translate-y-[64%] select-none object-contain lg:block xl:right-16 xl:h-[30rem]"
        />

        <div
          class="relative overflow-hidden rounded-[2rem] bg-leaf-deep px-7 py-12 shadow-lg md:px-12 md:py-16"
        >
          <div class="mb-12 max-w-2xl lg:max-w-lg">
            <p class="label-eyebrow label-eyebrow-on-dark mb-3">{{ trustHeading.eyebrow }}</p>
            <h2 class="font-display type-headline mb-4 font-semibold text-cream">
              {{ trustHeading.title }}
            </h2>
            <p class="text-lg leading-relaxed text-cream/75">{{ trustHeading.lede }}</p>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <div
              v-for="p in trustPoints"
              :key="p.id"
              class="min-w-0 rounded-2xl bg-cream/[0.07] p-6 ring-1 ring-cream/10"
            >
              <h3 class="text-base font-bold text-cream">{{ p.title }}</h3>
              <p class="mt-2 text-sm leading-relaxed text-cream/70">{{ p.body }}</p>
              <div class="mt-5"><TrustDemo :id="p.id" compact /></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>