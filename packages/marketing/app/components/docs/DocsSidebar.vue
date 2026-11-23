<script lang="ts" setup>
import type { DocsArea, DocsTreeNode } from "~/utils/docs-tree";

defineProps<{
  tree: DocsTreeNode;
  area: DocsArea;
  currentPath: string;
}>();
</script>

<template>
  <div class="hidden lg:relative lg:block lg:flex-none">
    <div
      class="sticky top-16 -ml-0.5 h-[calc(100vh-4rem)] w-64 overflow-y-auto overflow-x-hidden py-10 pl-0.5 pr-8 xl:w-72 xl:pr-12"
    >
      <!-- The area switcher heads the sidebar: which half of the docs the
           sections below belong to. -->
      <DocsAreaTabs :current="area.key" class="mb-8" />
      <DocsNavTree :tree="tree" :area="area" :current-path="currentPath" />
    </div>
  </div>
</template>