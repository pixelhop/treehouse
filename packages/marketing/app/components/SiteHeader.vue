<script setup lang="ts">
import { isLandingPath, signupHref } from "~/utils/landing";
import { isNavGroup, siteNavFor } from "~/utils/siteNav";

const appUrl = useRuntimeConfig().public.appUrl;
const signInUrl = `${appUrl}/sign-in`;

const route = useRoute();
const nav = computed(() => siteNavFor(route.path));

// The header button counts as a signup from the page it's on.
const signUpUrl = computed(() =>
  isLandingPath(route.path) ? signupHref(appUrl, route.path, "nav") : `${appUrl}/sign-up`,
);

// Below lg the nav collapses into this panel — without it the links are
// simply unreachable on phones and tablets.
const menuOpen = ref(false);
watch(
  () => route.fullPath,
  () => (menuOpen.value = false),
);
</script>

<template>
  <header class="sticky top-0 z-40 border-b border-border/70 bg-canvas/90 backdrop-blur-sm">
    <div class="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
      <div class="flex items-center gap-10">
        <NuxtLink to="/" class="transition-opacity hover:opacity-80">
          <BrandLockup :size="42" beta />
        </NuxtLink>
        <nav aria-label="Main" class="hidden items-center gap-7 text-sm font-semibold lg:flex">
          <template v-for="entry in nav" :key="entry.label">
            <SiteNavMenu v-if="isNavGroup(entry)" :group="entry" />
            <NuxtLink v-else :to="entry.to" class="text-fg-muted transition-colors hover:text-fg">{{
              entry.label
            }}</NuxtLink>
          </template>
        </nav>
      </div>
      <div class="flex items-center gap-2.5">
        <SiteGithubLink
          class="hidden rounded-full p-2 text-fg-muted transition-colors hover:bg-mist hover:text-fg sm:inline-flex"
          icon-class="size-5"
          aria-label="Treehouse on GitHub"
        />
        <a
          :href="signInUrl"
          class="hidden rounded-full px-4 py-2 text-sm font-semibold text-fg-muted transition-colors hover:text-fg sm:inline-flex"
          >Log in</a
        >
        <a
          :href="signUpUrl"
          class="lift rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-fg hover:bg-primary-hover hover:shadow-md"
          >Get started</a
        >
        <button
          type="button"
          class="-mr-2 inline-flex size-11 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-mist hover:text-fg lg:hidden"
          :aria-expanded="menuOpen"
          aria-controls="mobile-nav"
          :aria-label="menuOpen ? 'Close menu' : 'Open menu'"
          @click="menuOpen = !menuOpen"
        >
          <svg
            viewBox="0 0 24 24"
            class="size-6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <template v-if="menuOpen">
              <path d="M6 6l12 12M18 6L6 18" />
            </template>
            <template v-else>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </template>
          </svg>
        </button>
      </div>
    </div>

    <!-- Collapsed nav for < lg. -->
    <SiteMobileNav
      v-show="menuOpen"
      id="mobile-nav"
      :nav="nav"
      :sign-in-url="signInUrl"
      @navigate="menuOpen = false"
    />
  </header>
</template>