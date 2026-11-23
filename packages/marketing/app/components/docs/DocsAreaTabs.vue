<script lang="ts" setup>
import { DOCS_AREAS } from "~/utils/docs-tree";
import { DOCS_AREA_ICONS } from "~/utils/docs-icons";

// The "Docs | Agents" switcher at the top of the sidebar (and of the mobile
// nav drawer). Each option links to its area's home; the current area is
// marked with aria-current. Areas are defined once in utils/docs-tree.
defineProps<{
  current: string;
}>();

const areas = DOCS_AREAS.map((area) => ({ ...area, icon: DOCS_AREA_ICONS[area.key] }));
</script>

<template>
  <nav aria-label="Documentation areas">
    <ul
      role="list"
      class="grid grid-cols-2 gap-1 rounded-full bg-parchment p-1 ring-1 ring-inset ring-border"
    >
      <li v-for="area in areas" :key="area.key">
        <NuxtLink
          :to="area.home"
          :aria-current="area.key === current ? 'true' : undefined"
          :class="[
            'group flex items-center justify-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors',
            area.key === current
              ? 'bg-surface text-fg shadow-sm ring-1 ring-border'
              : 'text-fg-muted hover:text-fg',
          ]"
        >
          <component
            :is="area.icon"
            v-if="area.icon"
            aria-hidden="true"
            :class="[
              'size-4 flex-none',
              area.key === current ? 'text-primary' : 'text-fg-subtle group-hover:text-fg-muted',
            ]"
          />
          {{ area.title }}
        </NuxtLink>
      </li>
    </ul>
  </nav>
</template>