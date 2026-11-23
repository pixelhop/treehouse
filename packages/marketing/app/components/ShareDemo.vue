<script setup lang="ts">
/**
 * Fragments of the real share panel, set into the sharing cards.
 *
 * These are lifted from `FileShare.vue` class-for-class rather than screenshot:
 * that UI is 12px type inside a 320px panel, so a crop scaled into a card is
 * either tiny or soft, and a PNG is baked to one theme and goes stale in
 * silence. Rendered, it stays sharp at any DPI and cannot drift without the
 * source drifting too.
 *
 * The seam disappears by construction. In the Treehouse theme --th-surface is
 * #ffffff, the same white the marketing card is already on, so the fragment
 * sits flush with no frame around it — only the app's own hairlines.
 *
 * Non-interactive, like the window above: buttons are spans, and the whole
 * fragment is out of the accessibility tree. Each card's own copy says what
 * the picture is showing.
 */
import IconShare from "~icons/solar/share-linear";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";

defineProps<{ id: "link" | "locked" | "version" }>();
</script>

<template>
  <div data-demo-theme="treehouse" aria-hidden="true" class="select-none space-y-3 text-th-fg">
    <!-- ============ A link, not an export ============ -->
    <template v-if="id === 'link'">
      <div class="space-y-1">
        <p class="text-xs font-medium text-th-fg-subtle">Members of this workspace</p>
        <span
          class="flex w-full items-center justify-center gap-1.5 rounded-md border border-th-border px-2.5 py-1.5 text-xs font-medium text-th-fg-muted"
        >
          <IconShare class="h-3.5 w-3.5" />
          Copy member link
        </span>
      </div>

      <div class="space-y-1">
        <p class="text-xs font-medium text-th-fg-subtle">Anyone with the link</p>
        <div class="rounded-md border border-th-border px-2.5 py-1.5 text-xs">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-th-fg-muted">trytree.house/s/9fK2xQ7v</span>
          </div>
          <div class="mt-1 flex gap-3 text-th-fg-subtle">
            <span>Copy</span>
            <span>Revoke</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ Locked down as far as you need ============ -->
    <template v-else-if="id === 'locked'">
      <div class="space-y-1">
        <p class="text-xs font-medium text-th-fg-subtle">Anyone with the link</p>
        <div class="space-y-2 rounded-md border border-th-border p-2.5">
          <span class="flex items-center gap-2 text-xs text-th-fg-muted">
            <span
              class="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] bg-th-accent text-th-accent-fg"
            >
              <svg viewBox="0 0 16 16" class="h-2.5 w-2.5" fill="none">
                <path
                  d="m4 8.4 2.6 2.6L12 5.4"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            Password protect
          </span>
          <span
            class="block w-full rounded border border-th-border bg-th-surface px-2 py-1 text-xs tracking-[0.2em] text-th-fg-muted"
            >••••••••</span
          >
          <span
            class="block w-full rounded bg-th-accent px-2 py-1 text-center text-xs font-medium text-th-accent-fg"
          >
            Create public link
          </span>
        </div>
      </div>

      <div
        class="rounded-md border border-th-warning/40 bg-th-warning/10 px-2.5 py-2 text-xs text-th-fg-muted"
      >
        <span class="flex items-center gap-1.5 font-medium text-th-warning">
          <IconLock class="h-3.5 w-3.5 shrink-0" />
          Shared publicly via a parent folder
        </span>
      </div>
    </template>

    <!-- ============ Pin a version, or stay live ============ -->
    <template v-else>
      <div class="space-y-1">
        <p class="text-xs font-medium text-th-fg-subtle">Anyone with the link</p>
        <div class="space-y-2 rounded-md border border-th-border p-2.5">
          <span class="flex items-center justify-between gap-2 text-xs text-th-fg-muted">
            Link target
            <span
              class="flex items-center gap-1.5 rounded border border-th-border bg-th-surface px-1.5 py-1 text-xs text-th-fg"
            >
              Pinned to v7
              <svg viewBox="0 0 16 16" class="h-3 w-3 text-th-fg-subtle" fill="none">
                <path
                  d="m4 6 4 4 4-4"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </span>
        </div>
      </div>

      <div class="rounded-md border border-th-border px-2.5 py-1.5 text-xs">
        <div class="flex items-center gap-1.5">
          <span class="truncate text-th-fg-muted">trytree.house/s/4Bq8Ld3n</span>
          <span class="shrink-0 font-mono text-th-fg-subtle">v7</span>
        </div>
        <div class="mt-1 flex gap-3 text-th-fg-subtle">
          <span>Copy</span>
          <span>Revoke</span>
        </div>
      </div>
    </template>
  </div>
</template>