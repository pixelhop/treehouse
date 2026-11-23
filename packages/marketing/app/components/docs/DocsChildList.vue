<script lang="ts" setup>
import type { DocsTreeNode } from "~/utils/docs-tree";

// A hub's automatic list of its public child pages and sub-section hubs, in
// sidebar order, with descriptions. Hub markdown only carries the intro.
defineProps<{
  items: DocsTreeNode[];
}>();
</script>

<template>
  <section v-if="items.length" aria-labelledby="docs-children-title" class="mt-12">
    <h2 id="docs-children-title" class="text-xl font-semibold text-fg">In this section</h2>
    <ul role="list" class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <li v-for="item in items" :key="item.path">
        <NuxtLink
          :to="item.path"
          class="lift-card group block h-full rounded-xl border border-border bg-surface p-5"
        >
          <span class="block font-semibold text-fg group-hover:text-primary">{{ item.title }}</span>
          <span v-if="item.description" class="mt-1 block text-sm leading-relaxed text-fg-muted">{{
            item.description
          }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>