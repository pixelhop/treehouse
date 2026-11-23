<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import type { RecoveryRequest } from "shared";
import { pointInTime } from "~/utils/activity";
import { restoreCopy, restoreRequest, timePresets, toLocalInput } from "~/utils/recovery";

// "Restore to an earlier time" and "Undo changes by …": pick a moment, then
// preview exactly what putting the folder (or the whole workspace, or one key's
// changes) back would change, then apply. Mounted once in the app layout;
// useRestoreTo() opens it from anywhere.
const ws = useWorkspaceData();
const qc = useQueryClient();
const { mode, presetAt, workspaceId, close } = useRestoreTo();
const when = ref(toLocalInput(new Date(Date.now() - 60 * 60_000)));
// The exact moment, when one was handed over ("restore to before this"). The
// input only shows seconds, so it's kept until the person picks another time.
const exact = ref<Date | null>(null);
const request = ref<RecoveryRequest | null>(null);
const open = computed(() => mode.value !== undefined && !request.value);
const presets = computed(() => (open.value ? timePresets() : []));
const copy = computed(() => restoreCopy(mode.value ?? { kind: "restore", path: null }));

watch(mode, (m) => {
  if (m === undefined) return;
  exact.value = presetAt.value ? new Date(presetAt.value) : null;
  when.value = toLocalInput(exact.value ?? new Date(Date.now() - 60 * 60_000));
});
function pick(d: Date) {
  exact.value = null;
  when.value = toLocalInput(d);
}

const at = computed(() => {
  const d = exact.value ?? new Date(when.value);
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() ? null : d;
});

const confirmTitle = computed(() =>
  copy.value.confirmTitle(pointInTime(at.value?.toISOString() ?? null)),
);

function preview() {
  if (!at.value) return;
  if (mode.value) request.value = restoreRequest(mode.value, at.value);
}
// Leaving the workspace ends the restore: its preview belongs to that one.
watch(
  () => ws.workspaceId.value,
  (id) => {
    if (workspaceId.value && id !== workspaceId.value) finish();
  },
);
function finish() {
  request.value = null;
  close();
}
function onApplied() {
  void qc.invalidateQueries({ queryKey: ["trash"] });
  void qc.invalidateQueries({ queryKey: ["activity"] });
  void qc.invalidateQueries({ queryKey: ["changes"] });
  ws.refresh();
}
</script>

<template>
  <ModalSurface
    v-if="open"
    :label="copy.heading"
    placement="sheet"
    panel-class="w-full max-w-md rounded-t-xl sm:rounded-xl flex flex-col"
    @close="close()"
  >
    <div class="border-b border-border px-4 py-3">
      <p class="text-sm font-medium text-fg">{{ copy.heading }}</p>
      <!-- ph-mask: user-authored folder name; masked in session replay. -->
      <p class="ph-mask mt-0.5 truncate text-xs text-fg-subtle">{{ copy.subtitle }}</p>
    </div>
    <div class="space-y-3 px-4 py-3 text-sm">
      <p class="text-fg-muted">{{ copy.blurb }}</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="p in presets"
          :key="p.label"
          type="button"
          class="rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg"
          @click="pick(p.at)"
        >
          {{ p.label }}
        </button>
      </div>
      <label class="block text-xs text-fg-muted">
        Date and time
        <input
          v-model="when"
          type="datetime-local"
          step="1"
          @input="exact = null"
          :max="toLocalInput(new Date())"
          class="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
        />
      </label>
      <p v-if="!at" class="text-xs text-danger">Pick a moment in the past.</p>
    </div>
    <div class="flex justify-end gap-2 border-t border-border p-3">
      <button
        type="button"
        class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2"
        @click="close()"
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
        :disabled="!at"
        @click="preview"
      >
        Preview changes
      </button>
    </div>
  </ModalSurface>

  <RecoveryDialog
    :workspace-id="workspaceId ?? ''"
    :request="request"
    :title="confirmTitle"
    :done-title="copy.doneTitle"
    :confirm-label="mode?.kind === 'undo' ? 'Undo changes' : 'Restore'"
    @close="finish"
    @applied="onApplied"
  />
</template>