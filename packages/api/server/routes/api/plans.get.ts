import { defineEventHandler } from "h3";
import { planOffers, pricingAvailable } from "../../utils/plan-pricing";

// The plans a user can choose between, with live prices from Stripe.
//
// Deliberately unauthenticated: this is public pricing. Requiring a session
// would mean the marketing site could not read the same numbers the app shows,
// which is precisely how a pricing page ends up disagreeing with checkout.
//
// `available: false` is the self-host answer — no Stripe, no billing flag,
// nothing to sell — and the app renders no picker at all rather than an empty
// one.
export default defineEventHandler(async () => {
  if (!pricingAvailable()) return { available: false, plans: [] };
  return { available: true, plans: await planOffers() };
});