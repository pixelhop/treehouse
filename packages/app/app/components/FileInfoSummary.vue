<script setup lang="ts">
import IconCopy from "~icons/solar/copy-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import { initials } from "~/utils/activity";

// The first thing the Info tab says: who touched this file last, and when. That is
// the question the panel is opened to answer; size and type are not.
defineProps<{
  /** Null until the file's history has loaded. */
  summary: {
    primary: string;
    secondary: string;
    /** Exact timestamp, for the hover title. */
    title: string;
    actor: { name: string; isAgent: boolean } | null;
  } | null;
  downloadUrl: string;
  fileName: string;
  copied: boolean;
}>();
defineEmits<{ copy: [] }>();
</script>

<template>
  <div class="flex items-center gap-2.5">
    <span
      v-if="summary?.actor"
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      :class="summary.actor.isAgent ? 'bg-agent/15 text-agent' : 'bg-human/15 text-human'"
      >{{ initials(summary.actor.name) }}</span
    >
    <div v-if="summary" class="min-w-0 flex-1" :title="summary.title">
      <p class="truncate text-sm font-medium text-fg">{{ summary.primary }}</p>
      <p class="truncate text-xs text-fg-subtle">{{ summary.secondary }}</p>
    </div>
    <div v-else class="min-w-0 flex-1 space-y-1.5">
      <div class="h-3.5 w-28 animate-pulse rounded bg-surface-2" />
      <div class="h-3 w-20 animate-pulse rounded bg-surface-2" />
    </div>
    <button
      type="button"
      class="panel-icon-btn"
      :title="copied ? 'Copied' : 'Copy path'"
      :aria-label="copied ? 'Copied' : 'Copy path'"
      @click="$emit('copy')"
    >
      <IconCheck v-if="copied" class="h-4 w-4 text-success" />
      <IconCopy v-else class="h-4 w-4" />
    </button>
    <a
      :href="downloadUrl"
      :download="fileName"
      class="panel-icon-btn"
      title="Download"
      aria-label="Download"
    >
      <IconDownload class="h-4 w-4" />
    </a>
  </div>
</template>