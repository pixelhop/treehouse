<script setup lang="ts">
// A page's signup call to action: a card near the top, a closing band at the
// end. The wording comes from the page's frontmatter, so it can speak to that
// page's reader. See utils/landing.ts for how the link is measured.
import treehouseLogo from "design/assets/logo/treehouse.svg";
import { signupCampaign, signupHref, type LandingCta, type SignupPlacement } from "~/utils/landing";

const props = defineProps<{
  cta: LandingCta;
  path: string;
  placement: Extract<SignupPlacement, "hero" | "end">;
}>();

const appUrl = useRuntimeConfig().public.appUrl;
const href = computed(() => signupHref(appUrl, props.path, props.placement));
// Autocapture's label for visitors who accepted analytics on this site.
const captureLabel = computed(() => `${signupCampaign(props.path)}:${props.placement}`);
</script>

<template>
  <aside
    v-if="placement === 'hero'"
    class="rounded-2xl border border-sage/60 bg-mist/60 p-6 sm:flex sm:items-center sm:justify-between sm:gap-8"
  >
    <div class="min-w-0">
      <h2 class="text-lg font-bold text-leaf-deep">{{ cta.heading }}</h2>
      <p class="mt-1.5 text-[0.9375rem] leading-relaxed text-fg-muted">{{ cta.body }}</p>
      <p v-if="cta.note" class="mt-2 text-sm text-fg-subtle">{{ cta.note }}</p>
    </div>
    <a
      :href="href"
      :data-ph-capture-attribute-cta="captureLabel"
      class="lift mt-5 inline-flex shrink-0 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover hover:shadow-md sm:mt-0"
      >{{ cta.label }}</a
    >
  </aside>

  <section v-else class="relative overflow-hidden border-t border-border/70">
    <div class="mx-auto w-full max-w-7xl px-6 pb-20 pt-16 text-center md:pb-24 md:pt-20">
      <img :src="treehouseLogo" alt="" class="mx-auto mb-7 w-28" />
      <h2 class="font-display type-headline mx-auto max-w-2xl font-semibold">{{ cta.heading }}</h2>
      <p class="mx-auto mt-5 max-w-lg text-lg leading-relaxed text-fg-muted">{{ cta.body }}</p>
      <div class="mt-8">
        <a
          :href="href"
          :data-ph-capture-attribute-cta="captureLabel"
          class="lift inline-flex rounded-full bg-primary px-7 py-3.5 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover hover:shadow-md"
          >{{ cta.label }}</a
        >
      </div>
      <p v-if="cta.note" class="mx-auto mt-4 max-w-md text-sm text-fg-subtle">{{ cta.note }}</p>
    </div>
  </section>
</template>