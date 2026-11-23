import { afterEach, describe, expect, it } from "vite-plus/test";
import "./env";

// What the plan picker is told, and what it is told when Stripe is unreachable.
//
// The rule this file exists to hold: prices come from Stripe or they come from
// nowhere. There is no fallback table, because a fallback table is exactly how
// an app ends up advertising one price and charging another.

const { planOffers, pricingAvailable, clearPlanPricingCache } =
  await import("../server/utils/plan-pricing");
const { clearPlanCache } = await import("../server/utils/plans");

afterEach(() => {
  delete process.env.BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  clearPlanPricingCache();
  clearPlanCache();
});

describe("plan offers", () => {
  it("offers the free tier alongside the paid ones", async () => {
    // A picker that omits the free plan is a paywall. Seedling is a real tier
    // someone may deliberately choose and stay on.
    const offers = await planOffers();
    expect(offers.map((o) => o.slug)).toEqual(["seedling", "grove", "forest"]);
    expect(offers[0]?.paid).toBe(false);
    expect(offers[1]?.paid).toBe(true);
  });

  it("carries the limits each tier is actually sold on", async () => {
    const [seedling, grove] = await planOffers();
    expect(seedling?.highlights.filesPerWorkspace).toBe(1_000);
    expect(seedling?.highlights.membersPerOrg).toBe(1);
    expect(seedling?.highlights.shareViewsPerMonth).toBe(500);
    // Paid tiers are unlimited where the free one is capped; `null` is the
    // wire format for that and the UI renders it as "Unlimited".
    expect(grove?.highlights.filesPerWorkspace).toBe(25_000);
    expect(grove?.highlights.membersPerOrg).toBeNull();
    expect(grove?.highlights.shareViewsPerMonth).toBeNull();
  });

  it("puts no seat floor on any tier", async () => {
    // Forest used to be sold from five seats, which made a capacity upgrade
    // into a team-size gate: someone alone with 150,000 files had to buy four
    // seats they had nobody to fill. Both tiers are now sold per member from
    // one, so nothing in the offer describes a minimum.
    const offers = await planOffers();
    for (const offer of offers) {
      expect(offer).not.toHaveProperty("minSeats");
    }
  });

  it("omits prices rather than inventing them when Stripe is absent", async () => {
    // No Stripe key: every tier still comes back, with null prices. The picker
    // then renders the tiers without amounts instead of showing a made-up
    // number or hiding the plans entirely.
    const offers = await planOffers();
    for (const offer of offers) {
      expect(offer.monthly).toBeNull();
      expect(offer.annual).toBeNull();
    }
  });

  it("has nothing to sell when billing is off", () => {
    // The self-host answer. A deployment that enforces no limits must not show
    // a plan picker for plans it does not sell.
    expect(pricingAvailable()).toBe(false);

    process.env.BILLING_ENABLED = "1";
    // Billing on but no Stripe configured is still nothing to sell.
    expect(pricingAvailable()).toBe(false);
  });
});