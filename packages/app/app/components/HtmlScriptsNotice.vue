<script setup lang="ts">
// The offer to run a page that has JavaScript sitting inert in it. Floats over
// the bottom-right of the preview rather than sitting above it in the layout:
// rendered HTML gets the whole canvas edge-to-edge, and a strip that pushed a
// deck's first slide down the screen would be a worse bug than the one this
// solves. It overlaps a corner of a page that isn't doing anything yet, and it
// leaves the moment either button is pressed.
//
// Consent, not a warning: nothing has happened, and nothing will unless it is
// asked for. So it states what the page wants and what running it can reach —
// a permission prompt that won't say what is at stake trains people to click
// through the one that matters.

defineProps<{
  /**
   * This file was allowed to run before, but has changed since — so the earlier
   * yes was about different bytes (see `scriptStance`). Saying so is the point:
   * silently re-asking looks like the app forgot.
   */
  changed?: boolean;
}>();

const emit = defineEmits<{ allow: []; dismiss: [] }>();
</script>

<template>
  <div
    class="absolute right-4 bottom-4 z-10 max-w-xs rounded-lg border border-border bg-surface p-3 text-sm shadow-lg"
  >
    <p class="text-fg">
      {{
        changed
          ? "This page has changed since you let it run."
          : "This page wants to run JavaScript."
      }}
    </p>
    <p class="mt-0.5 text-xs text-fg-muted">It runs sealed off from your session and workspace.</p>
    <div class="mt-2.5 flex items-center gap-2">
      <button
        type="button"
        class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition hover:bg-accent/90"
        @click="emit('allow')"
      >
        {{ changed ? "Allow again" : "Allow" }}
      </button>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg"
        @click="emit('dismiss')"
      >
        Not now
      </button>
    </div>
  </div>
</template>