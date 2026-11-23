<script lang="ts" setup>
// The docs navigation for screens below lg: a left drawer with the area
// switcher and the same tree as the desktop sidebar.
import IconMenu from "~icons/solar/hamburger-menu-linear";
import IconClose from "~icons/solar/close-circle-linear";
import type { DocsArea, DocsTreeNode } from "~/utils/docs-tree";

defineProps<{
  tree: DocsTreeNode;
  area: DocsArea;
  currentPath: string;
}>();

const route = useRoute();
const isOpen = ref(false);

watch(
  () => route.path,
  () => (isOpen.value = false),
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") isOpen.value = false;
}
</script>

<template>
  <div>
    <button
      type="button"
      class="-ml-2 inline-flex size-10 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-mist hover:text-fg"
      aria-label="Open docs navigation"
      :aria-expanded="isOpen"
      @click="isOpen = true"
    >
      <IconMenu aria-hidden="true" class="size-6" />
    </button>
    <Teleport to="body">
      <div v-if="isOpen" class="fixed inset-0 z-50 lg:hidden" @keydown="onKeydown">
        <div class="absolute inset-0 bg-charcoal/40 backdrop-blur-sm" @click="isOpen = false" />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Docs navigation"
          class="absolute inset-y-0 left-0 w-full max-w-xs overflow-y-auto bg-canvas px-5 pb-12 pt-5 shadow-lg"
        >
          <div class="mb-6 flex items-center justify-between">
            <NuxtLink to="/" class="transition-opacity hover:opacity-80">
              <BrandLockup :size="36" beta />
            </NuxtLink>
            <button
              type="button"
              class="inline-flex size-10 items-center justify-center rounded-full text-fg-muted hover:bg-mist hover:text-fg"
              aria-label="Close docs navigation"
              @click="isOpen = false"
            >
              <IconClose aria-hidden="true" class="size-6" />
            </button>
          </div>
          <DocsAreaTabs :current="area.key" class="mb-6" />
          <DocsNavTree :tree="tree" :area="area" :current-path="currentPath" />
        </div>
      </div>
    </Teleport>
  </div>
</template>