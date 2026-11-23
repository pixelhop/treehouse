<script setup lang="ts">
import type { PlanOffer } from "~/composables/useTreehouseApi";

// The plan chooser. Every place in the product that asks for money renders this
// one component, so the tiers, the prices and the billing interval cannot drift
// apart between the sidebar, the 402 notice, the create dialog and onboarding.
//
// Before this existed, all four of those hardcoded `grove` and monthly — which
// meant Forest and both annual prices were configured in Stripe, tax-coded, and
// completely unreachable. We had four prices and a UI that could buy one.

const props = defineProps<{
  /** Marked as "Current plan" and not offered as a choice. */
  currentPlan?: string | null;
  /**
   * Show the free tier. On is right for onboarding, where a choice that omits
   * the free option is not a choice; off is right for an upgrade prompt, where
   * "stay as you are" is the Cancel button rather than a tier.
   */
  includeFree?: boolean;
  /** Slug currently being acted on, so the card can say so and the rest lock. */
  busy?: string | null;
  /** Label for the buy button; the tier name is appended. */
  action?: string;
  /** Label for the free tier's button; the tier name is appended. */
  freeAction?: string;
  /**
   * How many people are already in the workspace being bought for.
   *
   * Every paid tier is priced per member and checkout opens with a seat for
   * each of them, so a five-person workspace shown only "$12 per member" is
   * being quoted a price it will never pay. Omitted where there is nothing to
   * count yet — a workspace that does not exist — and the per-member figure
   * stands alone.
   */
  members?: number;
}>();

const emit = defineEmits<{
  choose: [{ plan: "seedling" | "grove" | "forest"; annual: boolean }];
}>();

const { plans, available, loading, failed } = usePlanOffers();

// Monthly by default. Annual is the better deal and it is tempting to preselect
// it, but defaulting someone into a year-long commitment they did not ask for
// is the kind of thing that generates refund requests.
const annual = ref(false);

const shown = computed(() =>
  plans.value.filter((p) => (p.paid ? true : props.includeFree === true)),
);

/** Any tier with two intervals is enough to justify the toggle. */
const canSwitchInterval = computed(() => plans.value.some((p) => p.monthly && p.annual));

function priceFor(offer: PlanOffer) {
  return annual.value ? (offer.annual ?? offer.monthly) : offer.monthly;
}

/** The headline number: always per member, per month, whatever the interval. */
function headline(offer: PlanOffer): string | null {
  const price = priceFor(offer);
  if (!price) return null;
  return formatMoney(perMonth(price), price.currency);
}

/**
 * What actually leaves the bank, when that differs from the headline.
 *
 * Only paying yearly makes it differ now: the headline is always a per-month
 * figure, so a yearly plan needs the real charge spelled out beside it rather
 * than discovered at checkout. There is no seat minimum on any tier to correct
 * for — both are sold per member from one.
 */
function billingNote(offer: PlanOffer): string | null {
  const price = priceFor(offer);
  if (!price || price.interval !== "year") return null;
  return `${formatMoney(price.unitAmount, price.currency)} per year, per member`;
}

/**
 * What this workspace, with the people already in it, would cost.
 *
 * The headline is per member because that is how the tier is priced, but for
 * anyone past the first person it is not the bill. Checkout charges for every
 * existing member from the first invoice, so the total belongs on the card
 * rather than on Stripe's page as a surprise.
 */
function teamTotal(offer: PlanOffer): string | null {
  const people = props.members ?? 1;
  const price = priceFor(offer);
  if (!offer.paid || !price || people < 2) return null;
  const total = formatMoney(price.unitAmount * people, price.currency);
  return `${people} members: ${total} per ${price.interval === "year" ? "year" : "month"}`;
}

/** The limits worth putting on a card, in the order someone hits them. */
function features(offer: PlanOffer): string[] {
  const h = offer.highlights;
  const num = (n: number) => n.toLocaleString();
  return [
    h.filesPerWorkspace == null ? "Unlimited files" : `${num(h.filesPerWorkspace)} files`,
    h.storageBytesPerWorkspace == null
      ? "Unlimited storage"
      : `${prettyBytes(h.storageBytesPerWorkspace)} storage`,
    h.membersPerOrg == null
      ? "Unlimited members"
      : h.membersPerOrg === 1
        ? "Just you"
        : `${num(h.membersPerOrg)} members`,
    h.shareViewsPerMonth == null
      ? "Unlimited shared views"
      : `${num(h.shareViewsPerMonth)} shared views a month`,
    // History retention is deliberately NOT listed. The catalogue carries a
    // `historyDays` per tier, but nothing enforces or delivers it — no job
    // prunes change events, so every workspace keeps its full history including
    // the free one. Advertising "7 days" against "365 days" as a paid
    // differentiator would have been selling a difference that does not exist.
    // Put it back the day retention is actually implemented.
    h.workspacesPerUser == null ? "Unlimited workspaces" : null,
  ].filter((f): f is string => f !== null);
}

/**
 * Where a tier sits on the ladder, so a move DOWN is not called an upgrade.
 *
 * A Forest customer looking at this was offered "Upgrade to Grove", which is
 * both wrong and slightly insulting — Grove is the smaller plan. The picker
 * shows every tier, so it has to know which direction each one is.
 */
const RANK: Record<string, number> = { seedling: 0, grove: 1, forest: 2 };

function actionFor(offer: PlanOffer): string {
  const current = props.currentPlan;
  if (current && RANK[offer.slug] != null && RANK[current] != null) {
    if (RANK[offer.slug]! < RANK[current]!) return `Switch to ${offer.label}`;
  }
  return `${props.action ?? "Choose"} ${offer.label}`;
}

function pick(offer: PlanOffer) {
  if (props.busy) return;
  emit("choose", { plan: offer.slug, annual: annual.value && !!offer.annual });
}
</script>

<template>
  <div v-if="loading" class="py-6 text-center text-sm text-fg-subtle">Loading plans…</div>

  <!-- Never a dead end. If pricing cannot be read, say so plainly rather than
       rendering empty cards or, worse, cards with no prices on them. -->
  <div v-else-if="failed || !available" class="py-6 text-center text-sm text-fg-subtle">
    Plans aren't available right now.
  </div>

  <div v-else class="space-y-4">
    <div v-if="canSwitchInterval" class="flex items-center justify-center gap-2">
      <div class="inline-flex rounded-full border border-border p-0.5 text-xs">
        <button
          type="button"
          class="rounded-full px-3 py-1 transition"
          :class="annual ? 'text-fg-muted hover:text-fg' : 'bg-accent text-accent-fg'"
          @click="annual = false"
        >
          Monthly
        </button>
        <button
          type="button"
          class="rounded-full px-3 py-1 transition"
          :class="annual ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'"
          @click="annual = true"
        >
          Yearly
        </button>
      </div>
    </div>

    <div class="grid gap-3" :class="shown.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'">
      <div
        v-for="offer in shown"
        :key="offer.slug"
        class="flex flex-col rounded-xl border p-4"
        :class="
          offer.slug === currentPlan ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface'
        "
      >
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-sm font-semibold text-fg">{{ offer.label }}</p>
          <span
            v-if="annualSaving(offer) && annual"
            class="rounded-full bg-accent/15 px-2 py-0.5 text-[0.65rem] font-medium text-accent"
          >
            Save {{ annualSaving(offer) }}%
          </span>
        </div>

        <p class="pt-1">
          <span class="text-2xl font-semibold text-fg">
            {{ offer.paid ? (headline(offer) ?? "—") : "Free" }}
          </span>
          <span v-if="offer.paid && headline(offer)" class="text-xs text-fg-subtle">
            per member / month
          </span>
        </p>
        <p v-if="billingNote(offer)" class="text-xs text-fg-subtle">
          {{ billingNote(offer) }}
        </p>
        <!-- Tax is added at checkout from their address, so the figure above is
             pre-tax. Saying so beats a quoted $12 becoming $14.40 unannounced. -->
        <p v-else-if="offer.paid" class="text-xs text-fg-subtle">plus tax</p>
        <p v-else class="text-xs text-fg-subtle">for one workspace, forever</p>

        <!-- The real bill for this workspace, when it has more than one person
             in it. Shown above the features because it is the number the
             decision is actually made on. -->
        <p v-if="teamTotal(offer)" class="pt-1 text-xs font-medium text-fg">
          {{ teamTotal(offer) }}
        </p>

        <ul class="flex-1 space-y-1 pt-3 text-xs text-fg-muted">
          <li v-for="f in features(offer)" :key="f">{{ f }}</li>
        </ul>

        <p
          v-if="offer.slug === currentPlan"
          class="pt-3 text-center text-xs font-medium text-fg-subtle"
        >
          Current plan
        </p>
        <button
          v-else
          type="button"
          :disabled="!!busy"
          class="mt-3 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
          :class="
            offer.paid
              ? 'bg-accent text-accent-fg hover:bg-accent/90'
              : 'border border-border text-fg hover:bg-surface-2'
          "
          @click="pick(offer)"
        >
          {{
            busy === offer.slug
              ? "Opening…"
              : offer.paid
                ? actionFor(offer)
                : `${freeAction ?? "Stay on"} ${offer.label}`
          }}
        </button>
      </div>
    </div>
  </div>
</template>