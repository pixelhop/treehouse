<script setup lang="ts">
import type { ChangeEvent } from "~/utils/activity";
import { actorDisplay, exactTime, initials, pathGone, relativeTime } from "~/utils/activity";
import { isCommentEvent, opColor, opDisplay, opLabel } from "~/utils/changeOps";

// One change event in the per-file history (the file info panel). Avatar +
// actor + a coloured op line + an optional click-to-open file link. Trailing
// controls (the restore menu) go in the `actions` slot. `memberName` is the
// resolved org-member name for actorId; `paths` lets a gone file render inert.
const props = defineProps<{
  event: ChangeEvent;
  workspaceId: string;
  memberName?: string | null;
  showPath?: boolean;
  paths?: string[];
}>();

const actor = computed(() => actorDisplay(props.event, props.memberName ?? null));
const gone = computed(() => !!props.paths && pathGone(props.paths, props.event.path));
// A comment event's version says which version of the file it happened AT — it
// didn't create that version, so it reads with a preposition.
const isComment = computed(() => isCommentEvent(props.event.op));
</script>

<template>
  <div class="flex items-start gap-2.5">
    <span
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      :class="actor.isAgent ? 'bg-agent/15 text-agent' : 'bg-human/15 text-human'"
      :title="actor.name"
      >{{ initials(actor.name) }}</span
    >
    <div class="min-w-0 flex-1">
      <p
        class="truncate text-sm text-fg"
        :title="actor.agentLabel ? `${actor.name} · ${actor.agentLabel}` : actor.name"
      >
        {{ actor.name
        }}<span v-if="actor.agentLabel" class="text-xs text-agent">
          · via {{ actor.agentLabel }}</span
        >
      </p>
      <p class="mt-0.5 flex items-center gap-1.5 text-xs text-fg-subtle">
        <OpGlyph :op="event.op" class="h-3.5 w-3.5" />
        <span :class="opColor(event.op)">{{ opLabel(event.op) }}</span>
        <span v-if="event.version != null" class="font-mono"
          ><template v-if="isComment">at </template>v{{ event.version }}</span
        >
        <span aria-hidden="true">·</span>
        <span :title="exactTime(event.createdAt)">{{ relativeTime(event.createdAt) }}</span>
      </p>
      <p v-if="showPath" class="mt-1">
        <FileLink
          :path="event.path"
          :workspace-id="workspaceId"
          :gone="gone"
          :tone="opDisplay(event.op).flagsPath ? 'warning' : 'default'"
        />
      </p>
    </div>
    <div class="shrink-0"><slot name="actions" /></div>
  </div>
</template>