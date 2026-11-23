<script setup lang="ts">
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import IconCheck from "~icons/solar/check-circle-bold";
import IconAdd from "~icons/solar/add-circle-linear";
import IconEdit from "~icons/solar/pen-2-linear";
import IconChevron from "~icons/solar/alt-arrow-down-linear";

const ws = useWorkspaceData();
const api = useTreehouseApi();
const qc = useQueryClient();

const menuOpen = ref(false);
const dialog = ref<null | "create" | "edit">(null);

function switchTo(id: string) {
  menuOpen.value = false;
  if (id !== ws.workspaceId.value) navigateTo(`/w/${id}`);
}

// The image is uploaded as a second step: its bytes need a workspace to belong
// to, and on edit the icon pointer is set server-side by the upload itself.
type SavePayload = {
  name: string;
  icon: string | null;
  color: string;
  image: Blob | null;
  plan?: "grove" | "forest";
  annual?: boolean;
};

// A create that got as far as the workspace but failed on the icon upload must
// not create a SECOND workspace when the user retries — remember what landed.
const createdId = ref<string | null>(null);

// A refused creation (402) is not an error state — it is the "I got a second
// client" moment, and the dialog stays open showing the upgrade offer.
const createError = ref<unknown>(null);

// Set when the workspace being created is one the user is buying. Held here
// rather than read back off the result because the redirect happens after
// creation succeeds, on a workspace that did not exist a moment ago.
const buying = ref<{ plan: "grove" | "forest"; annual: boolean } | null>(null);

const createMut = useMutation({
  mutationFn: async ({ image, annual: _annual, ...input }: SavePayload) => {
    createError.value = null;
    buying.value = input.plan ? { plan: input.plan, annual: _annual === true } : null;
    // A retry after the icon upload failed patches the workspace that already
    // landed; `plan` is a creation-time intent, so it does not belong on that.
    const { plan: _plan, ...patch } = input;
    const created = createdId.value
      ? await api.updateWorkspace(createdId.value, patch)
      : await api.createWorkspace(input);
    createdId.value = created.id;
    return image ? await api.uploadWorkspaceIcon(created.id, image) : created;
  },
  onError: (err) => {
    createError.value = err;
    buying.value = null;
  },
  onSuccess: async (w) => {
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
    createdId.value = null;

    // Bought, not merely created: straight to Stripe for the workspace that was
    // just made. It is held read-only until its subscription starts, so landing
    // them inside it with no prompt would be the one genuinely confusing
    // outcome.
    const bought = buying.value;
    if (bought) {
      buying.value = null;
      try {
        const { url } = await api.startCheckout(w.id, bought.plan, bought.annual);
        // In the shell the payment page opens in the system browser and this
        // window stays where it is, so land in the new workspace — it explains
        // that it is waiting on payment and offers checkout again. In a browser
        // the page is already leaving, and navigating would cancel that.
        if (openBillingUrl(url) === "external") {
          dialog.value = null;
          navigateTo(`/w/${w.id}`);
        }
        return;
      } catch {
        // Checkout being unreachable must not strand them. The workspace exists,
        // so land in it — the sidebar's plan section offers checkout again.
        dialog.value = null;
        navigateTo(`/w/${w.id}`);
        return;
      }
    }

    dialog.value = null;
    // A brand-new workspace has no folder attached to it, and nothing else in the
    // web UI mentions that folders are possible. Land on the hand-off (R6/U7),
    // which offers the app or the CLI and links on into the workspace either way.
    //
    // The page adapts to the surface: in a browser it offers the app or the CLI;
    // inside the app it offers to pick a folder straight away (there is nothing
    // to download). Either way it is an offer with a way past it.
    //
    // `created=1` lets the in-app page go straight to choosing the folder: the user
    // just made this workspace in the desktop app, so asking "sync a folder?" first
    // was one more click between them and the thing they came to do. The folder
    // picker's Cancel is the "not now".
    navigateTo(`/connect?workspace=${encodeURIComponent(w.id)}&created=1`);
  },
});

const updateMut = useMutation({
  mutationFn: async (vars: { id: string; patch: SavePayload }) => {
    const { image, ...patch } = vars.patch;
    // The upload sets `icon` itself, so it goes last and wins.
    const updated = await api.updateWorkspace(vars.id, patch);
    return image ? api.uploadWorkspaceIcon(vars.id, image) : updated;
  },
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
    void qc.invalidateQueries({ queryKey: ["workspace-meta"] });
    dialog.value = null;
  },
});

// Closing the dialog ends the attempt: the retained id must not follow the user
// into the NEXT "New workspace", where it would quietly rename the workspace
// they abandoned instead of creating one. The stale error goes with it.
watch(dialog, () => {
  createdId.value = null;
  createError.value = null;
  buying.value = null;
  createMut.reset();
  updateMut.reset();
});

const saving = computed(() => createMut.isPending.value || updateMut.isPending.value);
// A 402 is NOT reported here: PlanLimitNotice turns that one into the upgrade
// offer, and saying "couldn't save" beside it would read as a bug. Everything
// else — an icon upload that failed, a dropped connection — belongs inline.
const saveError = computed(() => {
  const e = (createMut.error.value ?? updateMut.error.value) as {
    statusCode?: number;
    status?: number;
  } | null;
  if (!e || (e.statusCode ?? e.status) === 402) return null;
  return "Couldn't save those changes. Check your connection and try again.";
});

function onSave(v: SavePayload) {
  if (dialog.value === "create") createMut.mutate(v);
  else if (ws.workspaceId.value) updateMut.mutate({ id: ws.workspaceId.value, patch: v });
}
</script>

<template>
  <div class="relative">
    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-3 text-left transition hover:bg-surface-2"
      @click="menuOpen = !menuOpen"
    >
      <WorkspaceIcon
        :icon="ws.workspace.value?.icon"
        :color="ws.workspace.value?.color"
        :workspace-id="ws.workspace.value?.id"
      />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-fg">
          {{ ws.workspace.value?.name ?? "Treehouse" }}
        </span>
      </span>
      <IconChevron class="h-4 w-4 shrink-0 text-fg-subtle" />
    </button>

    <div
      v-if="menuOpen"
      class="absolute inset-x-2 top-full z-50 mt-1 rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      <button
        v-for="w in ws.workspaces.value"
        :key="w.id"
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-surface-2"
        @click="switchTo(w.id)"
      >
        <WorkspaceIcon :icon="w.icon" :color="w.color" :workspace-id="w.id" size="sm" />
        <span class="min-w-0 flex-1 truncate text-fg">{{ w.name }}</span>
        <IconCheck v-if="w.id === ws.workspaceId.value" class="h-4 w-4 shrink-0 text-accent" />
      </button>

      <hr class="my-1 border-border" />

      <button
        v-if="!ws.viewOnly.value"
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
        @click="
          menuOpen = false;
          dialog = 'edit';
        "
      >
        <IconEdit class="h-4 w-4 text-fg-subtle" /> Customize current
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2"
        @click="
          menuOpen = false;
          dialog = 'create';
        "
      >
        <IconAdd class="h-4 w-4 text-fg-subtle" /> New workspace
      </button>
    </div>
    <div v-if="menuOpen" class="fixed inset-0 z-40" @click="menuOpen = false" />

    <WorkspaceDialog
      v-if="dialog"
      :mode="dialog"
      :workspace="dialog === 'edit' ? ws.workspace.value : null"
      :saving="saving"
      :error="saveError"
      :plan-error="createError"
      :current-workspace-id="ws.workspaceId.value"
      :can-manage-billing="ws.usage.value?.billing.canManageBilling ?? true"
      @save="onSave"
      @close="
        dialog = null;
        createError = null;
      "
    />
  </div>
</template>