<script lang="ts" setup>
import type { DocsRelease } from "~/utils/docs-tree";

// Banner for pages that aren't generally available. Early-access pages are
// public URLs (so reviewers can read them) but unlisted and noindexed;
// unreleased pages only exist on dev and preview builds.
defineProps<{
  release: DocsRelease;
}>();
</script>

<template>
  <div
    v-if="release !== 'public'"
    role="note"
    :class="[
      'mb-8 rounded-2xl p-5 text-sm ring-1',
      release === 'early-access'
        ? 'bg-sky/50 text-fg ring-sky-deep/30'
        : 'bg-wood/15 text-fg ring-wood/40',
    ]"
  >
    <p v-if="release === 'early-access'">
      <strong class="font-semibold">Early access.</strong>
      This feature is being rolled out gradually and may not be in your workspace yet.
    </p>
    <p v-else>
      <strong class="font-semibold">Unreleased.</strong>
      This page documents something that isn't available yet. It is only published on preview
      builds.
    </p>
  </div>
</template>