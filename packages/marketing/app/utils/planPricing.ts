import { formatMoney, type PlanPriceAmount, perMonth } from "shared";

// What the homepage pricing cards say about one plan, built from the API's
// public `/api/plans` entry for it. Pure, so the wording is tested without a
// browser; usePlanPrices does the fetching.

export interface PlanOffer {
  slug: "seedling" | "grove" | "forest";
  label: string;
  paid: boolean;
  monthly: PlanPriceAmount | null;
  annual: PlanPriceAmount | null;
  highlights: {
    filesPerWorkspace: number | null;
    storageBytesPerWorkspace: number | null;
    membersPerOrg: number | null;
    shareViewsPerMonth: number | null;
    workspacesPerUser: number | null;
  };
}

export interface PlanCardPrice {
  /** The headline: "Free", "$12", or null when no price could be read. */
  price: string | null;
  period: string;
  /** The annual alternative, as a per-month figure. */
  yearly: string | null;
}

/**
 * The price block for a card. A free tier is "Free" whatever the API says; a
 * paid tier with no readable price gets no number rather than a guessed one.
 */
export function planCardPrice(slug: string, offer: PlanOffer | undefined): PlanCardPrice {
  if (slug === "seedling") return { price: "Free", period: "", yearly: null };
  const monthly = offer?.monthly ?? null;
  const annual = offer?.annual ?? null;
  return {
    price: monthly ? formatMoney(monthly.unitAmount, monthly.currency) : null,
    period: monthly ? "per member / month" : "",
    yearly: annual
      ? `or ${formatMoney(perMonth(annual), annual.currency)} a month, billed yearly`
      : null,
  };
}

function prettyBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${Math.round(gb)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function unlimitedOr(n: number | null, label: (n: number) => string, unlimited: string): string {
  return n == null ? unlimited : label(n);
}

/**
 * The limits a tier is sold on, in the order someone runs into them. Matches
 * the app's plan picker. History retention is left out on purpose: nothing
 * enforces a difference between the tiers yet, so it is not one to sell.
 */
export function planLimitLines(offer: PlanOffer): string[] {
  const h = offer.highlights;
  const num = (n: number) => n.toLocaleString("en-US");
  return [
    unlimitedOr(
      h.workspacesPerUser,
      (n) => (n === 1 ? "One workspace" : `${num(n)} workspaces`),
      "Unlimited workspaces",
    ),
    unlimitedOr(
      h.membersPerOrg,
      (n) => (n === 1 ? "Just you" : `Up to ${num(n)} members`),
      "Unlimited members",
    ),
    unlimitedOr(
      h.storageBytesPerWorkspace,
      (n) => `${prettyBytes(n)} storage per workspace`,
      "Unlimited storage",
    ),
    unlimitedOr(h.filesPerWorkspace, (n) => `${num(n)} files per workspace`, "Unlimited files"),
    unlimitedOr(
      h.shareViewsPerMonth,
      (n) => `${num(n)} share-link views a month`,
      "Unlimited share-link views",
    ),
  ];
}