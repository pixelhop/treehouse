/**
 * Verification that a workspace's Stripe seat quantity follows its member list.
 *
 * This cannot be a unit test: the behaviour that matters is a real
 * `subscriptions.update` against Stripe, and stubbing that would only prove the
 * stub works. So it runs against a live TEST-MODE subscription, adds a member
 * exactly the way the invite-accept route does (straight through Prisma, which
 * is what bypassed better-auth's own seat hook), and reads the quantity back.
 *
 * It leaves nothing behind: the test member is removed and the quantity synced
 * back to where it started.
 *
 * Usage, from the repo root, with the api package's .env loaded:
 *   cd packages/api && BILLING_ENABLED=1 npx vite-node ../../scripts/verify-seat-billing.mts
 */
import { usePrismaClient } from "../packages/db/index.ts";

const db = usePrismaClient();
const { syncSeatsForOrg } = await import("../packages/api/server/utils/billing-events.ts");
const { useStripe } = await import("../packages/api/server/utils/billing.ts");

const stripe = useStripe();
if (!stripe) {
  console.log("No STRIPE_SECRET_KEY — nothing to verify.");
  process.exit(0);
}

const sub = await db.subscription.findFirst({
  // Only a real Stripe id: the test suite seeds synthetic ones.
  where: { status: "active", stripeSubscriptionId: { startsWith: "sub_1" } },
  orderBy: { periodStart: "desc" },
});
if (!sub?.referenceId) {
  console.log("No active test-mode subscription to verify against.");
  process.exit(0);
}
const orgId = sub.referenceId;

const before = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
const membersBefore = await db.member.count({ where: { organizationId: orgId } });
console.log(
  `BEFORE  stripe qty=${before.items.data[0]?.quantity}  members=${membersBefore}  local seats=${sub.seats}`,
);

const stamp = Date.now();
const user = await db.user.create({
  data: {
    id: `usr_seat_${stamp}`,
    name: "Seat Check",
    email: `seat${stamp}@example.test`,
    emailVerified: true,
  },
});
await db.member.create({
  data: { id: `mem_seat_${stamp}`, organizationId: orgId, userId: user.id, role: "member" },
});
const membersAfter = await db.member.count({ where: { organizationId: orgId } });
console.log(`ADDED   members=${membersAfter}`);

await syncSeatsForOrg(orgId);
const after = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
const local = await db.subscription.findUnique({ where: { id: sub.id }, select: { seats: true } });
console.log(`AFTER   stripe qty=${after.items.data[0]?.quantity}  local seats=${local?.seats}`);
console.log(
  after.items.data[0]?.quantity === membersAfter
    ? "PASS: Stripe follows membership"
    : "FAIL: Stripe did not follow membership",
);

await syncSeatsForOrg(orgId);
const again = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
console.log(`RESYNC  stripe qty=${again.items.data[0]?.quantity} (unchanged = idempotent)`);

await db.member.deleteMany({ where: { userId: user.id } });
await db.user.delete({ where: { id: user.id } });
await syncSeatsForOrg(orgId);
const restored = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!);
console.log(`CLEANUP stripe qty=${restored.items.data[0]?.quantity} (back to ${membersBefore})`);