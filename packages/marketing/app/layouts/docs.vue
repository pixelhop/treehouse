<script lang="ts" setup>
import {
  DOCS_TITLE_SUFFIX,
  buildDocsTree,
  docsAreaForPath,
  docsAreaTree,
  normalizeDocsPath,
} from "~/utils/docs-tree";

useHead({
  titleTemplate: `%s${DOCS_TITLE_SUFFIX}`,
  htmlAttrs: { lang: "en-GB" },
});

// Sidebar tree from every docs page's metadata (sections ordered by hub
// `position`, pages by `position`, public pages only). Runs at build time under
// prerendering, so no runtime content database is needed on Workers.
const { data: pages } = await useDocsIndex();
const tree = computed(() => buildDocsTree(pages.value ?? []));

const route = useRoute();
const currentPath = computed(() => normalizeDocsPath(route.path));

// The docs are split into areas (Docs | Agents), each with its own sidebar
// headed by the area switcher. The area follows from the page's top-level
// section.
const area = computed(() => docsAreaForPath(currentPath.value));
const areaTree = computed(() => docsAreaTree(tree.value, area.value));

const appUrl = useRuntimeConfig().public.appUrl;
</script>

<template>
  <div class="min-h-screen">
    <header class="sticky top-0 z-40 border-b border-border/70 bg-canvas/90 backdrop-blur-sm">
      <div
        class="mx-auto flex h-16 w-full max-w-[90rem] items-center justify-between gap-4 px-4 sm:px-6"
      >
        <div class="flex items-center gap-2">
          <div class="lg:hidden">
            <DocsNavigationMobile :tree="areaTree" :area="area" :current-path="currentPath" />
          </div>
          <NuxtLink to="/" class="transition-opacity hover:opacity-80" aria-label="Treehouse home">
            <BrandLockup :size="38" beta />
          </NuxtLink>
          <NuxtLink
            to="/docs"
            class="ml-1 hidden rounded-full bg-mist px-2.5 py-0.5 text-xs font-bold uppercase tracking-[0.14em] text-leaf-deep sm:inline-flex"
            >Docs</NuxtLink
          >
        </div>

        <div class="flex items-center gap-2">
          <DocsSearch />
          <a
            :href="`${appUrl}/sign-in`"
            class="hidden rounded-full px-4 py-2 text-sm font-semibold text-fg-muted transition-colors hover:text-fg sm:inline-flex"
            >Log in</a
          >
          <a
            :href="`${appUrl}/sign-up`"
            class="lift hidden rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-fg hover:bg-primary-hover hover:shadow-md sm:inline-flex"
            >Get started</a
          >
        </div>
      </div>
    </header>

    <div class="relative mx-auto flex max-w-[90rem] justify-center sm:px-2 lg:px-6">
      <DocsSidebar :tree="areaTree" :area="area" :current-path="currentPath" />

      <!-- The page renders the article and its "On this page" column, so the
           table of contents is server-rendered from the same data as the body. -->
      <slot />
    </div>

    <ChatLauncher />
  </div>
</template>