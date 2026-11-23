// How a plan price is written down. The app's plan picker and the marketing
// homepage both quote the prices `GET /api/plans` reads from Stripe; formatting
// them in one place is what keeps "$12" on the homepage from becoming "$12.00"
// in the app, or an annual price quoted per year in one and per month in the
// other.

/** One per-seat price as the API returns it. Amounts are in minor units. */
export interface PlanPriceAmount {
  interval: "month" | "year";
  unitAmount: number;
  currency: string;
}

/**
 * Format a per-seat price.
 *
 * Amounts arrive in minor units. Dividing by 100 is right for every currency
 * this sells in (USD today); a zero-decimal currency like JPY would need the
 * exponent from Stripe rather than this assumption.
 */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    // "$12", not the "US$12" a British locale writes, which wraps a tier card.
    // Every price is in one currency, so there is nothing to disambiguate.
    currencyDisplay: "narrowSymbol",
    // Whole prices read as prices; $12 beats $12.00 in a tier card.
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

/**
 * What an annual price works out at per month.
 *
 * Annual is quoted per-month-equivalent because that is the only way to compare
 * it to the monthly price honestly — "$120/year" next to "$12/month" makes the
 * cheaper option look like the expensive one.
 */
export function perMonth(price: PlanPriceAmount): number {
  return price.interval === "year" ? Math.round(price.unitAmount / 12) : price.unitAmount;
}