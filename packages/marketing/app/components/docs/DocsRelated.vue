<script lang="ts" setup>
import type { DocsLink } from "~/utils/docs-tree";

defineProps<{
  links: DocsLink[];
}>();
</script>

<template>
  <section v-if="links.length" aria-labelledby="docs-related-title" class="mt-12">
    <h2 id="docs-related-title" class="text-xl font-semibold text-fg">Related</h2>
    <ul role="list" class="mt-4 space-y-4">
      <li v-for="link in links" :key="link.path">
        <NuxtLink :to="link.path" class="font-semibold text-primary hover:text-primary-hover">{{
          link.title
        }}</NuxtLink>
        <p v-if="link.description" class="mt-0.5 text-sm text-fg-muted">
          {{ link.description }}
        </p>
      </li>
    </ul>
  </section>
</template>