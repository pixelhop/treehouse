<script setup lang="ts">
import IconInvite from "~icons/solar/users-group-rounded-linear";

// The dashboard's "Invite someone" card. Viewers can't invite, so the dashboard
// doesn't show it to them.
const api = useTreehouseApi();
const ws = useWorkspaceData();

// The invite is for ONE workspace — the one the switcher currently has open —
// so the card names it rather than talking vaguely about "your team".
const currentWorkspaceName = computed(() => ws.workspace.value?.name ?? "");

// Shareable invite link for the current workspace.
const inviteUrl = ref("");
const inviteExpiry = ref("");
const creatingInvite = ref(false);
const inviteRole = ref<"member" | "viewer">("member");
const inviteError = ref("");
// A plan refusal is kept as the ERROR OBJECT, not flattened to a string.
// "Couldn't create an invite link" was the whole message a Seedling user got for
// hitting the one-member limit — the single highest-intent upgrade moment in the
// product, rendered as an unexplained failure with nowhere to go.
const invitePlanError = ref<unknown>(null);
const copied = ref(false);

// Creating an invite for a different workspace must not leave the previous
// workspace's link on screen looking like it belongs to this one.
watch(
  () => ws.workspaceId.value,
  () => {
    inviteUrl.value = "";
    inviteError.value = "";
  },
);

const httpStatus = (e: unknown) =>
  (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status;

async function createInvite() {
  inviteError.value = "";
  invitePlanError.value = null;
  creatingInvite.value = true;
  try {
    // Fall back to the server's idea of "your workspace" if the switcher hasn't
    // resolved one yet (e.g. the list is still loading).
    const workspaceId = ws.workspaceId.value ?? (await api.getWorkspace()).id;
    const res = await api.createInvite(workspaceId, {
      expiresInDays: 7,
      role: inviteRole.value,
    });
    inviteUrl.value = res.url;
    inviteExpiry.value = new Date(res.expiresAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch (e) {
    // 402 means "your plan doesn't include this", which is an offer rather than
    // a failure. Anything else really is a failure and reads as one.
    if (httpStatus(e) === 402) invitePlanError.value = e;
    else inviteError.value = "Couldn't create an invite link.";
  } finally {
    creatingInvite.value = false;
  }
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    // clipboard blocked — the user can select the text manually
  }
}
</script>

<template>
  <div class="rounded-2xl border border-border bg-surface p-5">
    <span
      class="grid h-9 w-9 place-items-center rounded-lg bg-accent/10 text-accent"
      aria-hidden="true"
    >
      <IconInvite class="h-4 w-4" />
    </span>
    <h3 class="mt-3.5 text-[15px] font-semibold text-fg">
      Invite someone
      <span v-if="currentWorkspaceName" class="font-normal text-fg-muted"
        >to {{ currentWorkspaceName }}</span
      >
    </h3>
    <p class="mt-1.5 text-sm leading-relaxed text-fg-muted">
      Anyone who opens your link and signs in becomes a member of this workspace. Your other
      workspaces stay private.
    </p>
    <!-- On a paid plan an invite costs money. Saying so here, next to the
         button, beats letting them find out on the next invoice. -->
    <SeatCostNote class="mt-1.5 leading-relaxed" :billing="ws.usage.value?.billing" />

    <div v-if="!inviteUrl" class="mt-3">
      <label class="mb-2.5 flex items-center gap-2 text-[13px] text-fg-muted">
        They can
        <select
          v-model="inviteRole"
          class="rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none"
        >
          <option value="member">edit files</option>
          <option value="viewer">view and comment only</option>
        </select>
      </label>
      <button
        type="button"
        :disabled="creatingInvite"
        class="text-sm font-medium text-accent transition hover:opacity-80 disabled:opacity-60"
        @click="createInvite"
      >
        {{ creatingInvite ? "Creating…" : "Create invite link →" }}
      </button>
      <p v-if="inviteError" class="mt-2 text-sm text-danger">
        {{ inviteError }}
      </p>
      <!-- Wanting a teammate is the moment someone outgrows the free tier.
           It has to read as an offer with a way through, not a red error. -->
      <PlanLimitNotice
        v-if="invitePlanError"
        class="mt-3"
        :error="invitePlanError"
        :workspace-id="ws.workspaceId.value ?? undefined"
        :can-manage-billing="ws.usage.value?.billing.canManageBilling ?? true"
      />
    </div>

    <div v-else class="mt-3 space-y-2">
      <div
        class="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm"
      >
        <code class="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{{ inviteUrl }}</code>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium transition hover:bg-app"
          :class="copied ? 'text-success' : 'text-fg-muted hover:text-fg'"
          @click="copyInvite"
        >
          {{ copied ? "Copied" : "Copy" }}
        </button>
      </div>
      <p class="text-[13px] text-fg-subtle">
        Expires {{ inviteExpiry }}. Anyone with the link can join until then.
      </p>
      <button
        type="button"
        class="text-sm font-medium text-accent transition hover:opacity-80"
        @click="createInvite"
      >
        Create another →
      </button>
    </div>
  </div>
</template>