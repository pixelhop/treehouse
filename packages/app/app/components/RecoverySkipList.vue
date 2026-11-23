<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { RecoverySkip } from "shared";
import { skipText } from "~/utils/recovery";

// The files a recovery left alone, each with the reason.
defineProps<{ skipped: RecoverySkip[] }>();
</script>

<template>
  <section>
    <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
      Left alone
    </h3>
    <ul class="space-y-1">
      <li v-for="s in skipped" :key="`skip:${s.path}`" class="flex items-start gap-2">
        <Icon icon="solar:forbidden-circle-linear" class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div class="min-w-0 flex-1">
          <!-- ph-mask: user-authored path; masked in session replay. -->
          <p class="ph-mask truncate text-fg" :title="s.path">{{ s.path }}</p>
          <p class="text-xs text-fg-subtle">Left alone: {{ skipText(s) }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>