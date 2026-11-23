<script setup lang="ts">
import { Icon } from "@iconify/vue";
import type { TrashItem } from "shared";
import { exactTime, relativeTime } from "~/utils/activity";
import { trashLabel } from "~/utils/recovery";

// One deleted file in the trash: tick it to restore with others, or restore it alone.
const props = defineProps<{
  item: TrashItem;
  selected: boolean;
  deletedBy: string;
  readonly?: boolean;
}>();
const emit = defineEmits<{ toggle: []; restore: [] }>();
const label = computed(() => trashLabel(props.item));
</script>

<template>
  <li class="group flex items-center gap-3 py-2">
    <input
      v-if="!readonly"
      type="checkbox"
      :aria-label="`Select ${label.path}`"
      :disabled="!item.restorable"
      :checked="selected"
      @change="emit('toggle')"
    />
    <Icon
      :icon="label.isFolder ? 'solar:folder-linear' : 'solar:file-text-linear'"
      class="h-4 w-4 shrink-0 text-fg-subtle"
    />
    <div class="min-w-0 flex-1">
      <!-- ph-mask: user-authored path; masked in session replay. -->
      <p class="ph-mask truncate text-sm text-fg" :title="item.path">
        {{ label.path }}<span v-if="label.isFolder" class="text-fg-subtle"> (empty folder)</span>
      </p>
      <p class="text-xs text-fg-subtle">
        Deleted by {{ deletedBy }} ·
        <span :title="exactTime(item.deletedAt)">{{ relativeTime(item.deletedAt) }}</span>
        <span v-if="!item.restorable" class="text-warning">
          · Its content wasn't recorded, so it can't be restored</span
        >
      </p>
    </div>
    <button
      v-if="item.restorable && !readonly"
      type="button"
      class="shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      @click="emit('restore')"
    >
      Restore
    </button>
  </li>
</template>