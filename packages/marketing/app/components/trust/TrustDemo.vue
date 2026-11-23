<script setup lang="ts">
/**
 * The evidence panel for one trust point. Shared by every layout variation so
 * they differ in composition, not in what they prove.
 */
import { conflictRows, undoPreview, versionHistory } from "~/composables/useTrustContent";

defineProps<{ id: "conflict" | "history" | "undo"; compact?: boolean }>();
</script>

<template>
  <div class="space-y-1 rounded-xl border border-border/70 bg-canvas p-2.5">
    <!-- Both files present, side by side, versions intact. -->
    <template v-if="id === 'conflict'">
      <div
        v-for="r in conflictRows"
        :key="r.name"
        class="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
        :class="r.highlight ? 'bg-mist/50' : ''"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="r.kind === 'agent' ? 'bg-agent' : 'bg-human'"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate font-mono text-xs text-fg">{{ r.name }}</span>
        <span class="ml-auto shrink-0 font-mono text-[11px] text-fg-muted">{{ r.version }}</span>
      </div>
      <p v-if="!compact" class="px-2.5 pb-1 pt-2 text-[11px] leading-relaxed text-fg-muted">
        Both kept. Neither writer is told their work was thrown away, because it wasn't.
      </p>
    </template>

    <!-- History stays addressable, so any version can come back. -->
    <template v-else-if="id === 'history'">
      <div
        v-for="v in versionHistory"
        :key="v.version"
        class="flex items-center gap-2 rounded-lg px-2.5 py-2"
        :class="v.current ? 'bg-mist/50' : ''"
      >
        <span class="shrink-0 font-mono text-[11px] text-fg-muted">v{{ v.version }}</span>
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="v.kind === 'agent' ? 'bg-agent' : 'bg-human'"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate text-xs text-fg">{{ v.who }}</span>
        <span v-if="!compact" class="shrink-0 text-[11px] text-fg-muted">{{ v.time }}</span>
        <span
          class="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          :class="v.current ? 'text-fg-muted' : 'border border-border bg-surface text-leaf-deep'"
          >{{ v.current ? "current" : "Restore" }}</span
        >
      </div>
    </template>

    <!-- One agent's changes, previewed before they're undone. -->
    <template v-else>
      <div
        v-for="u in undoPreview"
        :key="u.name"
        class="flex items-center gap-2 rounded-lg px-2.5 py-2"
        :class="u.kept ? 'bg-mist/50' : ''"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="u.kept ? 'bg-human' : 'bg-agent'"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate font-mono text-xs text-fg">{{ u.name }}</span>
        <span class="ml-auto shrink-0 text-[11px] text-fg-muted">{{ u.outcome }}</span>
      </div>
      <div class="flex justify-end px-1 pb-0.5 pt-1.5">
        <span class="rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-fg"
          >Undo Claude Code's changes</span
        >
      </div>
    </template>
  </div>
</template>