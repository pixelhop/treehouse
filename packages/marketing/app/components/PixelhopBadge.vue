<script setup lang="ts">
/**
 * The "Made by Pixelhop" badge, matching the one on trawley.ai so it reads the
 * same across Pixelhop's products.
 *
 * Deliberately keeps Pixelhop's own colours (#1C1C1C slab, #E6A19F accent)
 * rather than Treehouse's palette: it is a maker's mark, not part of this
 * product's brand, and it should look identical wherever it appears.
 *
 * The offset accent layer sits behind the slab and shifts a little further on
 * hover. It is transform-only, so it stays off the layout path, and it is
 * neutralised under prefers-reduced-motion along with the site's other motion.
 */
import mascot from "design/assets/logo/pixelhop.svg";
import wordmark from "design/assets/logo/pixelhop-wordmark.svg";
</script>

<template>
  <a
    href="https://pixelhop.io"
    target="_blank"
    rel="noopener noreferrer"
    class="pixelhop-badge group relative inline-block"
    aria-label="Made by Pixelhop"
  >
    <span
      class="pixelhop-badge-shadow absolute inset-0 translate-x-1 translate-y-1 rounded-lg bg-[#E6A19F]"
      aria-hidden="true"
    />
    <span class="relative flex items-center gap-3 rounded-lg bg-[#1C1C1C] px-4 py-3 text-white">
      <img :src="mascot" alt="" aria-hidden="true" class="w-7 shrink-0 select-none" />
      <span class="flex flex-col gap-1.5 leading-none">
        <span class="font-mono text-[10px] uppercase tracking-[0.22em] text-white/60">Made by</span>
        <span class="flex items-end gap-0.5">
          <img :src="wordmark" alt="" aria-hidden="true" class="w-[78px] select-none" />
          <span class="text-base font-bold leading-none text-[#E6A19F]">.</span>
        </span>
      </span>
    </span>
  </a>
</template>

<style scoped>
.pixelhop-badge-shadow {
  transition: translate var(--duration-base) var(--ease-out-soft);
}

/*
 * The full offset, not an increment. Tailwind v4 writes translate-x-1/-y-1 to
 * the `translate` property rather than to `transform`, so this rule replaces
 * the resting 4px outright — the old `2px 2px` pulled the accent layer inward,
 * the opposite of what it looks like it is doing.
 */
.pixelhop-badge:hover .pixelhop-badge-shadow {
  translate: 6px 6px;
}

@media (prefers-reduced-motion: reduce) {
  .pixelhop-badge-shadow {
    transition: none;
  }

  /*
   * Hold the resting offset. `translate: none` collapsed the accent layer flush
   * behind the slab on hover, which is a state change rather than a neutralised
   * animation — reduced motion should remove the movement, not the design.
   */
  .pixelhop-badge:hover .pixelhop-badge-shadow {
    translate: 4px 4px;
  }
}
</style>