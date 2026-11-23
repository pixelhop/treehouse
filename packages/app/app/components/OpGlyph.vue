<script setup lang="ts">
import type { Component } from "vue";
import { type ChangeOp, isChangeOp } from "shared";
import IconWrite from "~icons/solar/pen-2-linear";
import IconMove from "~icons/solar/alt-arrow-right-linear";
import IconRestore from "~icons/solar/rewind-back-linear";
import IconDelete from "~icons/solar/trash-bin-minimalistic-linear";
import IconConflict from "~icons/solar/danger-triangle-linear";
import IconComment from "~icons/solar/chat-round-line-linear";
import IconReply from "~icons/solar/reply-linear";
import IconResolved from "~icons/solar/chat-round-check-linear";
import IconReopened from "~icons/solar/restart-linear";
import IconMadePrivate from "~icons/solar/lock-keyhole-minimalistic-linear";
import IconMadeShared from "~icons/solar/lock-keyhole-minimalistic-unlocked-linear";
import IconOther from "~icons/solar/info-circle-linear";
import { opColor } from "~/utils/changeOps";

// The icon for a change op, tinted with its tone from the op table
// (utils/changeOps). Keyed by the full ChangeOp union, so an op without an icon
// fails the typecheck; an op from a newer server gets the neutral fallback. The
// lock glyphs match the file tree's Make private / Make shared actions.
const props = defineProps<{ op: string }>();
const ICON: Record<ChangeOp, Component> = {
  write: IconWrite,
  move: IconMove,
  restore: IconRestore,
  delete: IconDelete,
  conflict: IconConflict,
  comment_created: IconComment,
  comment_replied: IconReply,
  comment_resolved: IconResolved,
  comment_reopened: IconReopened,
  access_revoked: IconMadePrivate,
  access_granted: IconMadeShared,
  access_claimed: IconMadePrivate,
};
const icon = computed<Component>(() => (isChangeOp(props.op) ? ICON[props.op] : IconOther));
</script>

<template>
  <component :is="icon" class="shrink-0" :class="opColor(op)" aria-hidden="true" />
</template>