<script setup lang="ts">
import treehouseLogo from "design/assets/logo/treehouse.svg";
import footerScene from "design/assets/raster/footer-meadow.webp";
import { FOOTER_PRODUCT } from "~/utils/siteNav";
import { sidekickJoinUrl, type SidekickConfig } from "~/plugins/sidekick.client";

const GITHUB_URL = "https://github.com/pixelhop/treehouse";

// The affiliate programme's join page on Sidekick, when one is configured.
const affiliateJoinUrl = sidekickJoinUrl(useRuntimeConfig().public.sidekick as SidekickConfig);

const footerResources = [
  { label: "Documentation", to: "/docs" },
  { label: "Agent handbook", to: "/docs/agents/handbook" },
  { label: "Compare Treehouse", to: "/compare" },
  { label: "Obsidian and Claude Code for teams", to: "/guides/obsidian-and-claude-code-for-teams" },
  { label: "Self-hosted Obsidian sync", to: "/guides/self-hosted-obsidian-sync" },
  { label: "Open-source Notion alternatives", to: "/guides/open-source-notion-alternatives" },
  { label: "An AI second brain for teams", to: "/guides/ai-second-brain-for-teams" },
  { label: "GitHub", to: GITHUB_URL, external: true },
  { label: "Brand & design system", to: "/brand" },
  ...(affiliateJoinUrl
    ? [{ label: "Affiliate programme", to: affiliateJoinUrl, external: true }]
    : []),
];
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <SiteHeader />

    <main class="flex-1">
      <slot />
    </main>

    <!--
      The page resolves into a landscape rather than stopping at a border. The
      scene is full-bleed and dissolves upward into the cream canvas, and the
      footer panel is pulled up over its lower half with a rounded top edge, so
      the content sits under the horizon instead of after it.
    -->
    <footer class="relative isolate">
      <!--
        Spans the whole footer, not just the artwork. The panel over it is
        translucent, so wherever the scene stopped short you could see the join —
        a hard line across the footer with nothing behind the glass below it.

        Below the meadow the box continues in #758B55, sampled from the
        artwork's own bottom edge, so grass runs into flat colour with no seam.
        It is only ever read through 85% parchment and a blur, which is why a
        flat fill is enough.
      -->
      <div
        class="footer-scene pointer-events-none absolute inset-0 -z-10 select-none overflow-hidden bg-[#758B55]"
        aria-hidden="true"
      >
        <img
          :src="footerScene"
          alt=""
          class="h-[22rem] w-full object-cover object-bottom sm:h-[26rem] lg:h-[30rem]"
        />
      </div>

      <div
        class="relative mt-[14rem] rounded-t-[2rem] border-t border-border/70 bg-parchment/85 backdrop-blur-sm sm:mt-[17rem] lg:mt-[20rem] lg:rounded-t-[2.5rem]"
      >
        <div class="mx-auto w-full max-w-7xl px-6 py-14">
          <div class="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr]">
            <!-- Brand -->
            <div>
              <div class="flex items-center gap-2">
                <img :src="treehouseLogo" alt="" class="size-11" />
                <span class="wordmark text-2xl text-leaf-deep">Treehouse</span>
                <BetaBadge class="ml-1" />
              </div>
              <p class="mt-3 max-w-xs text-sm leading-relaxed text-fg-muted">
                A home for humans and agents — the open-source shared file workspace.
              </p>
              <SiteGithubLink
                class="mt-4 inline-flex rounded-full border border-border bg-surface p-2.5 text-fg-muted transition-colors hover:bg-mist hover:text-fg"
                icon-class="size-4"
                aria-label="Treehouse on GitHub"
              />
            </div>

            <!-- Product -->
            <div>
              <h3 class="label-eyebrow mb-4">Product</h3>
              <ul class="space-y-2.5 text-sm font-semibold">
                <li v-for="l in FOOTER_PRODUCT" :key="l.label">
                  <NuxtLink :to="l.to" class="text-fg-muted transition-colors hover:text-fg">{{
                    l.label
                  }}</NuxtLink>
                </li>
              </ul>
            </div>

            <!-- Resources -->
            <div>
              <h3 class="label-eyebrow mb-4">Resources</h3>
              <ul class="space-y-2.5 text-sm font-semibold">
                <li v-for="l in footerResources" :key="l.label">
                  <a
                    v-if="l.external"
                    :href="l.to"
                    class="text-fg-muted transition-colors hover:text-fg"
                    >{{ l.label }}</a
                  >
                  <NuxtLink
                    v-else
                    :to="l.to"
                    class="text-fg-muted transition-colors hover:text-fg"
                    >{{ l.label }}</NuxtLink
                  >
                </li>
              </ul>
            </div>
          </div>

          <div
            class="mt-12 flex flex-col items-start justify-between gap-3 border-t border-border/70 pt-6 sm:flex-row sm:items-center"
          >
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
              <p class="text-sm text-fg-subtle">© {{ new Date().getFullYear() }} Treehouse</p>
              <p class="text-sm text-fg-subtle">Where great work grows.</p>
            </div>
            <PixelhopBadge />
          </div>
        </div>
      </div>
    </footer>

    <!-- Analytics consent. Renders nothing at all when PostHog is not
         configured, and nothing once the visitor has answered. -->
    <CookieBanner />

    <ChatLauncher />
  </div>
</template>