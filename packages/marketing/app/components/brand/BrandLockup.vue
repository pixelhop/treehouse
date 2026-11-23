<script setup lang="ts">
import treehouseLogo from "design/assets/logo/treehouse.svg";

// Lockup: the treehouse illustration + Fraunces wordmark.
// `size` is the illustration height in px. `beta` adds the beta tag after the
// wordmark — site chrome only; the reference lockup on /brand stays bare. Hidden
// below `sm`: on a 375px phone it pushes the header's CTA onto two lines and the
// menu button off-screen. The footer carries it at every width.
withDefaults(defineProps<{ size?: number; beta?: boolean }>(), { size: 44, beta: false });
</script>

<template>
  <span class="inline-flex items-center gap-1.5">
    <img
      :src="treehouseLogo"
      alt=""
      class="shrink-0"
      :style="{ height: `${size}px`, width: `${size}px` }"
    />
    <span class="wordmark text-leaf-deep" :style="{ fontSize: `${size * 0.58}px` }">Treehouse</span>
    <BetaBadge v-if="beta" class="ml-1 max-sm:hidden" />
  </span>
</template>