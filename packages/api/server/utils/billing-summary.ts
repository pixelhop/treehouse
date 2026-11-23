import { usePrismaClient } from "db";
import {
  isPaidPlan,
  PLAN_LABELS,
  type PlanSlug,
  entitlementsForWorkspace,
  subscriptionState,
} from "./plans";

// What the app needs to render a plan, in one shape.
//
// Everything downstream of this existed server-side already but was never sent
// to the client, which is why a paying customer could not see that they were
// paying. The UI must not derive any of it — a plan name assembled in Vue drifts
// from the catalogue the moment a tier is renamed.

export interface WorkspaceBilling {
  plan: PlanSlug;
  /** Display name — never show the slug. */
  planLabel: string;
  paid: boolean;
  /** Stripe status when there is a subscription; null on a free workspace. */
  status: string | null;
  /** "none" | "grace" | "expired" — drives the banners. */
  grace: string;
  /** Writes are refused because the grace window closed. */
  readOnly: boolean;
  /** Seats billed. Null when nothing is billed. */
  seats: number | null;
  /**
   * People in this workspace — what a checkout will actually bill for.
   *
   * Distinct from `seats`, which is what Stripe is charging for TODAY. On a
   * workspace that has not bought anything yet there are no seats but there are
   * people, and quoting a single-seat price to a five-person team is how the
   * plan picker came to advertise a number nobody would ever be charged.
   */
  members: number;
  /**
   * How often the subscription bills, so the UI can say what a seat costs in the
   * customer's own terms rather than always quoting a monthly figure.
   */
  interval: "month" | "year" | null;
  /** End of the current period, ISO. Renewal date, or when access changes. */
  periodEnd: string | null;
  /** Set when the customer has cancelled but the period has not ended. */
  cancelAtPeriodEnd: boolean;
  /** Whether THIS caller may change the plan or open the billing portal. */
  canManageBilling: boolean;
  /** Whether a portal session can be opened (needs an existing customer). */
  hasBillingAccount: boolean;
}

export async function billingForWorkspace(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceBilling> {
  const db = usePrismaClient();
  const limits = await entitlementsForWorkspace(workspaceId);

  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });

  const [membership, subscription, org, memberCount] = ws
    ? await Promise.all([
        db.member.findFirst({
          where: { organizationId: ws.organizationId, userId },
          select: { role: true },
        }),
        db.subscription.findFirst({
          where: { referenceId: ws.organizationId },
          orderBy: { periodEnd: "desc" },
          select: {
            plan: true,
            status: true,
            seats: true,
            periodEnd: true,
            cancelAtPeriodEnd: true,
            stripeCustomerId: true,
          },
        }),
        db.organization.findUnique({
          where: { id: ws.organizationId },
          select: { stripeCustomerId: true },
        }),
        // Counted whatever the plan is: it is what the NEXT checkout bills for,
        // so it has to be known before anything has been bought.
        db.member.count({ where: { organizationId: ws.organizationId } }),
      ])
    : ([null, null, null, 0] as const);

  // Is there a subscription that actually entitles something?
  //
  // Deliberately `subscriptionState` rather than "is there a row with a plan on
  // it". The Stripe plugin writes the row the moment CHECKOUT OPENS — status
  // "incomplete", seats already set — so a row proves an intention, not a
  // purchase. Reading it as one meant a free workspace whose owner had once
  // opened and abandoned a Forest checkout reported "5 seats" and offered
  // "Manage billing" for a subscription that had never taken a penny.
  //
  // A workspace can also be entitled by hand-assigned metadata with no Stripe
  // presence at all, and reporting seats or a renewal date for that would be a
  // lie of the same kind.
  //
  // This is the same function the entitlement path uses, so what the app is told
  // about a subscription and what its limits are computed from cannot disagree.
  const subscribed = subscriptionState(subscription).slug != null;
  const role = membership?.role;

  return {
    plan: limits.slug,
    planLabel: PLAN_LABELS[limits.slug],
    paid: isPaidPlan(limits.slug),
    status: subscribed ? (subscription?.status ?? null) : null,
    grace: limits.grace ?? "none",
    readOnly: limits.grace === "expired" || limits.grace === "awaiting_payment",
    seats: subscribed ? (subscription?.seats ?? null) : null,
    // At least one: the caller is a member, so a zero here would be a failed
    // count rather than an empty workspace, and quoting "0 members" would be
    // worse than quoting the floor a checkout would actually use.
    members: Math.max(1, memberCount),
    // Plan names carry the interval ("grove-annual"); see billing.ts.
    interval: subscribed ? (subscription?.plan?.endsWith("-annual") ? "year" : "month") : null,
    periodEnd: subscribed ? (subscription?.periodEnd?.toISOString() ?? null) : null,
    cancelAtPeriodEnd: subscribed ? (subscription?.cancelAtPeriodEnd ?? false) : false,
    // Buying and managing are owner/admin actions: using a workspace is not the
    // same as deciding what it costs. The UI hides the controls; the routes
    // enforce it independently.
    canManageBilling: role === "owner" || role === "admin",
    // The plugin records the customer on the SUBSCRIPTION row, not on the
    // organization — so checking only the org meant a customer who had just paid
    // was never offered "Manage billing". The org column is kept as a fallback
    // because the plugin's schema defines it and a future version may fill it.
    //
    // Gated on `subscribed`, so opening a checkout is not enough to earn the
    // button: Stripe has a customer record from that moment, but its portal
    // would have nothing in it to manage. Choosing a plan is the only action
    // that means anything until something has actually been bought.
    hasBillingAccount: subscribed && !!(subscription?.stripeCustomerId ?? org?.stripeCustomerId),
  };
}