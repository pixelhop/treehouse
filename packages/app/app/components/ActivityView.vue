<script setup lang="ts">
import { clusterEvents, groupByDay } from "~/utils/activity";

// The full workspace activity view: day-grouped, newest-first, with a frozen
// "new since you were here" divider. Opening it advances the watermark to the
// latest event (R11); new events arriving while it's open render above the
// frozen divider without moving it (R19).
const ws = useWorkspaceData();
const feed = useActivityFeed(ws.workspaceId);
const restoreTo = useRestoreTo();
const viewOnly = useWorkspaceData().viewOnly;
const watermark = useActivityWatermark(ws.workspaceId, {
  events: feed.events,
  head: feed.head,
});
const { byId: members } = useWorkspaceMembers(ws.workspaceId);
const paths = computed(() => ws.entries.value.map((e) => e.path));

// Advance (and freeze the divider) once the feed has loaded, and keep advancing
// as new events arrive so the badge stays at 0 while this view is focused.
watch(
  [() => feed.head.value, () => watermark.ready.value],
  ([head, ready]) => {
    if (head > 0 && ready) void watermark.advance();
  },
  { immediate: true },
);

const clusters = computed(() =>
  clusterEvents(feed.events.value, {
    dividerSeq: watermark.dividerSeq.value,
    operations: feed.operations.value,
  }),
);

// Group the newest-first clusters into consecutive day buckets.
const dayGroups = computed(() => groupByDay(clusters.value, (c) => c.createdAt));

// Where the "new since you were here" divider sits: before the first already-
// seen cluster, at the top when everything is new, or nowhere when nothing is.
const divider = computed<{ beforeSeq: number | null; atTop: boolean }>(() => {
  if (watermark.dividerSeq.value == null) return { beforeSeq: null, atTop: false };
  const anyUnread = clusters.value.some((c) => c.unread);
  if (!anyUnread) return { beforeSeq: null, atTop: false };
  const firstSeen = clusters.value.find((c) => !c.unread);
  if (!firstSeen) return { beforeSeq: null, atTop: true };
  return { beforeSeq: firstSeen.headSeq, atTop: false };
});
</script>

<template>
  <AppTopBar>
    <template #breadcrumb>
      <WorkspaceCrumbs label="Activity" />
    </template>
    <template #actions>
      <button
        v-if="!viewOnly"
        type="button"
        class="rounded-md px-2.5 py-1.5 text-fg-muted transition hover:bg-surface-2"
        @click="restoreTo.open(null)"
      >
        Restore to…
      </button>
      <button
        type="button"
        class="rounded-md px-2.5 py-1.5 text-fg-muted transition hover:bg-surface-2"
        @click="watermark.markAllSeen()"
      >
        Mark all seen
      </button>
    </template>
  </AppTopBar>

  <div class="min-h-0 flex-1 overflow-auto bg-app">
    <div class="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-7">
      <div v-if="feed.loading.value" class="rounded-xl border border-border bg-surface px-5 py-5">
        <div v-for="n in 4" :key="n" class="flex gap-3 pb-5">
          <div class="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-2" />
          <div class="flex-1 space-y-2">
            <div class="h-3 w-32 animate-pulse rounded bg-surface-2" />
            <div class="h-3 w-44 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      </div>
      <div
        v-else-if="feed.error.value"
        class="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
      >
        Couldn’t load activity. {{ feed.error.value }}
      </div>
      <div
        v-else-if="clusters.length === 0"
        class="rounded-xl border border-border bg-surface px-6 py-16 text-center"
      >
        <p class="text-sm font-medium text-fg">No activity yet</p>
        <p class="mt-1 text-xs text-fg-subtle">
          Changes you and your agents make will show up here.
        </p>
      </div>
      <div v-else class="rounded-xl border border-border bg-surface px-5 py-5">
        <div v-if="divider.atTop" class="mb-5 ml-11 flex items-center gap-2.5">
          <span class="h-px flex-1 bg-accent/30" />
          <span class="text-[10.5px] font-semibold uppercase tracking-wider text-accent"
            >New since you were here</span
          >
          <span class="h-px flex-1 bg-accent/30" />
        </div>
        <section v-for="(group, gi) in dayGroups" :key="group.label" :class="gi > 0 ? 'mt-7' : ''">
          <h2 class="mb-4 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            {{ group.label }}
          </h2>
          <template v-for="(c, i) in group.items" :key="c.headSeq">
            <div
              v-if="divider.beforeSeq === c.headSeq"
              class="mb-5 ml-11 flex items-center gap-2.5"
            >
              <span class="h-px flex-1 bg-accent/30" />
              <span class="text-[10.5px] font-semibold uppercase tracking-wider text-accent"
                >New since you were here</span
              >
              <span class="h-px flex-1 bg-accent/30" />
            </div>
            <ChangeEventCluster
              :cluster="c"
              :workspace-id="ws.workspaceId.value ?? ''"
              :members-by-id="members"
              :paths="paths"
              :is-last="i === group.items.length - 1"
            />
          </template>
        </section>
      </div>
    </div>
  </div>
</template>