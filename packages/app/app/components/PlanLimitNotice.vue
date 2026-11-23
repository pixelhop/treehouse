<script setup lang="ts">
// The upgrade prompt. Every plan limit refuses with 402 and a machine-readable
// code (see server/utils/limits.ts), and this turns one into an offer rather
// than a bare failure.
//
// Wanting a second workspace or a second teammate is the highest-intent moment
// in the product — someone just tried to grow their use of it. Surfacing that
// as a raw error reads as a bug and loses the moment.

const props = defineProps<{
  /** An error thrown by the API client, or null when there is nothing to show. */
  error: unknown;
  /** When set, the notice offers a real way out rather than just explaining. */
  workspaceId?: string;
  /**
   * Whether this person can actually buy. Defaults to true so existing call
   * sites keep working, but a member must never be handed a button that the
   * checkout route will correctly refuse.
   */
  canManageBilling?: boolean;
  /**
   * The caller can act on "buy a NEW workspace" rather than "upgrade this one".
   *
   * Only the create dialog can: it holds the name and colour of a workspace that
   * does not exist yet. Everywhere else, hitting the free-workspace cap can only
   * be explained, not fixed on the spot.
   */
  allowPaidCreate?: boolean;
  /** The parent is mid-flight on the paid-create it was asked for. */
  busy?: boolean;
}>();

/**
 * The parent should show its own plan picker, because what is being bought does
 * not exist yet — only it holds the name and colour of the workspace about to be
 * created. Everywhere else this component opens the picker itself.
 */
const emit = defineEmits<{ pickPlan: [] }>();

// Buying an EXISTING workspace a plan happens right here, in a modal, so the
// tier and the billing interval are the customer's choice rather than ours.
const picking = ref(false);

interface PlanLimitData {
  error?: string;
  used?: number;
  limit?: number;
}

/** Pull the plan-limit payload out of an ofetch error, or null if it is not one. */
const limit = computed<PlanLimitData | null>(() => {
  const e = props.error as
    | { statusCode?: number; status?: number; data?: { data?: PlanLimitData } }
    | null
    | undefined;
  if (!e) return null;
  const status = e.statusCode ?? e.status;
  if (status !== 402) return null;
  return e.data?.data ?? null;
});

const COPY: Record<string, { title: string; body: string }> = {
  free_workspace_limit_reached: {
    title: "You've used your free workspace",
    body: "Paid workspaces are unlimited — each one covers its own team, files and share links. Upgrading one frees your free allowance for another.",
  },
  // Same refusal, but somewhere the new workspace can actually be bought. The
  // free one is deliberately never mentioned as the thing to change: someone
  // whose personal files live there should not have to start paying for THOSE
  // in order to have a paid workspace for work.
  free_workspace_limit_reached_paid: {
    title: "Your free workspace is already in use",
    body: "Leave it exactly as it is — this one can be paid instead. It gets its own team, files and share links, and is billed on its own.",
  },
  pending_checkout_limit_reached: {
    title: "You already have a workspace waiting to be paid for",
    body: "It's read-only until its subscription starts. Open it and finish checkout — or delete it — and you can create another.",
  },
  member_limit_reached: {
    title: "Your plan is for one person",
    body: "Upgrading lets you invite teammates. Agents and the people you share links with stay free either way.",
  },
  share_paused: {
    title: "Your share links are paused for this month",
    body: "They have had all the views your plan includes. Upgrading brings every link back immediately.",
  },
};

/** Whether this notice can offer to create the new workspace on a paid plan. */
const paidCreate = computed(
  () =>
    props.allowPaidCreate === true &&
    props.canManageBilling !== false &&
    limit.value?.error === "free_workspace_limit_reached",
);

/** The refusal is "you already have one waiting to be paid for". */
const awaitingCheckout = computed(() => limit.value?.error === "pending_checkout_limit_reached");

const copy = computed(() => {
  const code = limit.value?.error;
  const key = paidCreate.value ? "free_workspace_limit_reached_paid" : code;
  return (
    (key ? COPY[key] : null) ?? {
      title: "Your plan doesn't include this",
      body: "Upgrading lifts the limit.",
    }
  );
});
</script>

<template>
  <div
    v-if="limit"
    class="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-4"
    role="status"
  >
    <p class="text-sm font-semibold text-fg">{{ copy.title }}</p>
    <p class="text-sm text-fg-muted">{{ copy.body }}</p>
    <p v-if="limit.limit != null" class="text-xs text-fg-subtle">
      Using {{ limit.used }} of {{ limit.limit }}.
    </p>
    <!-- Buying the NEW workspace. The parent owns this because only it knows
         what is being created; this component just makes the offer. -->
    <div v-if="paidCreate" class="pt-1">
      <button
        type="button"
        :disabled="busy === true"
        class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
        @click="emit('pickPlan')"
      >
        {{ busy ? "Opening checkout…" : "Choose a plan for it" }}
      </button>
    </div>
    <!-- No upgrade button for a pending checkout: the current workspace is not
         the thing to change, and offering to upgrade it here would repeat the
         exact mistake this whole flow exists to undo. -->
    <div
      v-else-if="workspaceId && props.canManageBilling !== false && !awaitingCheckout"
      class="pt-1"
    >
      <button
        type="button"
        class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90"
        @click="picking = true"
      >
        See plans
      </button>
    </div>
    <!-- Not for a pending checkout: the reader IS the owner there, and the one
         thing they must not be told is to go and ask themselves. -->
    <p v-else-if="workspaceId && !awaitingCheckout" class="pt-1 text-xs text-fg-subtle">
      Ask an owner of this workspace to upgrade.
    </p>
    <slot name="action" />

    <PlanDialog
      v-if="picking && workspaceId"
      :workspace-id="workspaceId"
      @close="picking = false"
    />
  </div>
</template>