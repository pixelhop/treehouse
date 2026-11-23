<script lang="ts" setup>
import type { DocsNavItem } from "./DocsNavSection.vue";

// A page in a DocsNavSection, with its own sub-pages one level down.
defineProps<{ page: DocsNavItem }>();

const base = "relative block w-full py-0.5 pl-4 -ml-px border-l transition-colors";
const idle = "border-transparent text-fg-muted hover:border-fg-subtle hover:text-fg";
const current = "border-primary font-semibold text-primary";
</script>

<template>
  <li>
    <NuxtLink
      :to="page.path"
      :class="[base, page.current ? current : idle]"
      :aria-current="page.current ? 'page' : undefined"
      >{{ page.label }}</NuxtLink
    >
    <ul v-if="page.children.length" role="list" class="mt-1.5 space-y-1.5 pl-3">
      <li v-for="sub in page.children" :key="sub.path">
        <NuxtLink
          :to="sub.path"
          :class="[base, sub.current ? current : idle]"
          :aria-current="sub.current ? 'page' : undefined"
          >{{ sub.label }}</NuxtLink
        >
      </li>
    </ul>
  </li>
</template>