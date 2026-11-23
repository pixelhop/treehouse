<script setup lang="ts">
import IconClose from "~icons/solar/minimize-square-minimalistic-linear";
import { clusterEvents, type FeedEvent, type RecoveryOperationInfo } from "~/utils/activity";

// The glance drawer: a quick peek at recent activity. Opening it does NOT
// advance the watermark (the parent never calls advance for the drawer), so the
// unread badge stays honest. "See all" routes to the full activity view.
const props = defineProps<{
  workspaceId: string;
  events: FeedEvent[];
  dividerSeq: number | null;
  operations?: ReadonlyMap<string, RecoveryOperationInfo>;
  membersById: Map<string, { name: string }>;
  paths?: string[];
  loading?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ close: []; seeAll: [] }>();

// Cap the drawer; deeper history lives behind "See all".
const GLANCE_CAP = 15;
const clusters = computed(() =>
  clusterEvents(props.events, {
    dividerSeq: props.dividerSeq,
    operations: props.operations,
  }).slice(0, GLANCE_CAP),
);

// Place the "new since you were here" line between the unread runs (top) and
// the first already-seen run. Hidden when there is nothing unread above it.
const dividerIndex = computed(() => {
  if (props.dividerSeq == null) return -1;
  const i = clusters.value.findIndex((c) => !c.unread);
  return i > 0 ? i : -1;
});

// When everything in the window is new, the divider sits at the very top.
const dividerAtTop = computed(
  () =>
    props.dividerSeq != null && clusters.value.length > 0 && clusters.value.every((c) => c.unread),
);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <!-- A scrim, not a transparent catcher: without it the page behind stayed at
       full brightness and the drawer read as part of the layout rather than
       over it — most obvious on a phone, where it covers nearly everything. -->
  <div class="fixed inset-0 z-40 bg-black/40" @click.self="emit('close')">
    <div
      role="dialog"
      aria-label="Recent activity"
      class="absolute top-0 right-0 flex h-full w-[min(86vw,20rem)] flex-col border-l border-border bg-surface shadow-xl"
    >
      <header class="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 class="text-sm font-semibold text-fg">Activity</h2>
        <button
          type="button"
          class="rounded p-1 text-fg-subtle transition hover:bg-surface-2 hover:text-fg"
          aria-label="Close activity"
          @click="emit('close')"
        >
          <IconClose class="h-4 w-4" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div v-if="loading" class="space-y-5">
          <div v-for="n in 4" :key="n" class="flex gap-3">
            <div class="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-2" />
            <div class="flex-1 space-y-2 pt-1">
              <div class="h-3 w-28 animate-pulse rounded bg-surface-2" />
              <div class="h-3 w-36 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
        </div>
        <p v-else-if="error" class="text-sm text-danger">Couldn’t load activity. {{ error }}</p>
        <p v-else-if="clusters.length === 0" class="text-sm text-fg-subtle">No activity yet.</p>
        <div v-else>
          <div v-if="dividerAtTop" class="mb-5 ml-11 flex items-center gap-2.5">
            <span class="h-px flex-1 bg-accent/30" />
            <span class="shrink-0 text-[10.5px] font-semibold uppercase tracking-wider text-accent"
              >New since you were here</span
            >
            <span class="h-px flex-1 bg-accent/30" />
          </div>
          <template v-for="(c, i) in clusters" :key="c.headSeq">
            <div v-if="i === dividerIndex" class="mb-5 ml-11 flex items-center gap-2.5">
              <span class="h-px flex-1 bg-accent/30" />
              <span
                class="shrink-0 text-[10.5px] font-semibold uppercase tracking-wider text-accent"
                >New since you were here</span
              >
              <span class="h-px flex-1 bg-accent/30" />
            </div>
            <ChangeEventCluster
              :cluster="c"
              :workspace-id="workspaceId"
              :members-by-id="membersById"
              :paths="paths"
              :is-last="i === clusters.length - 1"
            />
          </template>
        </div>
      </div>

      <footer class="border-t border-border p-2">
        <button
          type="button"
          class="w-full rounded-md px-3 py-1.5 text-center text-sm font-medium text-accent transition hover:bg-surface-2"
          @click="emit('seeAll')"
        >
          See all activity
        </button>
      </footer>
    </div>
  </div>
</template>