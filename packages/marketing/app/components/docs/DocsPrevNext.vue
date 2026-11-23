<script lang="ts" setup>
import IconLeft from "~icons/solar/arrow-left-linear";
import IconRight from "~icons/solar/arrow-right-linear";
import type { DocsTreeNode } from "~/utils/docs-tree";

defineProps<{
  prev: DocsTreeNode | null;
  next: DocsTreeNode | null;
}>();
</script>

<template>
  <nav
    v-if="prev || next"
    aria-label="Previous and next pages"
    class="mt-12 grid grid-cols-2 gap-4 border-t border-border pt-6"
  >
    <div>
      <NuxtLink
        v-if="prev"
        :to="prev.path"
        class="group inline-flex flex-col gap-1 text-sm font-semibold text-fg hover:text-primary"
      >
        <span class="label-eyebrow inline-flex items-center gap-1.5 text-fg-subtle!">
          <IconLeft aria-hidden="true" class="size-3.5" /> Previous
        </span>
        <span>{{ prev.label }}</span>
      </NuxtLink>
    </div>
    <div class="text-right">
      <NuxtLink
        v-if="next"
        :to="next.path"
        class="group inline-flex flex-col items-end gap-1 text-sm font-semibold text-fg hover:text-primary"
      >
        <span class="label-eyebrow inline-flex items-center gap-1.5 text-fg-subtle!">
          Next <IconRight aria-hidden="true" class="size-3.5" />
        </span>
        <span>{{ next.label }}</span>
      </NuxtLink>
    </div>
  </nav>
</template>