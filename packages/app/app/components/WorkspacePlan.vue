<script setup lang="ts">
import type { WorkspaceBilling } from "~/composables/useTreehouseApi";

// The workspace's plan, always visible in the info panel.
//
// This exists because the product could take someone's money and then never
// mention it again: before this, a paying customer saw "2 of 25,000 used" and
// nowhere the word "Grove". It is also the only route to upgrading that does not
// require failing at something first — the other one lives inside a 402 notice,
// which a happy free user who would gladly pay never sees.

const props = defineProps<{
  workspaceId: string;
  billing: WorkspaceBilling;
}>();

const api = useTreehouseApi();
const busy = ref<"portal" | null>(null);
const error = ref<string | null>(null);
// Buying opens the picker; only the portal is a straight redirect from here.
// The sidebar is far too narrow to lay tiers out in, and the button that used
// to sit here chose both the tier and the billing interval for the customer.
const picking = ref(false);

/** A renewal date reads better than an ISO string in a sidebar. */
const periodEnd = computed(() => {
  const iso = props.billing.periodEnd;
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
});

async function openPortal() {
  if (busy.value) return;
  busy.value = "portal";
  error.value = null;
  try {
    const { url } = await api.openBillingPortal(props.workspaceId);
    openBillingUrl(url);
  } catch {
    // Never a dead end: billing being briefly unreachable must not look like a
    // broken product.
    error.value = "Could not open billing.";
    busy.value = null;
  }
}
</script>

<template>
  <section class="space-y-1.5 border-t border-border pt-3">
    <p class="panel-heading">Plan</p>

    <div class="flex items-baseline justify-between gap-2">
      <p class="text-sm font-medium text-fg">{{ billing.planLabel }}</p>
      <!-- Seats are what the money is actually counted in, so they belong next
           to the plan rather than buried in a billing screen. -->
      <p v-if="billing.seats" class="text-xs text-fg-subtle">
        {{ billing.seats }} {{ billing.seats === 1 ? "seat" : "seats" }}
      </p>
    </div>

    <!-- Cancelled but still inside the paid period: say when it ends, because
         "cancelled" alone reads as though access has already gone. -->
    <p v-if="billing.cancelAtPeriodEnd && periodEnd" class="text-xs text-warning">
      Ends {{ periodEnd }}
    </p>
    <!-- Only a healthy subscription "renews". On a failing one the period end
         is in the PAST — the date the payment was due — so calling it a renewal
         tells the customer their billing is fine at the exact moment it is not. -->
    <p
      v-else-if="billing.paid && periodEnd && billing.grace === 'none'"
      class="text-xs text-fg-subtle"
    >
      Renews {{ periodEnd }}
    </p>
    <p v-else-if="billing.paid && periodEnd" class="text-xs text-warning">
      Payment due {{ periodEnd }}
    </p>

    <!-- Controls are shown only to someone who can actually use them. A member
         offered an upgrade button would get a 403 from a route that correctly
         refuses them. -->
    <div v-if="billing.canManageBilling" class="flex flex-wrap gap-2 pt-1">
      <button
        v-if="!billing.paid"
        type="button"
        :disabled="busy !== null"
        class="rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
        @click="picking = true"
      >
        <!-- A workspace created to be paid for was never on a plan to be
             "upgraded" from — it is one unfinished step, not a change of mind. -->
        {{ billing.grace === "awaiting_payment" ? "Finish checkout" : "Upgrade" }}
      </button>
      <button
        v-if="billing.hasBillingAccount"
        type="button"
        :disabled="busy !== null"
        class="rounded-md border border-border px-3 py-1 text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-50"
        @click="openPortal()"
      >
        {{ busy === "portal" ? "Opening…" : "Manage billing" }}
      </button>
    </div>

    <p v-if="error" class="text-xs text-danger">{{ error }}</p>

    <PlanDialog
      v-if="picking"
      :workspace-id="workspaceId"
      :current-plan="billing.plan"
      @close="picking = false"
    />
  </section>
</template>