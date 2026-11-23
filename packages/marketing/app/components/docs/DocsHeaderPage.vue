<script lang="ts" setup>
import type { DocsBreadcrumb } from "~/utils/docs-tree";

const props = defineProps<{
  title: string;
  description?: string | null;
  breadcrumbs: DocsBreadcrumb[];
}>();

// The trail above the title: every ancestor as a link, the page itself as the
// current item. The docs home has no trail.
const trail = computed(() =>
  props.breadcrumbs.length > 1
    ? props.breadcrumbs.map((crumb, index) => ({
        ...crumb,
        current: index === props.breadcrumbs.length - 1,
      }))
    : [],
);
</script>

<template>
  <header class="mb-10">
    <div class="flex items-start justify-between gap-4">
      <nav v-if="trail.length" aria-label="Breadcrumb" class="min-w-0">
        <ol role="list" class="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold">
          <li v-for="crumb in trail" :key="crumb.url" class="flex items-center gap-x-1.5">
            <span v-if="crumb.current" aria-current="page" class="text-fg-subtle">{{
              crumb.name
            }}</span>
            <template v-else>
              <NuxtLink :to="crumb.url" class="text-primary hover:text-primary-hover">{{
                crumb.name
              }}</NuxtLink>
              <span aria-hidden="true" class="text-fg-subtle">/</span>
            </template>
          </li>
        </ol>
      </nav>
      <span v-else />
      <DocsCopyMenu class="shrink-0" />
    </div>
    <h1
      class="mt-3 font-display text-[2.5rem] leading-[1.1] font-semibold tracking-[-0.01em] text-fg"
    >
      {{ title }}
    </h1>
    <p v-if="description" class="mt-4 text-lg leading-relaxed text-fg-muted">
      {{ description }}
    </p>
  </header>
</template>