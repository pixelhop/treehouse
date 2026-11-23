<script setup lang="ts">
import type { RecoveryOutcome, RecoveryPreview, RecoveryRequest } from "shared";
import {
  actionCounts,
  confirmRequest,
  createLatest,
  dialogNotices,
  errorText,
  outcomeLine,
  settled,
  shownChanges,
} from "~/utils/recovery";

// Preview, then apply, a recovery: bringing files back from the trash,
// restoring to a point in time, or undoing a key's changes. Nothing changes
// until the person has seen the full list of what will, and what will be left
// alone and why. After applying, the same dialog shows what actually happened.
const props = defineProps<{
  workspaceId: string;
  /** What to recover, or null when the dialog is closed. */
  request: RecoveryRequest | null;
  title: string;
  /** The title once it has run, e.g. "Restored from the trash". */
  doneTitle: string;
  confirmLabel: string;
}>();
const emit = defineEmits<{ close: []; applied: [outcome: RecoveryOutcome] }>();

const api = useTreehouseApi();
const preview = ref<RecoveryPreview | null>(null);
const outcome = ref<RecoveryOutcome | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const applying = ref(false);

// The request, workspace and preview being shown. Confirming applies exactly
// that, whatever the props have moved on to.
let previewed: { request: RecoveryRequest; workspaceId: string; preview: RecoveryPreview } | null =
  null;
// Moves on with each new request (or closing), so a response for an earlier
// one is dropped instead of shown.
const latest = createLatest();

// A new request, or the same one for another workspace, starts afresh.
watch(
  () => [props.request, props.workspaceId] as const,
  async ([req, workspaceId]) => {
    const current = latest.next();
    previewed = null;
    preview.value = null;
    outcome.value = null;
    error.value = null;
    applying.value = false;
    loading.value = !!req;
    if (!req) return;
    const res = await settled(api.recoveryPreview(workspaceId, req));
    if (!current()) return;
    loading.value = false;
    if (!res.ok) error.value = errorText(res.error);
    else previewed = { request: req, workspaceId, preview: (preview.value = res.value) };
  },
  { immediate: true },
);

async function confirm() {
  if (!previewed) return;
  const current = latest.now();
  applying.value = true;
  error.value = null;
  const { request, workspaceId, preview: confirmed } = previewed;
  const res = await settled(api.recoveryApply(workspaceId, confirmRequest(request, confirmed)));
  // A change that landed is reported even if the dialog has moved on.
  if (res.ok) emit("applied", res.value);
  if (current()) showOutcome(res);
}

function showOutcome(res: Awaited<ReturnType<typeof settled<RecoveryOutcome>>>) {
  applying.value = false;
  if (res.ok) outcome.value = res.value;
  else error.value = errorText(res.error);
}

// Once applied, the past-tense title, unless nothing could be done after all.
const heading = computed(() => {
  if (!outcome.value) return props.title;
  return outcome.value.applied.length > 0 ? props.doneTitle : "Nothing was changed";
});
const shown = computed(() => shownChanges(preview.value, outcome.value));
const counts = computed(() => (outcome.value ? [] : actionCounts(shown.value.actions)));
const subtitle = computed(() => {
  if (outcome.value) return outcomeLine(outcome.value.applied.length, outcome.value.skipped.length);
  return preview.value ? "Nothing has changed yet. Here is what will happen." : "";
});
const nothingToDo = computed(
  () =>
    !!preview.value &&
    !outcome.value &&
    shown.value.actions.length + shown.value.skipped.length === 0,
);
const notices = computed(() =>
  dialogNotices({
    error: error.value,
    tooLarge: !!preview.value?.tooLarge && !outcome.value,
    nothingToDo: nothingToDo.value,
  }),
);
const canApply = computed(
  () => !!preview.value && preview.value.actions.length > 0 && !preview.value.tooLarge,
);
</script>

<template>
  <ModalSurface
    v-if="request"
    :label="title"
    placement="sheet"
    panel-class="w-full max-w-xl rounded-t-xl sm:rounded-xl flex flex-col max-h-[85vh]"
    @close="emit('close')"
  >
    <div class="shrink-0 border-b border-border px-4 py-3">
      <p class="text-sm font-medium text-fg">{{ heading }}</p>
      <p v-if="subtitle" class="mt-0.5 text-xs text-fg-subtle">{{ subtitle }}</p>
    </div>

    <RecoveryDialogBody
      :loading="loading"
      :notices="notices"
      :counts="counts"
      :actions="shown.actions"
      :skipped="shown.skipped"
      :done="!!outcome"
    />

    <RecoveryDialogActions
      :done="!!outcome"
      :can-apply="canApply"
      :applying="applying"
      :confirm-label="confirmLabel"
      @close="emit('close')"
      @confirm="confirm"
    />
  </ModalSurface>
</template>