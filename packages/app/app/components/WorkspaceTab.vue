<script setup lang="ts">
import IconHome from "~icons/solar/home-2-linear";
import IconHistory from "~icons/solar/history-2-linear";
import type { TabSignal, TabView } from "~/utils/tabs";

// One tab in the row. Pointer and drag listeners are the parent's, and fall
// through to the root element; this only draws the tab and offers its close.
const props = defineProps<{ view: TabView; dragging: boolean; dropTarget: boolean }>();
defineEmits<{ close: [] }>();

const SIGNAL_CLASS: Record<TabSignal, string> = {
  dirty: "bg-fg",
  agent: "bg-agent",
  human: "bg-human",
};
const SIGNAL_TITLE: Record<TabSignal, string> = {
  dirty: "Unsaved changes",
  agent: "Changed by an agent since you last looked",
  human: "Changed by someone since you last looked",
};

const rootClass = computed(() => [
  props.view.active
    ? "relative z-10 -mb-px h-[31px] min-w-36 border-border bg-surface font-medium text-fg"
    : "border-transparent text-fg-muted hover:bg-fg/5",
  props.dragging ? "opacity-40" : "",
  props.dropTarget ? "shadow-[inset_2px_0_0_var(--color-accent)]" : "",
]);
const iconClass = computed(() => {
  if (props.view.gone) return "text-fg-subtle opacity-50";
  return props.view.active ? "text-accent" : "text-fg-subtle";
});
// The trailing slot holds the signal dot at rest and the close button on
// hover — and always the close button on the active tab, unless it has a dot.
const closeClass = computed(() => {
  if (props.view.signal) return "hidden group-hover:grid";
  return props.view.active ? "" : "invisible group-hover:visible";
});
</script>

<template>
  <div
    role="tab"
    :aria-selected="view.active"
    tabindex="0"
    :title="view.tooltip"
    draggable="true"
    class="group relative flex h-[30px] max-w-52 min-w-24 shrink grow-0 basis-48 cursor-default items-center gap-1.5 rounded-t-lg border border-b-0 pr-1 pl-2.5 text-[13px] outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/40"
    :class="rootClass"
  >
    <IconHome v-if="view.tab.kind === 'home'" class="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
    <IconHistory
      v-else-if="view.tab.kind === 'activity'"
      class="h-3.5 w-3.5 shrink-0 text-fg-subtle"
    />
    <NodeIcon
      v-else
      :icon="view.icon"
      :is-dir="view.isDir"
      class="h-3.5 w-3.5 shrink-0"
      :class="iconClass"
    />
    <span
      class="ph-mask min-w-0 flex-1 truncate"
      :class="view.gone ? 'text-fg-subtle italic line-through decoration-fg-subtle/50' : ''"
      >{{ view.label }}</span
    >
    <span class="relative grid h-5 w-5 shrink-0 place-items-center">
      <span
        v-if="view.signal"
        class="h-[7px] w-[7px] rounded-full group-hover:hidden"
        :class="SIGNAL_CLASS[view.signal]"
        :title="SIGNAL_TITLE[view.signal]"
      />
      <button
        type="button"
        :aria-label="`Close ${view.label}`"
        title="Close tab (⌥W)"
        class="grid h-5 w-5 place-items-center rounded text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
        :class="closeClass"
        @click.stop="$emit('close')"
      >
        <svg viewBox="0 0 16 16" class="h-3 w-3" aria-hidden="true">
          <path
            d="M4.5 4.5l7 7M11.5 4.5l-7 7"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </span>
  </div>
</template>