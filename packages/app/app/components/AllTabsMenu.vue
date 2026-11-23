<script setup lang="ts">
import type { TabSignal, TabView } from "~/utils/tabs";

// Every open tab as a list — shown once the row overflows, so no tab is only
// reachable by scrolling sideways.
defineProps<{ views: TabView[]; at: { x: number; y: number } }>();
const emit = defineEmits<{ pick: [id: string]; close: [] }>();

const DOT: Record<TabSignal, string> = { dirty: "bg-fg", agent: "bg-agent", human: "bg-human" };
</script>

<template>
  <ModalSurface
    role="menu"
    label="All tabs"
    placement="point"
    :at="at"
    :scrim="false"
    panel-class="w-64 rounded-xl p-1.5"
    @close="emit('close')"
  >
    <div class="contents" @click="emit('close')">
      <button
        v-for="v in views"
        :key="v.tab.id"
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
        :class="v.active ? 'bg-surface-2 font-medium' : ''"
        @click="emit('pick', v.tab.id)"
      >
        <span class="ph-mask min-w-0 truncate" :class="v.gone ? 'line-through' : ''">{{
          v.label
        }}</span>
        <span
          v-if="v.signal"
          class="ml-auto h-[7px] w-[7px] shrink-0 rounded-full"
          :class="DOT[v.signal]"
        />
      </button>
    </div>
  </ModalSurface>
</template>