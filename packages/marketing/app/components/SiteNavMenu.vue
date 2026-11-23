<script setup lang="ts">
// One dropdown in the site header. A button that shows a list of links rather
// than an ARIA menu, because these are ordinary navigation. It behaves like
// DocsCopyMenu: click to open, Escape or a click outside to close. The panel is
// hidden rather than removed, so prerendered pages keep these links for crawlers.
import IconChevron from "~icons/solar/alt-arrow-down-linear";
import type { SiteNavGroup } from "~/utils/siteNav";

defineProps<{ group: SiteNavGroup }>();

const { open, root, trigger, close, onKeydown } = useDismissible();
const panelId = useId();

const route = useRoute();
watch(() => route.fullPath, close);
</script>

<template>
  <div ref="root" class="relative" @keydown="onKeydown">
    <button
      ref="trigger"
      type="button"
      class="inline-flex items-center gap-1 text-fg-muted transition-colors hover:text-fg"
      :class="{ 'text-fg': open }"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="open = !open"
    >
      {{ group.label }}
      <IconChevron
        aria-hidden="true"
        :class="['size-3.5 transition-transform', open ? 'rotate-180' : '']"
      />
    </button>

    <div
      v-show="open"
      :id="panelId"
      class="absolute left-0 top-full z-50 mt-5 w-80 rounded-2xl border border-border bg-surface p-2 shadow-md"
    >
      <ul>
        <li v-for="link in group.links" :key="link.to">
          <NuxtLink
            :to="link.to"
            class="block rounded-xl px-3 py-2.5 transition-colors hover:bg-mist"
            @click="close"
          >
            <span class="block font-semibold text-fg">{{ link.label }}</span>
            <span v-if="link.description" class="block font-normal text-fg-muted">{{
              link.description
            }}</span>
          </NuxtLink>
        </li>
      </ul>
      <template v-if="group.footer">
        <div class="mx-3 my-1 border-t border-border/70" />
        <NuxtLink
          :to="group.footer.to"
          class="block rounded-xl px-3 py-2.5 text-primary transition-colors hover:bg-mist"
          @click="close"
          >{{ group.footer.label }}</NuxtLink
        >
      </template>
    </div>
  </div>
</template>