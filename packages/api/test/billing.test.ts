import { afterEach, describe, expect, it } from "vite-plus/test";
import "./env";

// Stripe plumbing (U6-U8): plan-name mapping, the webhook event log's
// idempotency, and the downgrade ladder.
//
// The ladder is the part that matters most. This is a file workspace whose core
// promise is never losing data, so the tests below are weighted towards proving
// that no billing failure — a lapsed card, a Stripe outage, an unknown status —
// can cost someone access to their own files.

const { usePrismaClient } = await import("db");
const { planSlugFromSubscription } = await import("../server/utils/billing");
const { recordStripeEvent, markStripeEventProcessed, subscriptionIdFromEvent } =
  await import("../server/utils/billing-events");
const { subscriptionState, clearPlanCache, entitlementsForOrg, limitsForPlan, assignPlan } =
  await import("../server/utils/plans");
const { limitsForWorkspace } = await import("../server/utils/quota");

const db = usePrismaClient();
let seq = 0;
const uid = () => `${Date.now()}_${Math.round(Math.random() * 1e9)}_${seq++}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return {
    id,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  } as unknown as Parameters<typeof recordStripeEvent>[0];
}

async function orgWithSubscription(
  plan: string,
  status: string,
  periodEnd: Date | null = new Date(),
) {
  const org = await db.organization.create({ data: { id: `org_b_${uid()}`, name: "B Org" } });
  const user = await db.user.create({
    data: {
      id: `usr_b_${uid()}`,
      name: "B",
      email: `b${uid()}@example.test`,
      emailVerified: true,
    },
  });
  await db.member.create({
    data: { id: `mem_b_${uid()}`, organizationId: org.id, userId: user.id, role: "owner" },
  });
  await db.subscription.create({
    data: {
      id: `sub_${uid()}`,
      plan,
      referenceId: org.id,
      status,
      periodEnd,
      seats: 1,
      stripeSubscriptionId: `sub_stripe_${uid()}`,
    },
  });
  clearPlanCache();
  return org;
}

afterEach(() => {
  delete process.env.BILLING_ENABLED;
  delete process.env.DEFAULT_PLAN_SLUG;
  clearPlanCache();
});

describe("plan name mapping", () => {
  it("maps both billing intervals of a tier to the same entitlement", () => {
    // Interval is a billing detail, not an entitlement one — Grove grants the
    // same limits monthly or yearly.
    expect(planSlugFromSubscription("grove")).toBe("grove");
    expect(planSlugFromSubscription("grove-annual")).toBe("grove");
    expect(planSlugFromSubscription("forest")).toBe("forest");
    expect(planSlugFromSubscription("forest-annual")).toBe("forest");
  });

  it("refuses to invent a tier from an unknown plan name", () => {
    for (const p of [null, undefined, "", "enterprise", "grove-quarterly", "seedling"]) {
      expect(planSlugFromSubscription(p)).toBeNull();
    }
  });
});

describe("webhook event log", () => {
  it("records an event once and reports a redelivery as already seen", async () => {
    // Stripe retries on exponential backoff for up to three days, so duplicate
    // delivery is certain rather than hypothetical.
    const event = stripeEvent(`evt_${uid()}`, "customer.subscription.updated", { id: "sub_x" });
    expect(await recordStripeEvent(event)).toBe(true);
    expect(await recordStripeEvent(event)).toBe(false);
    expect(await recordStripeEvent(event)).toBe(false);

    const rows = await db.stripeEvent.findMany({ where: { stripeEventId: event.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("customer.subscription.updated");
  });

  it("keeps the full payload for replay and audit", async () => {
    const event = stripeEvent(`evt_${uid()}`, "checkout.session.completed", {
      id: "cs_test_1",
      subscription: "sub_from_checkout",
      amount_total: 1200,
    });
    await recordStripeEvent(event);
    const row = await db.stripeEvent.findUnique({ where: { stripeEventId: event.id } });
    const payload = row?.payload as { data?: { object?: { amount_total?: number } } };
    expect(payload?.data?.object?.amount_total).toBe(1200);
  });

  it("records a readable error rather than [object Object]", async () => {
    // This column is read months later when a customer's billing looks wrong;
    // a stringified object would waste the one artifact that could explain it.
    const event = stripeEvent(`evt_${uid()}`, "customer.subscription.deleted", { id: "sub_y" });
    await recordStripeEvent(event);
    await markStripeEventProcessed(event.id, new Error("Stripe API timed out"));

    const row = await db.stripeEvent.findUnique({ where: { stripeEventId: event.id } });
    expect(row?.error).toContain("Stripe API timed out");
    expect(row?.error).not.toContain("[object Object]");
    expect(row?.processedAt).not.toBeNull();
  });

  it("finds the subscription id across the event shapes that carry one", () => {
    expect(
      subscriptionIdFromEvent(stripeEvent("e1", "customer.subscription.created", { id: "sub_a" })),
    ).toBe("sub_a");
    expect(
      subscriptionIdFromEvent(
        stripeEvent("e2", "checkout.session.completed", { subscription: "sub_b" }),
      ),
    ).toBe("sub_b");
    // Expanded rather than a bare id.
    expect(
      subscriptionIdFromEvent(stripeEvent("e3", "invoice.paid", { subscription: { id: "sub_c" } })),
    ).toBe("sub_c");
    // Events with no subscription must not guess one.
    expect(
      subscriptionIdFromEvent(stripeEvent("e4", "customer.created", { id: "cus_x" })),
    ).toBeNull();
  });
});

describe("downgrade ladder", () => {
  it("entitles an active or trialing subscription outright", () => {
    for (const status of ["active", "trialing"]) {
      expect(subscriptionState({ plan: "grove", status, periodEnd: new Date() })).toEqual({
        slug: "grove",
        grace: "none",
      });
    }
  });

  it("keeps paid limits through the grace window after a failure", () => {
    for (const status of ["past_due", "unpaid", "canceled"]) {
      const state = subscriptionState({ plan: "grove", status, periodEnd: daysAgo(3) });
      expect(state).toEqual({ slug: "grove", grace: "grace" });
    }
  });

  it("drops limits only once the window has closed", () => {
    expect(subscriptionState({ plan: "grove", status: "unpaid", periodEnd: daysAgo(13) })).toEqual({
      slug: "grove",
      grace: "grace",
    });
    expect(subscriptionState({ plan: "grove", status: "unpaid", periodEnd: daysAgo(15) })).toEqual({
      slug: "grove",
      grace: "expired",
    });
  });

  it("does not entitle a checkout that was never paid for", async () => {
    // The Stripe plugin writes the subscription row when CHECKOUT IS CREATED,
    // with status "incomplete" and no period end. Treating that as an unknown
    // status meant it entitled the plan — and with no period end there was not
    // even a grace window to expire it. Opening checkout and closing the tab was
    // a permanent free upgrade.
    for (const status of ["incomplete", "incomplete_expired"]) {
      expect(subscriptionState({ plan: "grove", status, periodEnd: null })).toEqual({
        slug: null,
        grace: "none",
      });
    }

    // End to end: the org keeps the free tier it was assigned, not Grove.
    const org = await orgWithSubscription("grove", "incomplete", null);
    await assignPlan(org.id, "seedling");
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    expect((await entitlementsForOrg(org.id)).slug).toBe("seedling");
  });

  it("still entitles a paid subscription that later fails", () => {
    // The guard above must not be reachable from any state a paying customer can
    // be in: Stripe never returns a subscription to `incomplete` once its first
    // payment has succeeded, so every failure mode still lands on the ladder.
    expect(subscriptionState({ plan: "grove", status: "past_due", periodEnd: daysAgo(1) })).toEqual(
      {
        slug: "grove",
        grace: "grace",
      },
    );
  });

  it("treats a status it has never seen as entitling, not as failure", () => {
    // A Stripe status this code has not been taught about must not cost a
    // paying customer their limits.
    const state = subscriptionState({ plan: "forest", status: "some_new_status", periodEnd: null });
    expect(state).toEqual({ slug: "forest", grace: "none" });
  });

  it("never downgrades on absence of data", () => {
    expect(subscriptionState(null)).toEqual({ slug: null, grace: "none" });
    expect(subscriptionState({ plan: null, status: "active" })).toEqual({
      slug: null,
      grace: "none",
    });
  });

  it("resolves an org in grace to its PAID limits", async () => {
    const org = await orgWithSubscription("grove", "past_due", daysAgo(2));
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    const limits = await entitlementsForOrg(org.id);
    expect(limits.slug).toBe("grove");
    expect(limits.grace).toBe("grace");
    // The point: still the paid numbers, not seedling's.
    expect(limits.filesPerWorkspace).toBe(limitsForPlan("grove", 1).filesPerWorkspace);
  });

  it("marks an expired org read-only without changing what it can read", async () => {
    const org = await orgWithSubscription("grove", "unpaid", daysAgo(20));
    const ws = await db.workspace.create({ data: { organizationId: org.id, name: "W" } });
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();

    const limits = await limitsForWorkspace(ws.id);
    expect(limits.readOnly).toBe(true);
  });

  it("is not read-only while still inside the grace window", async () => {
    const org = await orgWithSubscription("grove", "unpaid", daysAgo(5));
    const ws = await db.workspace.create({ data: { organizationId: org.id, name: "W" } });
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    expect((await limitsForWorkspace(ws.id)).readOnly).toBe(false);
  });

  it("is never read-only for an org that simply has no subscription", async () => {
    const org = await db.organization.create({ data: { id: `org_n_${uid()}`, name: "N" } });
    const ws = await db.workspace.create({ data: { organizationId: org.id, name: "W" } });
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    expect((await limitsForWorkspace(ws.id)).readOnly).toBe(false);
  });
});