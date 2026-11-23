<script setup lang="ts">
// The header's panel below lg, where the dropdowns would have nowhere to open.
// Groups are laid out in full, because a phone menu has room to scroll and
// nothing should be two taps away.
import { isNavGroup, type SiteNavEntry, type SiteNavLink } from "~/utils/siteNav";

const props = defineProps<{ nav: SiteNavEntry[]; signInUrl: string }>();
defineEmits<{ navigate: [] }>();

const groups = computed(() => props.nav.filter(isNavGroup));
const links = computed(() => props.nav.filter((entry) => !isNavGroup(entry)));

const linkClass =
  "flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-fg-muted transition-colors hover:bg-mist hover:text-fg";
</script>

<template>
  <nav
    aria-label="Main"
    class="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-border/70 bg-canvas lg:hidden"
  >
    <div class="mx-auto w-full max-w-7xl px-6 py-3">
      <template v-for="group in groups" :key="group.label">
        <p class="label-eyebrow px-2 pb-1 pt-3">{{ group.label }}</p>
        <NuxtLink
          v-for="link in group.links"
          :key="link.to"
          :to="link.to"
          :class="linkClass"
          @click="$emit('navigate')"
          >{{ link.label }}</NuxtLink
        >
      </template>
      <div class="mt-2 border-t border-border/70 pt-2">
        <NuxtLink
          v-for="link in links"
          :key="link.label"
          :to="(link as SiteNavLink).to"
          :class="linkClass"
          @click="$emit('navigate')"
          >{{ link.label }}</NuxtLink
        >
      </div>
      <div class="mt-2 flex items-center gap-2 border-t border-border/70 pt-2">
        <a :href="signInUrl" :class="[linkClass, 'flex-1']">Log in</a>
        <SiteGithubLink :class="[linkClass, 'gap-2']" icon-class="size-5">GitHub</SiteGithubLink>
      </div>
    </div>
  </nav>
</template>