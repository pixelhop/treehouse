<script setup lang="ts">
import IconFile from "~icons/solar/file-text-linear";
import IconOpen from "~icons/solar/arrow-right-up-linear";
import { basename } from "~/utils/format";
import { openIntent } from "~/utils/tabs";

// A file reference that opens the file. The whole chip is clickable, with a
// file glyph and an "open" arrow that surfaces on hover so it reads as a link.
// `gone` renders it struck-through and inert (the file was removed); `tone`
// tints a conflicted copy in warning.
const props = defineProps<{
  path: string;
  workspaceId: string;
  gone?: boolean;
  tone?: "default" | "warning";
}>();

const tabs = useWorkspaceTabs();

// ⌘/Ctrl- or middle click opens a tab, when tabs are on.
function open(e: MouseEvent) {
  if (props.gone) return;
  if (props.workspaceId === tabs.workspaceId.value && tabs.openPath(props.path, openIntent(e))) {
    return;
  }
  if (e.button === 0) navigateTo(`/w/${props.workspaceId}/${props.path}`);
}
</script>

<template>
  <button
    v-if="!gone"
    type="button"
    class="group/file -mx-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition hover:bg-accent/10"
    :class="tone === 'warning' ? 'text-warning' : 'text-fg-muted hover:text-accent'"
    :title="`Open ${path}`"
    @click="open"
    @auxclick="$event.button === 1 && open($event)"
  >
    <IconFile class="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
    <span class="ph-mask truncate font-mono">{{ basename(path) }}</span>
    <IconOpen
      class="h-3 w-3 shrink-0 opacity-0 transition group-hover/file:opacity-60"
      aria-hidden="true"
    />
  </button>
  <span
    v-else
    class="inline-flex max-w-full items-center gap-1.5 text-xs text-fg-subtle line-through"
    :title="`${path} (removed)`"
  >
    <IconFile class="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
    <span class="ph-mask truncate font-mono">{{ basename(path) }}</span>
  </span>
</template>