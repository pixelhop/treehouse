<script setup lang="ts">
import { opDisplay } from "~/utils/changeOps";
import { justBefore } from "~/utils/recovery";

// The undo actions on an activity entry, both opened at the exact moment
// before the entry's first change:
// - "Undo <key>'s changes…" when the entry was made through one API key (an
//   agent, or a synced folder): undo just that key's work since then.
// - "Restore to before this…": put the whole workspace back to then.
// Hidden for entries with no file changes (comments, sharing), which neither
// touches.
const props = defineProps<{
  events: { op: string; createdAt: string }[];
  keyId?: string | null;
  label?: string | null;
}>();
const restoreTo = useRestoreTo();
const viewOnly = useWorkspaceData().viewOnly;
const at = computed(() =>
  props.events.some((e) => opDisplay(e.op).group === "file") ? justBefore(props.events) : null,
);
const BUTTON =
  "shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-subtle transition hover:bg-surface-2 hover:text-fg sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100";
</script>

<template>
  <template v-if="at && !viewOnly">
    <button
      v-if="keyId"
      type="button"
      :class="BUTTON"
      :title="`Undo what ${label ?? 'this key'} changed from here on, leaving everyone else's work`"
      @click="restoreTo.openUndo(keyId, label ?? 'this key', at)"
    >
      {{ label ? `Undo ${label}'s changes…` : "Undo these changes…" }}
    </button>
    <button
      type="button"
      :class="BUTTON"
      title="Put the workspace back the way it was just before this"
      @click="restoreTo.open(null, at)"
    >
      Restore to before this…
    </button>
  </template>
</template>