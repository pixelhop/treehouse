<script lang="ts" setup>
// The hub. Lists whatever is in content/pages, so adding a comparison or guide
// needs no change here.
import { useLandingHead } from "~/composables/landing";
import {
  LANDING_META_FIELDS,
  formatCheckedDate,
  hubJsonLd,
  type LandingCta,
  type LandingPageMeta,
} from "~/utils/landing";

const { data } = await useAsyncData("landing.index", () =>
  queryCollection("pages")
    .select(...LANDING_META_FIELDS)
    .order("position", "ASC")
    .all(),
);

const pages = computed(() => (data.value ?? []) as LandingPageMeta[]);
const sections = computed(() => [
  { title: "Comparisons", pages: pages.value.filter((page) => page.kind === "comparison") },
  { title: "Guides", pages: pages.value.filter((page) => page.kind === "guide") },
]);

const heroCta: LandingCta = {
  heading: "Try it with your own files",
  body: "Make a workspace, connect a folder and invite an agent. It takes a few minutes.",
  label: "Get started for free",
  note: "Free for one person. Teams start on Grove.",
};

const endCta: LandingCta = {
  heading: "Still weighing it up? Try it on a real folder.",
  body: "The quickest way to know if Treehouse fits is to point it at some files you already have.",
  label: "Get started for free",
  note: "Free for one person. Teams start on Grove.",
};

const description =
  "How Treehouse compares with Obsidian, Notion and Fastio for teams working with AI agents, including where the other product is the better choice.";

useLandingHead({
  title: "Compare Treehouse with Obsidian, Notion and Fastio",
  description,
  path: "/compare",
  jsonLd: hubJsonLd(pages.value, useRuntimeConfig().public.siteUrl),
});
</script>

<template>
  <div>
    <div class="mx-auto w-full max-w-3xl px-6 pb-16 pt-12 md:pt-16">
      <p class="label-eyebrow">Compare</p>
      <h1 class="font-display type-headline mt-3 font-semibold text-leaf-deep">
        Honest comparisons, including where we lose
      </h1>
      <p class="mt-5 text-lg leading-relaxed text-fg-muted">
        Treehouse is a shared workspace of plain files for people and their agents. It suits some
        teams better than the tools below, and some teams worse. Each page says which.
      </p>

      <SignupCta :cta="heroCta" path="/compare" placement="hero" class="mt-8" />

      <template v-for="section in sections" :key="section.title">
        <h2 class="mt-12 text-2xl font-bold text-fg">{{ section.title }}</h2>
        <ul class="mt-5 grid gap-4">
          <li v-for="page in section.pages" :key="page.path">
            <NuxtLink
              :to="page.path"
              class="lift-card block rounded-2xl border border-border bg-surface p-6"
            >
              <p class="label-eyebrow">{{ page.eyebrow }}</p>
              <p class="mt-2 text-lg font-bold text-fg">{{ page.cardTitle }}</p>
              <p class="mt-1.5 text-[0.9375rem] leading-relaxed text-fg-muted">
                {{ page.description }}
              </p>
              <p class="mt-3 text-sm text-fg-subtle">
                Last checked {{ formatCheckedDate(page.lastChecked) }}
              </p>
            </NuxtLink>
          </li>
        </ul>
      </template>
    </div>

    <SignupCta :cta="endCta" path="/compare" placement="end" />
  </div>
</template>