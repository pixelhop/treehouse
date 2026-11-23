<script setup lang="ts">
import IconBox from "~icons/solar/box-bold-duotone";
import { basename, prettyBytes } from "~/utils/format";

// `note` replaces "not previewable" when there is something more useful to say,
// such as why a video that should have played didn't.
const props = defineProps<{ href: string; name: string; size: number; note?: string }>();

const fileName = computed(() => basename(props.name));
// A pinned public permalink whose source file is gone can still be served (by
// content hash) without a known size — say nothing rather than claim "0 B".
const prettySize = computed(() => (props.size > 0 ? prettyBytes(props.size) : null));
</script>

<template>
  <div class="flex flex-1 items-center justify-center">
    <div
      class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm"
    >
      <IconBox class="mx-auto h-10 w-10 text-fg-muted" />
      <div>
        <p class="truncate font-medium text-fg" :title="fileName">{{ fileName }}</p>
        <p class="text-sm text-fg-muted">
          <template v-if="prettySize">{{ prettySize }} · </template>{{ note ?? "not previewable" }}
        </p>
      </div>
      <a
        :href="href"
        target="_blank"
        rel="noopener"
        class="inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg no-underline transition hover:bg-accent/90"
      >
        Download
      </a>
    </div>
  </div>
</template>