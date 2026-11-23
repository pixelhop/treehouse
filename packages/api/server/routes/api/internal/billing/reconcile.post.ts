import { defineEventHandler } from "h3";
import { reconcileSubscriptions } from "../../../../utils/billing-events";
import { requireInternalJobSecret } from "../../../../utils/internal-job";

// Service-to-service: the BullMQ worker calls this on a schedule.
//
// Reconciliation needs the Stripe client, which lives in this package — and
// `packages/workers` deliberately depends only on `db`. Rather than reaching
// across that boundary, the worker asks the API to do it. Both run on Railway,
// so this never leaves the private network.
//
// Guarded by the internal job secret rather than a session: there is no user
// here (see requireInternalJobSecret).
export default defineEventHandler(async (event) => {
  requireInternalJobSecret(event);
  return await reconcileSubscriptions();
});