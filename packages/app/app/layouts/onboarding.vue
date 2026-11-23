<script setup lang="ts">
import logoUrl from "design/assets/logo/treehouse.svg";

// A deliberately chromeless shell for the connect/* steps.
//
// Neither existing layout fits. `app` brings the workspace sidebar — which during
// onboarding shows a workspace the user has not connected yet, next to a file tree
// they cannot use. `default` brings marketing nav that links away mid-flow. Both
// give someone halfway through a two-step flow somewhere else to go.
//
// The mark is the one piece of chrome kept: with everything else stripped, a bare
// form inside the desktop shell has nothing identifying it. It is not a link —
// there is nowhere to go from here that isn't leaving the flow.
//
// No theme watch either: the active workspace's theme is the wrong input here,
// because the point of the flow is that a workspace has not been settled yet. The
// `:root` default (the brand palette) is the right and only answer.
</script>

<template>
  <div class="flex min-h-screen flex-col bg-app text-fg">
    <header class="flex items-center gap-2 px-6 pt-6 sm:px-10">
      <img :src="logoUrl" alt="Treehouse" class="h-8 w-8" />
      <BetaBadge />
    </header>
    <slot />
  </div>
</template>