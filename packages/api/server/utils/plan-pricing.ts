import { PLAN_PRICING, useStripe } from "./billing";
import { PLAN_CATALOG, PLAN_LABELS, type PlanSlug, billingEnabled, isPaidPlan } from "./plans";

// What a plan COSTS, as opposed to what it allows (plans.ts).
//
// The amounts are read from Stripe rather than written down here, and that is
// the whole point of this module. The prices are configured in Stripe, checkout
// charges what Stripe says, and a number typed into a Vue file would drift the
// first time one changed — leaving the app advertising one figure and billing
// another. There is exactly one source of truth for money, and it is not us.
//
// Fails open in the direction of silence: if Stripe cannot be reached, a plan
// comes back with `null` prices and the UI omits the amount rather than
// inventing one or hiding the plan.

/** One purchasable price, per seat, in minor units (cents). */
export interface PlanPrice {
  interval: "month" | "year";
  unitAmount: number;
  currency: string;
}

/** The limits a tier is actually sold on. `null` means unlimited. */
export interface PlanHighlights {
  filesPerWorkspace: number | null;
  storageBytesPerWorkspace: number | null;
  maxFileBytes: number | null;
  membersPerOrg: number | null;
  shareViewsPerMonth: number | null;
  historyDays: number | null;
  workspacesPerUser: number | null;
}

export interface PlanOffer {
  slug: PlanSlug;
  label: string;
  paid: boolean;
  monthly: PlanPrice | null;
  annual: PlanPrice | null;
  highlights: PlanHighlights;
}

/**
 * Prices change about once a year, so this is cached hard. A stale price for a
 * few minutes is harmless — checkout re-reads Stripe and charges correctly
 * either way; what matters is not hammering Stripe on every page load.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { offers: PlanOffer[]; expiresAt: number } | null = null;

/** Test seam: drop the memoised prices. */
export function clearPlanPricingCache(): void {
  cache = null;
}

function highlightsFor(slug: PlanSlug): PlanHighlights {
  const entry = PLAN_CATALOG[slug];
  return {
    filesPerWorkspace: entry.filesPerWorkspace,
    storageBytesPerWorkspace: entry.storageBytesPerWorkspace,
    maxFileBytes: entry.maxFileBytes,
    membersPerOrg: entry.membersPerOrg,
    shareViewsPerMonth: entry.shareViewsPerMonth,
    historyDays: entry.historyDays,
    workspacesPerUser: entry.workspacesPerUser,
  };
}

/** Look every configured price up in Stripe, tolerating individual failures. */
async function loadPrices(): Promise<Map<string, PlanPrice>> {
  const found = new Map<string, PlanPrice>();
  const stripe = useStripe();
  if (!stripe) return found;

  await Promise.all(
    PLAN_PRICING.map(async (p) => {
      const priceId = process.env[p.priceEnv];
      if (!priceId) return;
      try {
        const price = await stripe.prices.retrieve(priceId);
        // Only the two intervals this product sells. A price configured as
        // weekly or daily is a misconfiguration, and showing it would promise a
        // billing cadence the checkout route cannot ask for. Spelled out rather
        // than narrowed, because Stripe types `interval` as an open enum that a
        // `!==` check does not narrow.
        const raw = price.recurring?.interval;
        const interval: PlanPrice["interval"] | null =
          raw === "month" ? "month" : raw === "year" ? "year" : null;
        if (!interval) return;
        if (typeof price.unit_amount !== "number") return;
        found.set(p.name, {
          interval,
          unitAmount: price.unit_amount,
          currency: price.currency,
        });
      } catch (err) {
        // One unreadable price must not cost the others their amounts.
        console.error(`could not read Stripe price for ${p.name}:`, err);
      }
    }),
  );
  return found;
}

/**
 * Every tier a user can choose between, cheapest first, with live prices.
 *
 * Includes the free tier: "choose a plan" that omits the free one is not a
 * choice, it is a paywall — and Seedling is a real product someone may
 * deliberately stay on.
 */
export async function planOffers(): Promise<PlanOffer[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.offers;

  const prices = await loadPrices();
  const offers: PlanOffer[] = (["seedling", "grove", "forest"] as const).map((slug) => ({
    slug,
    label: PLAN_LABELS[slug],
    paid: isPaidPlan(slug),
    monthly: prices.get(slug) ?? null,
    annual: prices.get(`${slug}-annual`) ?? null,
    highlights: highlightsFor(slug),
  }));

  cache = { offers, expiresAt: now + CACHE_TTL_MS };
  return offers;
}

/**
 * Whether this deployment can sell anything at all.
 *
 * A self-hosted instance has no Stripe keys and no billing flag, and must not
 * be shown a plan picker for plans it does not enforce or sell.
 */
export function pricingAvailable(): boolean {
  return billingEnabled() && useStripe() !== null;
}