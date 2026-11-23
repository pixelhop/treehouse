<script lang="ts">
import type { Component } from "vue";

export interface DocsNavItem {
  path: string;
  label: string;
  current: boolean;
  children: DocsNavItem[];
}

/** One section of the docs nav, with its display state resolved by DocsNavTree. */
export interface DocsNavSectionView extends DocsNavItem {
  /** Section icon (utils/docs-icons), if the section has one. */
  icon?: Component;
  /** Whether the page being read is in this section (highlights the icon). */
  inSection: boolean;
  /** Whether the chevron toggle is shown (collapsible area with pages). */
  toggleable: boolean;
  expanded: boolean;
  /** Id of the page list, for the toggle's aria-controls. */
  listId: string;
}
</script>

<script lang="ts" setup>
import IconChevron from "~icons/solar/alt-arrow-right-linear";

// One section of DocsNavTree: its hub link, the expand/collapse toggle and its
// page list.
defineProps<{ section: DocsNavSectionView }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <li>
    <div class="flex items-center justify-between gap-2">
      <NuxtLink
        :to="section.path"
        :aria-current="section.current ? 'page' : undefined"
        :class="[
          'group flex min-w-0 items-center gap-2.5 font-semibold transition-colors',
          section.current ? 'text-primary' : 'text-fg hover:text-primary',
        ]"
      >
        <component
          :is="section.icon"
          v-if="section.icon"
          aria-hidden="true"
          :class="[
            'size-[1.125rem] flex-none transition-colors',
            section.inSection ? 'text-primary' : 'text-fg-subtle group-hover:text-primary',
          ]"
        />
        <span>{{ section.label }}</span>
      </NuxtLink>
      <button
        v-if="section.toggleable"
        type="button"
        class="-mr-1 flex size-7 flex-none items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-mist hover:text-fg"
        :aria-expanded="section.expanded"
        :aria-controls="section.listId"
        :aria-label="`${section.label} pages`"
        @click="emit('toggle')"
      >
        <IconChevron
          aria-hidden="true"
          :class="['size-4 transition-transform', section.expanded ? 'rotate-90' : '']"
        />
      </button>
    </div>
    <ul
      v-if="section.children.length"
      v-show="section.expanded"
      :id="section.listId"
      role="list"
      :class="[
        'mt-2.5 space-y-2 border-l border-border lg:space-y-2.5',
        section.icon ? 'ml-[8px]' : '',
      ]"
    >
      <DocsNavPage v-for="page in section.children" :key="page.path" :page="page" />
    </ul>
  </li>
</template>