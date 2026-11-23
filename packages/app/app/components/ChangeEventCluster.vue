<script setup lang="ts">
import IconChevronDown from "~icons/solar/alt-arrow-down-linear";
import IconChevronRight from "~icons/solar/alt-arrow-right-linear";
import {
  actorDisplay,
  clusterSummary,
  type EventCluster,
  exactTime,
  initials,
  pathGone,
  relativeTime,
} from "~/utils/activity";
import { opColor, opDisplay, opLabel } from "~/utils/changeOps";

// A timeline entry: one actor's run of changes. The avatar is the node on the
// spine (the connector is drawn unless this is the last entry in its day group).
// A single event shows its op + file; a small run shows its files inline as
// click-to-open chips; a large run collapses to a summary that expands to the
// full file list. `membersById` resolves actorId → name; `paths` flags removed
// files.
const props = defineProps<{
  cluster: EventCluster;
  workspaceId: string;
  membersById: Map<string, { name: string }>;
  paths?: string[];
  isLast?: boolean;
}>();

const SMALL = 3;
const expanded = ref(false);

function memberName(actorId?: string | null): string | null {
  return actorId ? (props.membersById.get(actorId)?.name ?? null) : null;
}
function gone(path: string): boolean {
  return !!props.paths && pathGone(props.paths, path);
}
function tone(op: string): "warning" | "default" {
  return opDisplay(op).flagsPath ? "warning" : "default";
}

const events = computed(() => props.cluster.events);
// A recovery operation always reads as its summary, even when only one of its
// changes is visible to this reader.
const single = computed(() => events.value.length === 1 && !props.cluster.operation);
const small = computed(() => events.value.length <= SMALL);
const head = computed(() => events.value[0]!);
const actor = computed(() => actorDisplay(head.value, memberName(head.value.actorId)));
const summary = computed(() => clusterSummary(props.cluster));
// Node tint: a standalone conflict reads as warning; otherwise the principal.
const nodeClass = computed(() =>
  single.value && opDisplay(head.value.op).flagsPath
    ? "bg-warning/15 text-warning"
    : actor.value.isAgent
      ? "bg-agent/15 text-agent"
      : "bg-human/15 text-human",
);
</script>

<template>
  <div class="group relative flex gap-3">
    <div class="relative flex w-8 shrink-0 justify-center">
      <span
        v-if="!isLast"
        class="absolute -bottom-3 left-1/2 top-9 w-px -translate-x-1/2 bg-border"
        aria-hidden="true"
      />
      <span
        class="relative z-10 flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold ring-4 ring-surface"
        :class="nodeClass"
        :title="actor.name"
        >{{ initials(actor.name) }}</span
      >
    </div>

    <div class="min-w-0 flex-1 pb-5">
      <div class="flex items-center gap-2">
        <p
          class="min-w-0 flex-1 truncate text-sm text-fg"
          :title="actor.agentLabel ? `${actor.name} · ${actor.agentLabel}` : actor.name"
        >
          {{ actor.name
          }}<span v-if="actor.agentLabel" class="text-xs text-agent">
            · via {{ actor.agentLabel }}</span
          >
        </p>
        <ActivityEntryActions
          :events="events"
          :key-id="cluster.operation ? null : cluster.actorKeyId"
          :label="cluster.actorLabel"
        />
      </div>

      <template v-if="single">
        <p class="mt-0.5 flex items-center gap-1.5 text-xs text-fg-subtle">
          <OpGlyph :op="head.op" class="h-3.5 w-3.5" />
          <span :class="opColor(head.op)">{{ opLabel(head.op) }}</span>
          <span v-if="head.version != null" class="font-mono">v{{ head.version }}</span>
          <span aria-hidden="true">·</span>
          <span :title="exactTime(head.createdAt)">{{ relativeTime(head.createdAt) }}</span>
        </p>
        <p class="mt-1">
          <FileLink
            :path="head.path"
            :workspace-id="workspaceId"
            :gone="gone(head.path)"
            :tone="tone(head.op)"
          />
        </p>
      </template>

      <template v-else-if="small">
        <p class="mt-0.5 text-xs text-fg-subtle">
          {{ summary }} ·
          <span :title="exactTime(cluster.createdAt)">{{ relativeTime(cluster.createdAt) }}</span>
        </p>
        <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          <FileLink
            v-for="e in events"
            :key="e.id"
            :path="e.path"
            :workspace-id="workspaceId"
            :gone="gone(e.path)"
            :tone="tone(e.op)"
          />
        </div>
      </template>

      <template v-else>
        <button
          type="button"
          class="mt-0.5 flex items-center gap-1.5 text-xs text-fg-subtle transition hover:text-fg"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          <span class="text-fg-muted">{{ summary }}</span>
          <span aria-hidden="true">·</span>
          <span :title="exactTime(cluster.createdAt)">{{ relativeTime(cluster.createdAt) }}</span>
          <component :is="expanded ? IconChevronDown : IconChevronRight" class="h-3.5 w-3.5" />
        </button>
        <div v-if="expanded" class="mt-1.5 flex flex-col gap-1">
          <div v-for="e in events" :key="e.id" class="flex items-center gap-2">
            <OpGlyph :op="e.op" class="h-3 w-3" />
            <FileLink
              :path="e.path"
              :workspace-id="workspaceId"
              :gone="gone(e.path)"
              :tone="tone(e.op)"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>