<script setup lang="ts">
import type { WorkspaceBilling } from "~/composables/useTreehouseApi";

// The state of a workspace whose subscription has lapsed.
//
// The server has a deliberate ladder — an explicit failure starts a 14-day grace
// window at PAID limits, and only after it closes does the workspace go
// read-only — but none of it was visible. A customer would have watched writes
// start failing with no explanation, which is the worst possible way to learn
// that a card expired.
//
// Nothing here is ever destructive to say: during grace nothing has changed yet,
// and after it reads, moves and deletes all still work. The copy has to carry
// that, or a lapsed customer assumes their files are gone.

const props = defineProps<{
  workspaceId: string;
  billing: WorkspaceBilling;
}>();

const api = useTreehouseApi();
const busy = ref(false);
// A workspace that never paid has no plan to "fix" — it has one to choose. It
// may well have been created as Forest, or as annual, so sending them back to a
// hardcoded Grove monthly would quietly sell them something else.
const picking = ref(false);

const show = computed(() => props.billing.grace !== "none");

const copy = computed(() => {
  // Created as a paid workspace, never paid for. Nothing has gone wrong and
  // nothing is at risk — the checkout was simply not finished — so this reads as
  // an unfinished step rather than a failure.
  if (props.billing.grace === "awaiting_payment") {
    return {
      title: "Finish setting up this workspace",
      body: "It's waiting on its subscription, so it's read-only until then. Nothing here is lost — starting the plan opens it up immediately.",
      action: "Finish checkout",
    };
  }
  if (props.billing.grace === "expired") {
    return {
      title: "This workspace is read-only",
      body: "Your subscription lapsed, so new edits are paused. Everything here is still yours — you can read, move, download and delete as normal, and nothing has been removed. Renewing restores writing immediately.",
      action: "Fix payment",
    };
  }
  return {
    title: "There's a problem with your subscription",
    body: "We could not take the last payment. Nothing has changed yet and your workspace is working normally — updating your payment details keeps it that way.",
    action: "Fix payment",
  };
});

async function manage() {
  if (busy.value) return;
  if (!props.billing.hasBillingAccount) {
    picking.value = true;
    return;
  }
  busy.value = true;
  try {
    const { url } = await api.openBillingPortal(props.workspaceId);
    openBillingUrl(url);
  } catch {
    busy.value = false;
  }
}
</script>

<template>
  <div
    v-if="show"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-sm sm:px-8"
    :class="
      billing.grace === 'expired'
        ? 'border-danger/30 bg-danger/10'
        : 'border-warning/30 bg-warning/10'
    "
    role="status"
  >
    <div class="min-w-0 flex-1">
      <p class="font-medium text-fg">{{ copy.title }}</p>
      <p class="text-fg-muted">{{ copy.body }}</p>
    </div>
    <button
      v-if="billing.canManageBilling"
      type="button"
      :disabled="busy"
      class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
      @click="manage"
    >
      {{ busy ? "Opening…" : copy.action }}
    </button>
    <PlanDialog
      v-if="picking"
      :workspace-id="workspaceId"
      :current-plan="billing.plan"
      @close="picking = false"
    />
    <!-- A member cannot fix this, so tell them who can rather than handing them
         a button that would 403. -->
    <p v-else-if="!billing.canManageBilling" class="shrink-0 text-xs text-fg-subtle">
      {{
        billing.grace === "awaiting_payment"
          ? "Ask an owner to finish setting this up."
          : "Ask an owner to update billing."
      }}
    </p>
  </div>
</template>