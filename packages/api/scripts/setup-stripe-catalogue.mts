#!/usr/bin/env node
/**
 * Create (or verify) Treehouse's Stripe product catalogue.
 *
 * IDEMPOTENT. Every price is addressed by a stable `lookup_key`, so a second run
 * finds what the first created and changes nothing. Stripe prices are immutable
 * — if an amount here no longer matches the live price, the script REPORTS the
 * drift and refuses rather than silently creating a duplicate at the new figure.
 * Changing a price is a deliberate act: archive the old one and add a new
 * lookup_key.
 *
 * Writes to Stripe. Nothing else.
 *
 * Usage:
 *   cd packages/api
 *   STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/setup-stripe-catalogue.mts
 *
 * Add `--apply` to actually create. Without it the script only reports what it
 * would do, which is the safer default when several Stripe accounts are
 * configured on one machine.
 *
 * The script prints the resulting price ids in .env form at the end, ready to
 * paste into packages/api/.env.
 */

import Stripe from "stripe";

const APPLY = process.argv.includes("--apply");
const key = process.env.STRIPE_SECRET_KEY;

if (!key) {
  console.error("STRIPE_SECRET_KEY is required.");
  process.exit(1);
}
if (key.startsWith("sk_live_") && !process.argv.includes("--i-mean-live")) {
  // A live key on a catalogue script is almost always a mistake — the same
  // command that seeds test data would create real, purchasable prices.
  console.error(
    "Refusing to run against a LIVE key without --i-mean-live.\n" +
      "Set a test key (sk_test_...) or pass the flag deliberately.",
  );
  process.exit(1);
}

const stripe = new Stripe(key);

// ---------------------------------------------------------------------------
// The catalogue.
//
// Per-seat, billed to the organization. Seedling is free and has no Stripe
// presence at all — a free plan needs no price, and creating a £0 one would
// invite a checkout that bills nothing.
//
// Annual is expressed as the full yearly amount per seat (12 × the headline
// monthly rate), which is how "$10/member/month, billed annually" is actually
// charged. Amounts are in minor units.
// ---------------------------------------------------------------------------

interface PriceSpec {
  lookupKey: string;
  nickname: string;
  interval: "month" | "year";
  unitAmount: number;
}

interface ProductSpec {
  /** Stable id we set ourselves, so re-runs find the same product. */
  id: string;
  name: string;
  description: string;
  /** Matches the plan slug in server/utils/plans.ts. */
  planSlug: string;
  prices: PriceSpec[];
}

const CURRENCY = "usd";

/**
 * Stripe tax code: SaaS, business use.
 *
 * Required rather than optional. Managed Payments (on by default for new
 * accounts) refuses a checkout line item whose product has no tax code, and
 * Stripe Tax needs it to pick a VAT rate — so a product without one cannot be
 * sold at all.
 */
const TAX_CODE = "txcd_10103001";

const CATALOGUE: ProductSpec[] = [
  {
    id: "treehouse_grove",
    name: "Treehouse Grove",
    description:
      "For teams whose agents have started pulling their weight. Unlimited agents and viewers, per member.",
    planSlug: "grove",
    prices: [
      {
        lookupKey: "treehouse_grove_monthly",
        nickname: "Grove — monthly",
        interval: "month",
        unitAmount: 1_200, // $12 per member per month
      },
      {
        lookupKey: "treehouse_grove_annual",
        nickname: "Grove — annual",
        interval: "year",
        unitAmount: 12_000, // $10 per member per month, billed yearly
      },
    ],
  },
  {
    id: "treehouse_forest",
    name: "Treehouse Forest",
    description:
      "For organizations growing a whole canopy of teams. Adds SSO, audit export and bring-your-own-bucket.",
    planSlug: "forest",
    prices: [
      {
        lookupKey: "treehouse_forest_monthly",
        nickname: "Forest — monthly",
        interval: "month",
        unitAmount: 2_400, // $24 per member per month
      },
      {
        lookupKey: "treehouse_forest_annual",
        nickname: "Forest — annual",
        interval: "year",
        unitAmount: 24_000, // $20 per member per month, billed yearly
      },
    ],
  },
];

async function ensureProduct(spec: ProductSpec): Promise<Stripe.Product> {
  try {
    const existing = await stripe.products.retrieve(spec.id);
    const taxCode =
      typeof existing.tax_code === "string" ? existing.tax_code : existing.tax_code?.id;
    if (taxCode !== TAX_CODE) {
      // Unlike prices, products are mutable — so a missing tax code is a
      // repairable state rather than drift that needs a human.
      if (APPLY) {
        await stripe.products.update(spec.id, { tax_code: TAX_CODE });
        console.log(`  product ${spec.id} — tax code set to ${TAX_CODE}`);
      } else {
        console.log(
          `  product ${spec.id} — WOULD SET tax code ${TAX_CODE} (currently ${taxCode ?? "unset"})`,
        );
      }
    } else {
      console.log(`  product ${spec.id} — already exists (${existing.name})`);
    }
    return existing;
  } catch (err) {
    if ((err as Stripe.errors.StripeError).code !== "resource_missing") throw err;
  }
  if (!APPLY) {
    console.log(`  product ${spec.id} — WOULD CREATE "${spec.name}"`);
    return { id: spec.id } as Stripe.Product;
  }
  const created = await stripe.products.create({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    tax_code: TAX_CODE,
    // The slug the app resolves entitlements from. Kept on the product so a
    // webhook can map a Stripe object back to a plan without a lookup table.
    metadata: { plan_slug: spec.planSlug },
  });
  console.log(`  product ${spec.id} — created`);
  return created;
}

async function ensurePrice(product: string, spec: PriceSpec, planSlug: string) {
  const found = await stripe.prices.list({ lookup_keys: [spec.lookupKey], limit: 1 });
  const existing = found.data[0];

  if (existing) {
    const drifted =
      existing.unit_amount !== spec.unitAmount ||
      existing.recurring?.interval !== spec.interval ||
      existing.currency !== CURRENCY;
    if (drifted) {
      // Prices are immutable in Stripe. Creating another at the new amount
      // would leave two live prices under one lookup key's intent and silently
      // change what new customers pay, so this stops instead.
      console.error(
        `  price ${spec.lookupKey} — DRIFT: live is ` +
          `${existing.unit_amount} ${existing.currency}/${existing.recurring?.interval}, ` +
          `catalogue says ${spec.unitAmount} ${CURRENCY}/${spec.interval}.\n` +
          `    Archive the old price and give the new one a fresh lookup_key.`,
      );
      process.exitCode = 1;
      return existing;
    }
    console.log(`  price ${spec.lookupKey} — already exists (${existing.id})`);
    return existing;
  }

  if (!APPLY) {
    console.log(
      `  price ${spec.lookupKey} — WOULD CREATE ${spec.unitAmount} ${CURRENCY}/${spec.interval} per seat`,
    );
    return null;
  }

  const created = await stripe.prices.create({
    product,
    lookup_key: spec.lookupKey,
    nickname: spec.nickname,
    currency: CURRENCY,
    unit_amount: spec.unitAmount,
    // Per-seat: quantity is the org's member count, synced from membership.
    recurring: { interval: spec.interval, usage_type: "licensed" },
    billing_scheme: "per_unit",
    // Stripe Tax decides the rate at checkout; the listed figure is pre-tax.
    tax_behavior: "exclusive",
    metadata: { plan_slug: planSlug },
  });
  console.log(`  price ${spec.lookupKey} — created (${created.id})`);
  return created;
}

async function main() {
  // No id: retrieves the account the key belongs to. Printed first so a run
  // against the wrong Stripe account is obvious before anything is created.
  const account = (await stripe.accounts.retrieve(undefined as never)) as Stripe.Account;
  const mode = key!.startsWith("sk_live_") ? "LIVE" : "test";
  console.log(
    `Stripe account: ${account.id}` +
      `${account.settings?.dashboard?.display_name ? ` (${account.settings.dashboard.display_name})` : ""}` +
      ` — ${mode} mode`,
  );
  console.log(APPLY ? "Applying changes.\n" : "Dry run — pass --apply to create.\n");

  const env: string[] = [];
  for (const spec of CATALOGUE) {
    console.log(spec.name);
    const product = await ensureProduct(spec);
    for (const price of spec.prices) {
      const created = await ensurePrice(product.id, price, spec.planSlug);
      if (created) {
        env.push(
          `STRIPE_PRICE_${price.lookupKey.replace("treehouse_", "").toUpperCase()}=${created.id}`,
        );
      }
    }
    console.log("");
  }

  if (env.length) {
    console.log("Paste into packages/api/.env:\n");
    console.log(env.join("\n"));
  }
  console.log(
    "\nSeedling is free and intentionally has no Stripe product — a free plan needs no price.",
  );
  console.log(
    "Forest's 5-seat minimum is enforced by the app at checkout, not by the price itself.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});