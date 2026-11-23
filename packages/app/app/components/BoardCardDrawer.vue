<script setup lang="ts">
import IconClose from "~icons/solar/close-square-linear";
import IconOpen from "~icons/solar/square-top-down-linear";
import IconPen from "~icons/solar/pen-2-linear";
import type { FileEntry } from "~/composables/useTreehouseApi";
import type { FileSource } from "~/utils/fileSource";

// A board card, opened without leaving the board: the file rendered in a
// right-hand drawer over the columns, so you can read a card and carry on
// triaging. Editing hands off to the file's own page (`edit`), where the full
// editor lives; a read-only surface (a public share) doesn't offer it.
const props = defineProps<{
  entry: FileEntry;
  fileSource: FileSource;
  title: string;
  editable: boolean;
}>();
// `media-error` is forwarded from the viewer so a public share can re-check its
// lock when the card's images stop loading, as its other viewers do.
const emit = defineEmits<{ close: []; open: []; edit: []; "media-error": [] }>();

const panel = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  panel.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// A different card opened while the drawer is up starts at its top.
watch(
  () => props.entry.path,
  () => scroller.value?.scrollTo({ top: 0 }),
);

const buttonClass =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition lg:h-8";
</script>

<template>
  <div class="absolute inset-0 z-30 bg-black/20" @click="emit('close')" />
  <aside
    ref="panel"
    tabindex="-1"
    role="dialog"
    :aria-label="title"
    class="absolute inset-y-0 right-0 z-40 flex w-[min(94vw,40rem)] flex-col border-l border-border bg-surface shadow-xl outline-none"
  >
    <header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
      <!-- ph-mask: a card title is a user-authored name or front matter. -->
      <h2 class="ph-mask min-w-0 flex-1 truncate text-sm font-semibold text-fg">{{ title }}</h2>
      <button
        v-if="editable"
        type="button"
        :class="[buttonClass, 'bg-accent font-medium text-accent-fg hover:opacity-90']"
        @click="emit('edit')"
      >
        <IconPen class="h-4 w-4" /> Edit
      </button>
      <button
        type="button"
        :class="[buttonClass, 'text-fg-muted hover:bg-surface-2 hover:text-fg']"
        title="Open the card as a page"
        @click="emit('open')"
      >
        <IconOpen class="h-4 w-4" /> Open
      </button>
      <button
        type="button"
        aria-label="Close card"
        class="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 hover:text-fg lg:h-8 lg:w-8"
        @click="emit('close')"
      >
        <IconClose class="h-4 w-4" />
      </button>
    </header>
    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-16 sm:px-8">
      <FileViewer :file-source="fileSource" :entry="entry" @media-error="emit('media-error')" />
    </div>
  </aside>
</template>