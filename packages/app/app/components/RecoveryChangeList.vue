<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { RecoveryAction } from "shared";
import { prettyBytes } from "~/utils/format";
import { actionLabel } from "~/utils/recovery";

// The changes a recovery will make (or made), one row per file.
defineProps<{ actions: RecoveryAction[]; done: boolean }>();

const ICONS: Record<RecoveryAction["kind"], string> = {
  recreate: "solar:undo-left-round-linear",
  restore: "solar:history-linear",
  move: "solar:move-to-folder-linear",
  delete: "solar:trash-bin-minimalistic-linear",
};
</script>

<template>
  <section>
    <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
      {{ done ? "Changed" : "Will change" }}
    </h3>
    <ul class="space-y-1">
      <li v-for="a in actions" :key="`${a.kind}:${a.path}`" class="flex items-start gap-2">
        <Icon
          :icon="ICONS[a.kind]"
          class="mt-0.5 h-4 w-4 shrink-0"
          :class="a.kind === 'delete' ? 'text-danger' : 'text-fg-subtle'"
        />
        <div class="min-w-0 flex-1">
          <!-- ph-mask: user-authored path; masked in session replay. -->
          <p class="ph-mask truncate text-fg" :title="a.path">{{ a.path }}</p>
          <p class="text-xs text-fg-subtle">
            {{ actionLabel(a, done) }}
            <template v-if="a.kind === 'move'">
              from <span class="ph-mask">{{ a.from }}</span></template
            >
            · {{ prettyBytes(a.size) }}
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>