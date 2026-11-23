<script setup lang="ts">
import { UPLOADED_ICON_PREFIX } from "shared";
import { DEFAULT_WORKSPACE_COLOR } from "~/utils/workspaceColors";
import type { WorkspaceInfo } from "~/composables/useTreehouseApi";

const props = defineProps<{
  mode: "create" | "edit";
  workspace?: WorkspaceInfo | null;
  saving?: boolean;
  /** An icon-upload failure, shown inline so the save that failed says why. */
  error?: string | null;
  /** A 402 refusal from the create call, rendered as an upgrade offer. */
  planError?: unknown;
  /** The workspace whose plan an upgrade would apply to. */
  currentWorkspaceId?: string;
  /** False for a plain member, who cannot buy and should not be offered it. */
  canManageBilling?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [
    {
      name: string;
      icon: string | null;
      color: string;
      image: Blob | null;
      plan?: "grove" | "forest";
      annual?: boolean;
    },
  ];
}>();

const api = useTreehouseApi();

const name = ref(props.workspace?.name ?? "");
const icon = ref<string | null>(props.workspace?.icon ?? null);
const color = ref<string>(props.workspace?.color ?? DEFAULT_WORKSPACE_COLOR);

// A picked image is held here until save: in create mode there is no workspace
// to upload to yet, and in edit mode Cancel must leave the stored icon alone.
const image = ref<Blob | null>(null);
const imagePreview = ref<string | null>(null);
watch(image, (blob) => {
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
  imagePreview.value = blob ? URL.createObjectURL(blob) : null;
  // Clearing the pick also clears a stored image icon — "Remove" means remove.
  if (!blob && icon.value?.startsWith(UPLOADED_ICON_PREFIX)) icon.value = null;
});
onBeforeUnmount(() => {
  if (imagePreview.value) URL.revokeObjectURL(imagePreview.value);
});

// The pending pick wins over whatever the workspace currently wears.
const imageUrl = computed(
  () =>
    imagePreview.value ??
    (props.workspace ? api.workspaceIconUrl(props.workspace.id, icon.value) : null),
);

// Which half of the dialog is showing. The plan step replaces the details
// rather than sitting under them: three tiers do not fit beside an icon grid,
// and the details are already decided by the time anyone gets here — the name
// and colour are carried through so nothing typed is lost.
const step = ref<"details" | "plan">("details");

// Which tier was clicked, so the picker can put the spinner on that card rather
// than guessing. Creation and checkout both happen in the parent.
const chosen = ref<"grove" | "forest" | null>(null);

// Squaring up an image is async. Saving mid-decode would post the workspace
// without the logo the user just picked and report success, so every save path
// — the button, Enter in the name field, and picking a paid plan — waits.
const preparingImage = ref(false);

const canSave = computed(
  () => name.value.trim().length > 0 && !props.saving && !preparingImage.value,
);

const saveLabel = computed(() => {
  if (preparingImage.value) return "Preparing image…";
  if (props.saving) return "Saving…";
  return props.mode === "create" ? "Create" : "Save";
});

function save(plan?: { plan: "grove" | "forest"; annual: boolean }) {
  if (!canSave.value) return;
  emit("save", {
    name: name.value.trim(),
    icon: icon.value,
    color: color.value,
    image: image.value,
    plan: plan?.plan,
    annual: plan?.annual,
  });
}

function chooseForNew({ plan, annual }: { plan: string; annual: boolean }) {
  if (plan === "seedling") return; // the picker does not offer it here
  chosen.value = plan as "grove" | "forest";
  save({ plan: plan as "grove" | "forest", annual });
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <div
      class="w-full space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl"
      :class="step === 'plan' ? 'max-w-3xl' : 'max-w-md'"
    >
      <template v-if="step === 'plan'">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h3 class="text-lg font-semibold text-fg">A plan for “{{ name.trim() }}”</h3>
            <p class="text-sm text-fg-muted">
              Billed per member, separately from your other workspaces.
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md border border-border px-3 py-1 text-sm text-fg-muted transition hover:bg-surface-2 hover:text-fg"
            @click="step = 'details'"
          >
            Back
          </button>
        </div>

        <!-- No free tier: this whole step exists because the free allowance is
             already spent. Offering it would be offering the refusal again. -->
        <PlanPicker :busy="saving ? chosen : null" action="Create it on" @choose="chooseForNew" />
      </template>

      <template v-else>
        <h3 class="text-lg font-semibold text-fg">
          {{ mode === "create" ? "New workspace" : "Customize workspace" }}
        </h3>

        <!-- preview + name -->
        <div class="flex items-center gap-3">
          <WorkspaceIcon :icon="icon" :color="color" :image-src="imageUrl" size="lg" />
          <input
            v-model="name"
            placeholder="Workspace name"
            class="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            @keydown.enter="save()"
          />
        </div>

        <IconPicker
          :icon="icon"
          :color="color"
          :image-url="imageUrl"
          allow-upload
          @update:icon="icon = $event"
          @update:color="color = $event"
          @update:image="image = $event"
          @update:preparing="preparingImage = $event"
        />

        <!-- Wanting another workspace is the "I got a second client" moment. It
             has to read as an offer, not as a failed save. -->
        <PlanLimitNotice
          :error="planError"
          :workspace-id="currentWorkspaceId"
          :can-manage-billing="canManageBilling"
          :allow-paid-create="mode === 'create'"
          :busy="saving"
          @pick-plan="step = 'plan'"
        />

        <!-- Edit only: a workspace that does not exist yet cannot have a folder,
             and the create path already offers one right after it is made. -->
        <LocalFolderSection v-if="mode === 'edit' && workspace" :workspace-id="workspace.id" />

        <p v-if="error" class="text-sm text-danger">{{ error }}</p>

        <div class="flex justify-end gap-2 pt-1">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="!canSave"
            class="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
            @click="save()"
          >
            {{ saveLabel }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>