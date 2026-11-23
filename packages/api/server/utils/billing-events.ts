import { usePrismaClient } from "db";
import type Stripe from "stripe";
import { useStripe } from "./billing";
import { clearPlanCache } from "./plans";

// Durability for Stripe webhooks.
//
// The plugin writes the subscription row itself. This module adds the three
// properties that make that row trustworthy:
//
//  1. Idempotency — every event is recorded once, enforced by a unique
//     constraint rather than by checking-then-writing.
//  2. Order-independence — handlers re-fetch the object from Stripe rather than
//     trusting the delivered payload, because Stripe does not guarantee order.
//  3. Reconciliation — the local table is re-derived from Stripe on a schedule,
//     so a missed webhook, a disabled endpoint, or a dashboard edit converges.

/** Prisma's unique-constraint violation — here it means "already recorded". */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Record an event, returning false when it has been seen before.
 *
 * The insert IS the claim: two concurrent deliveries of the same event race on
 * the unique index and exactly one wins, with no read-then-write window.
 */
export async function recordStripeEvent(event: Stripe.Event): Promise<boolean> {
  const db = usePrismaClient();
  try {
    await db.stripeEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        stripeCreated: new Date(event.created * 1000),
        payload: event as unknown as object,
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * A readable description of a thrown value.
 *
 * This column is the audit trail read months later when a customer's billing
 * looks wrong; `String(someObject)` would record "[object Object]" and waste
 * the one artifact that could explain what happened.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack
      ? `${error.name}: ${error.message}\n${error.stack}`
      : `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

export async function markStripeEventProcessed(eventId: string, error?: unknown): Promise<void> {
  await usePrismaClient()
    .stripeEvent.update({
      where: { stripeEventId: eventId },
      data: {
        processedAt: new Date(),
        error: error === undefined ? null : describeError(error).slice(0, 2_000),
      },
    })
    .catch((e) => console.error(`failed to mark stripe event ${eventId}:`, e));
}

/**
 * Re-read a subscription from Stripe and write it to the local row.
 *
 * Deliberately ignores whatever the webhook delivered. Stripe does not
 * guarantee delivery order, so a `customer.subscription.updated` can arrive
 * before the `checkout.session.completed` that created it; re-fetching makes
 * ordering irrelevant at the cost of one API call on a low-volume path.
 */
export async function syncSubscriptionFromStripe(stripeSubscriptionId: string): Promise<void> {
  const stripe = useStripe();
  if (!stripe) return;
  const db = usePrismaClient();

  const remote = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const item = remote.items.data[0];
  const local = await db.subscription.findFirst({
    where: { stripeSubscriptionId },
    select: { id: true },
  });
  if (!local) return; // created by the plugin; nothing of ours to reconcile yet

  await db.subscription.update({
    where: { id: local.id },
    data: {
      status: remote.status,
      seats: item?.quantity ?? null,
      cancelAtPeriodEnd: remote.cancel_at_period_end ?? false,
      cancelAt: remote.cancel_at ? new Date(remote.cancel_at * 1000) : null,
      canceledAt: remote.canceled_at ? new Date(remote.canceled_at * 1000) : null,
      endedAt: remote.ended_at ? new Date(remote.ended_at * 1000) : null,
      periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : undefined,
      periodStart: item?.current_period_start
        ? new Date(item.current_period_start * 1000)
        : undefined,
    },
  });
  clearPlanCache();
}

/** Stripe statuses in which a subscription's seat count is worth changing. */
const SEAT_SYNCABLE = new Set(["active", "trialing"]);

/**
 * Set a paid workspace's Stripe seat quantity to its real member count.
 *
 * The plugin ships this as an `organizationHooks.afterAddMember` /
 * `afterAcceptInvitation` / `afterRemoveMember` hook, and those hooks fire only
 * when membership changes go through better-auth's organization API. This repo
 * has its own invite routes, and accepting an invite writes the `member` row
 * straight through Prisma (for the use-counting and unique-violation handling
 * that route needs), so the plugin's hook never saw it.
 *
 * Removal, meanwhile, DOES go through `auth.api.removeMember`. That asymmetry
 * was the dangerous part: a workspace could invite four people and stay billed
 * for one seat, and then the moment anyone was REMOVED the plugin's hook fired
 * and set the quantity to the true count — so taking a person away quadrupled
 * the bill. Syncing on the way in makes the two directions agree.
 *
 * Best-effort by design. It is called after the membership is already committed,
 * so a Stripe outage must not fail someone's invite acceptance; the drift is
 * logged and `reconcileSubscriptions` repairs it on the next run.
 */
export async function syncSeatsForOrg(organizationId: string): Promise<void> {
  const stripe = useStripe();
  if (!stripe) return;
  const db = usePrismaClient();

  try {
    const local = await db.subscription.findFirst({
      where: { referenceId: organizationId },
      orderBy: { periodEnd: "desc" },
      select: { id: true, status: true, stripeSubscriptionId: true },
    });
    // No subscription, or one that never started: nothing is being billed, so
    // there is no quantity to correct.
    if (!local?.stripeSubscriptionId || !SEAT_SYNCABLE.has(local.status ?? "")) return;

    const members = await db.member.count({ where: { organizationId } });
    if (members < 1) return;

    const remote = await stripe.subscriptions.retrieve(local.stripeSubscriptionId);
    if (!SEAT_SYNCABLE.has(remote.status)) return;

    const item = remote.items.data[0];
    if (!item || item.quantity === members) return;

    await stripe.subscriptions.update(remote.id, {
      items: [{ id: item.id, quantity: members }],
      // Charge (or credit) the difference for the rest of the period rather than
      // waiting for the next invoice: a seat added today is used today.
      proration_behavior: "create_prorations",
    });
    await db.subscription.update({ where: { id: local.id }, data: { seats: members } });
    clearPlanCache();
  } catch (err) {
    console.error(`failed to sync seats for org ${organizationId}:`, err);
  }
}

/** The subscription id an event refers to, when it has one. */
export function subscriptionIdFromEvent(event: Stripe.Event): string | null {
  // The union across every Stripe object type is too wide to narrow usefully
  // here; this reads two well-known optional fields and checks both at runtime.
  const object = event.data.object as unknown as Record<string, unknown>;
  if (event.type.startsWith("customer.subscription.")) {
    return typeof object.id === "string" ? object.id : null;
  }
  if (event.type === "checkout.session.completed" || event.type.startsWith("invoice.")) {
    const sub = object.subscription;
    if (typeof sub === "string") return sub;
    if (sub && typeof sub === "object" && typeof (sub as { id?: unknown }).id === "string") {
      return (sub as { id: string }).id;
    }
  }
  return null;
}

/**
 * Reconcile every local subscription against Stripe.
 *
 * The safety net that makes the local table trustworthy independent of webhook
 * delivery: it catches a missed event, an endpoint Stripe disabled after three
 * days of failures, and — the common case in practice — a change someone made
 * by hand in the dashboard to comp an account.
 *
 * Pages through Stripe rather than reading one page: a customer beyond the
 * first page would otherwise never be reconciled at all.
 */
export async function reconcileSubscriptions(): Promise<{
  checked: number;
  corrected: number;
  /** Local rows whose Stripe subscription no longer exists. */
  orphaned: number;
  errors: number;
}> {
  const stripe = useStripe();
  if (!stripe) return { checked: 0, corrected: 0, orphaned: 0, errors: 0 };
  const db = usePrismaClient();

  let checked = 0;
  let corrected = 0;
  let orphaned = 0;
  let errors = 0;

  const locals = await db.subscription.findMany({
    where: { stripeSubscriptionId: { not: null } },
    select: {
      id: true,
      stripeSubscriptionId: true,
      status: true,
      seats: true,
      referenceId: true,
    },
  });

  for (const local of locals) {
    checked++;
    try {
      const remote = await stripe.subscriptions.retrieve(local.stripeSubscriptionId!);
      const item = remote.items.data[0];
      const remoteSeats = item?.quantity ?? null;
      // Seat drift is worth naming separately: it means we are billing for a
      // different number of people than the org actually has.
      const drifted = remote.status !== local.status || remoteSeats !== local.seats;
      if (drifted) {
        await syncSubscriptionFromStripe(local.stripeSubscriptionId!);
        corrected++;
        console.info(
          `reconciled subscription ${local.stripeSubscriptionId}: ` +
            `status ${local.status} -> ${remote.status}, seats ${local.seats} -> ${remoteSeats}`,
        );
      }
    } catch (err) {
      // Stripe says this subscription does not exist. Distinct from a transient
      // failure: retrying will never succeed, so it must not be logged as an
      // error on every run forever. Counted separately and reported once.
      //
      // The org is deliberately NOT downgraded. Absence of data never
      // downgrades anyone — a deleted-in-Stripe row is exactly the ambiguous
      // state the fail-open rule exists for, and a human should look at it.
      if ((err as { code?: string })?.code === "resource_missing") {
        orphaned++;
        console.warn(
          `subscription ${local.stripeSubscriptionId} (org ${local.referenceId}) no longer exists in Stripe; entitlements left unchanged`,
        );
        continue;
      }
      errors++;
      console.error(`reconcile failed for ${local.stripeSubscriptionId}:`, err);
    }
  }

  // Seat quantity should equal the org's member count. A drift here means a
  // membership change did not reach Stripe — we would be billing the wrong
  // number of seats until the next member change happened to fix it.
  //
  // This used to only warn, which meant a drift sat in the log until someone
  // read it. Since `syncSeatsForOrg` is idempotent and a no-op when the counts
  // already agree, reconciliation may as well repair what it detects.
  for (const local of locals) {
    const members = await db.member.count({ where: { organizationId: local.referenceId } });
    const fresh = await db.subscription.findUnique({
      where: { id: local.id },
      select: { seats: true },
    });
    if (fresh?.seats != null && fresh.seats !== members) {
      console.warn(
        `seat drift for org ${local.referenceId}: billed ${fresh.seats}, membership is ${members} — correcting`,
      );
      await syncSeatsForOrg(local.referenceId);
      corrected++;
    }
  }

  clearPlanCache();
  return { checked, corrected, orphaned, errors };
}