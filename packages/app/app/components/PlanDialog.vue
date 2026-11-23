<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";

// The plan picker as a modal, for buying a plan for a workspace that already
// exists.
//
// A modal because the two places that open it — the sidebar's plan section and
// the 402 upgrade notice — are both too narrow to lay three tiers out in. The
// alternative was what we had: a single hardcoded "Upgrade to Grove" button,
// which quietly decided both the tier and the billing interval on the
// customer's behalf.

const props = defineProps<{
  workspaceId: string;
  /** Marked as current, so nobody is sold what they already pay for. */
  currentPlan?: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const api = useTreehouseApi();
const busy = ref<string | null>(null);
const error = ref<string | null>(null);

/**
 * People already in this workspace, so the cards quote what THIS workspace
 * costs rather than what one seat costs.
 *
 * Read here rather than taken as a prop on purpose. Three places open this
 * dialog, and one of them — the 402 notice — has only a workspace id to hand;
 * a caller that could not supply the count would quietly fall back to quoting a
 * one-person price, which is the exact bug this change exists to remove. Making
 * it the dialog's own business means no caller can get it wrong.
 *
 * The key and staleTime match the workspace usage query, so where the parent
 * has already loaded this it is a cache read rather than a second request. If
 * it fails, the picker shows the per-member price alone — honest, just less
 * complete.
 */
const usage = useQuery({
  queryKey: ["usage", computed(() => props.workspaceId)],
  queryFn: () => api.getUsage(props.workspaceId),
  staleTime: 30 * 1000,
});
const members = computed(() => usage.data.value?.billing.members);

async function choose({ plan, annual }: { plan: string; annual: boolean }) {
  // Seedling is not sold, and downgrading is a billing-portal action rather
  // than a checkout one — the picker only offers it when free is included,
  // which this dialog does not do.
  if (plan === "seedling" || busy.value) return;
  busy.value = plan;
  error.value = null;
  try {
    const { url } = await api.startCheckout(props.workspaceId, plan as "grove" | "forest", annual);
    openBillingUrl(url);
  } catch {
    error.value = "Could not open checkout. Please try again.";
    busy.value = null;
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-3xl space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="text-lg font-semibold text-fg">Choose a plan</h3>
          <p class="text-sm text-fg-muted">
            Billed per member. Every plan covers this workspace on its own.
          </p>
        </div>
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1 text-sm text-fg-muted transition hover:bg-surface-2 hover:text-fg"
          @click="emit('close')"
        >
          Cancel
        </button>
      </div>

      <PlanPicker
        :current-plan="currentPlan"
        :members="members"
        :busy="busy"
        action="Upgrade to"
        @choose="choose"
      />

      <p v-if="error" class="text-center text-sm text-danger">{{ error }}</p>
    </div>
  </div>
</template>