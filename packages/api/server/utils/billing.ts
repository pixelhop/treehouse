import { stripe as stripePlugin } from "@better-auth/stripe";
import { usePrismaClient } from "db";
import Stripe from "stripe";
import type { PlanSlug } from "./plans";
import { clearPlanCache } from "./plans";

// Stripe wiring for the better-auth plugin.
//
// Kept out of auth.ts so the plugin's configuration — which is mostly a mapping
// between our plan slugs and Stripe price ids — reads as one thing.
//
// Everything here is inert without STRIPE_SECRET_KEY: `stripeBillingPlugin()`
// returns null and auth.ts omits the plugin entirely, which is what keeps a
// self-hosted or unbilled deployment working with no Stripe account at all.

/**
 * Subscription plans, one per (tier × billing interval).
 *
 * Split by interval rather than using the plugin's `annualDiscountPriceId`
 * because Treehouse bills purely per seat with no base fee. The plugin detects
 * that shape as `priceId === seatPriceId` and manages the Stripe quantity from
 * org membership; an annual-discount price would sit outside that equality and
 * silently lose seat syncing on annual subscriptions.
 *
 * The cost is that `subscription.plan` carries the interval ("grove-annual"),
 * which `planSlugFromSubscription` normalises back to a tier.
 */
interface PlanPricing {
  name: string;
  slug: PlanSlug;
  priceEnv: string;
}

export const PLAN_PRICING: PlanPricing[] = [
  { name: "grove", slug: "grove", priceEnv: "STRIPE_PRICE_GROVE_MONTHLY" },
  { name: "grove-annual", slug: "grove", priceEnv: "STRIPE_PRICE_GROVE_ANNUAL" },
  { name: "forest", slug: "forest", priceEnv: "STRIPE_PRICE_FOREST_MONTHLY" },
  { name: "forest-annual", slug: "forest", priceEnv: "STRIPE_PRICE_FOREST_ANNUAL" },
];

/**
 * Map a stored `subscription.plan` back to a plan tier.
 *
 * Interval is a billing detail, not an entitlement one — Grove grants the same
 * limits whether it is paid monthly or yearly.
 */
export function planSlugFromSubscription(plan: string | null | undefined): PlanSlug | null {
  if (!plan) return null;
  const base = plan.replace(/-annual$/, "");
  return base === "grove" || base === "forest" ? base : null;
}

let cachedClient: Stripe | null = null;

/** The Stripe client, or null when this deployment has no Stripe configured. */
export function useStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!cachedClient) cachedClient = new Stripe(key);
  return cachedClient;
}

/**
 * The better-auth Stripe plugin, or null when Stripe is not configured.
 *
 * Subscriptions reference the ORGANIZATION, not the user: the org is the
 * billing entity and what carries a plan, and a user can belong to several.
 */
export function stripeBillingPlugin() {
  const stripeClient = useStripe();
  if (!stripeClient) return null;

  const plans = PLAN_PRICING.map((p) => {
    const priceId = process.env[p.priceEnv];
    if (!priceId) return null;
    return {
      name: p.name,
      priceId,
      // Equal to priceId on purpose: this is what marks the plan as seat-only —
      // the whole subscription is one per-member line with no base fee, so the
      // Stripe quantity IS the member count.
      //
      // Keeping the quantity equal to the membership is ours to do, not the
      // plugin's: its own seat management only runs for checkouts that declare
      // `customerType: "organization"`, and ours do not (see checkout.post.ts).
      // The checkout route sets the opening quantity and `syncSeatsForOrg`
      // moves it afterwards.
      seatPriceId: priceId,
    };
  }).filter((p): p is { name: string; priceId: string; seatPriceId: string } => p !== null);

  if (plans.length === 0) {
    console.warn("STRIPE_SECRET_KEY is set but no price ids are configured; billing is inert.");
    return null;
  }

  return stripePlugin({
    stripeClient,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    /**
     * Durability layer over every delivered event.
     *
     * The plugin's own subscription write happens separately and is one query,
     * so it stays inline. This adds the recording and the re-fetch: the unique
     * constraint on stripeEventId makes a retried delivery a no-op, and
     * re-reading the object from Stripe removes delivery ORDER as a concern,
     * since Stripe does not guarantee it.
     *
     * Nothing here may throw: an exception would make the plugin return non-2xx
     * and Stripe would redeliver an event we have already applied.
     */
    onEvent: async (event) => {
      // Imported lazily to keep this module free of a cycle: billing-events
      // needs `useStripe` from here.
      const {
        recordStripeEvent,
        markStripeEventProcessed,
        subscriptionIdFromEvent,
        syncSubscriptionFromStripe,
      } = await import("./billing-events");
      try {
        const fresh = await recordStripeEvent(event);
        if (!fresh) return; // already applied; Stripe is retrying
        const subscriptionId = subscriptionIdFromEvent(event);
        if (subscriptionId) await syncSubscriptionFromStripe(subscriptionId);
        clearPlanCache();
        await markStripeEventProcessed(event.id);
      } catch (err) {
        console.error(`stripe event ${event.id} (${event.type}) failed:`, err);
        await markStripeEventProcessed(event.id, err).catch(() => {});
      }
    },
    // Every org is the customer, so there is nothing to create per user.
    createCustomerOnSignUp: false,
    organization: { enabled: true },
    subscription: {
      enabled: true,
      plans,
      /**
       * Put the "Add promotion code" field on Stripe's checkout page.
       *
       * Everything returned here is spread into `checkout.sessions.create`
       * except the handful of keys the plugin owns (mode, customer, the urls,
       * line items, client_reference_id), so this is the supported seam for
       * session options rather than a fork of the plugin.
       *
       * Codes themselves are created and revoked in the Stripe dashboard — this
       * only decides whether a customer is allowed to type one. Nothing is
       * discounted by default.
       */
      getCheckoutSessionParams: () => ({
        params: { allow_promotion_codes: true },
      }),
      /**
       * Who may act on an organization's subscription.
       *
       * Without this the plugin refuses every org reference, and with a naive
       * `true` anyone could start, upgrade or cancel billing on an org they merely
       * know the id of. Restricted to owners and admins: a regular member can use
       * the workspace but must not be able to change what the org is paying.
       */
      authorizeReference: async ({ user, referenceId }) => {
        const membership = await usePrismaClient().member.findFirst({
          where: { organizationId: referenceId, userId: user.id },
          select: { role: true },
        });
        return membership?.role === "owner" || membership?.role === "admin";
      },
    },
  });
}