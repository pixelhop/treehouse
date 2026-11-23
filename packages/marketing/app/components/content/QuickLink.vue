<script lang="ts" setup>
// ::quick-link{title description href icon} - a card on the docs home and
// hubs. `icon` is a docs section folder name (see utils/docs-icons).
import { DOCS_SECTION_ICONS } from "~/utils/docs-icons";

const props = defineProps<{
  title: string;
  description?: string;
  href: string;
  icon?: string;
}>();

const iconComponent = computed(() => (props.icon ? DOCS_SECTION_ICONS[props.icon] : undefined));
</script>

<template>
  <NuxtLink
    :to="href"
    class="lift-card group relative flex gap-4 rounded-2xl border border-border bg-surface p-5"
  >
    <span
      v-if="iconComponent"
      class="flex size-10 flex-none items-center justify-center rounded-xl bg-mist text-leaf-deep"
    >
      <component :is="iconComponent" aria-hidden="true" class="size-5" />
    </span>
    <span class="min-w-0">
      <span class="block font-semibold text-fg group-hover:text-primary">{{ title }}</span>
      <span v-if="description" class="mt-1 block text-sm leading-relaxed text-fg-muted">{{
        description
      }}</span>
    </span>
  </NuxtLink>
</template>