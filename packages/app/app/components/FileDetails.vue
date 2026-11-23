<script setup lang="ts">
import IconChevron from "~icons/solar/alt-arrow-down-linear";

// The technical facts about a file — path, type, size, length. Closed by default:
// they are reference material, and listing them first buried what people open
// the panel for.
defineProps<{ rows: { label: string; value: string }[] }>();
</script>

<template>
  <details class="group border-t border-border pt-3">
    <summary
      class="flex cursor-pointer list-none items-center justify-between text-sm text-fg-muted transition hover:text-fg [&::-webkit-details-marker]:hidden"
    >
      File details
      <IconChevron class="h-4 w-4 transition-transform group-open:rotate-180" />
    </summary>
    <dl class="panel-rows mt-2.5">
      <div v-for="r in rows" :key="r.label">
        <dt>{{ r.label }}</dt>
        <!-- ph-mask: one of these rows is "Path", whose value is the user's file
             path. Masking the whole value column rather than that one row keeps
             this safe if a future row carries content too. -->
        <dd class="ph-mask" :title="r.value">{{ r.value }}</dd>
      </div>
    </dl>
  </details>
</template>