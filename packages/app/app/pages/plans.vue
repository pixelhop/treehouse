<script setup lang="ts">
// The plan step, shown once straight after signing up.
//
// Two things it is deliberately NOT. It is not a paywall: Seedling is a real
// option on the same row as the paid ones, chosen with one click, and nothing
// here can stop someone reaching their files. And it is not a page anybody has
// to come back to — only sign-up navigates here, so returning users never see
// it again.
//
// It exists because the price was previously invisible in the entire product.
// The only place a number appeared was the Stripe page, which meant the one
// moment someone was most willing to pay — the minute after signing up — passed
// with nothing to say yes to.
definePageMeta({ middleware: "auth", layout: "onboarding" });

const api = useTreehouseApi();
const ws = useWorkspaceData();
const { available, loading } = usePlanOffers();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);

/**
 * Only a PAID plan is marked "current" here.
 *
 * Every new workspace is already on Seedling, so passing it through would mark
 * the free tier as current and render it as inert text — leaving no way off
 * this page except paying. That is precisely the paywall this step must not be:
 * on this page the free tier is the "continue" button.
 *
 * A returning user arriving via OAuth on the sign-up page still sees the tier
 * they actually pay for marked, rather than being sold it again.
 */
const paidCurrentPlan = computed(() => {
  const plan = ws.usage.value?.billing.plan;
  return plan && plan !== "seedling" ? plan : null;
});

/**
 * People in the workspace being bought for, so the cards quote its real cost.
 *
 * Usually one — this page follows sign-up. But a returning user arriving
 * through OAuth lands here too, and theirs may be a team; the per-member price
 * alone would understate what they are about to be charged.
 */
const members = computed(() => ws.usage.value?.billing.members);

// A deployment with nothing to sell must not show a step about buying. Self-host
// goes straight through as though this page did not exist.
watchEffect(() => {
  if (!loading.value && !available.value) void navigateTo("/dashboard", { replace: true });
});

async function choose({ plan, annual }: { plan: string; annual: boolean }) {
  if (busy.value) return;
  error.value = null;

  if (plan === "seedling") {
    // Nothing to record: every workspace is already created on Seedling. The
    // choice was to keep it, and keeping it is the absence of an action.
    await navigateTo("/dashboard");
    return;
  }

  const workspaceId = ws.workspaceId.value;
  if (!workspaceId) {
    error.value = "Your workspace is still being set up. Try again in a moment.";
    return;
  }

  busy.value = plan;
  try {
    const { url } = await api.startCheckout(workspaceId, plan as "grove" | "forest", annual);
    openBillingUrl(url);
  } catch {
    // Billing being briefly unreachable must not trap someone on the step
    // between signing up and their files — the free option is still right there.
    error.value = "Could not open checkout. You can start free and upgrade any time.";
    busy.value = null;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-8 py-10 sm:py-16">
    <div class="th-grow-in">
      <p class="th-rise text-[13px] font-semibold tracking-[0.18em] text-accent uppercase">
        Last thing
      </p>
      <h1
        class="th-rise mt-3 font-display text-[44px] leading-[1.05] font-semibold tracking-tight text-fg"
        style="--th-delay: 60ms"
      >
        Pick a plan
      </h1>
      <p
        class="th-rise mt-4 max-w-xl text-[16px] leading-relaxed text-fg-muted"
        style="--th-delay: 120ms"
      >
        Your workspace already works. Free covers one workspace for one person — enough to keep your
        own files in, and to see whether your agents get on with it. You can change this whenever
        you like.
      </p>

      <div class="th-rise mt-8" style="--th-delay: 180ms">
        <!-- OAuth on the sign-up page also lands here for someone who already
             had an account, so the picker is told what they are on: they see
             "Current plan" rather than being sold what they already pay for. -->
        <PlanPicker
          include-free
          action="Choose"
          free-action="Start on"
          :busy="busy"
          :current-plan="paidCurrentPlan"
          :members="members"
          @choose="choose"
        />
        <p v-if="error" class="pt-3 text-center text-sm text-danger">{{ error }}</p>
      </div>
    </div>
  </div>
</template>