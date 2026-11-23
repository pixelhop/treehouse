---
title: Upgrade quoted a one-person price to a five-person workspace — the checkout seat quantity defaults to 1
module: packages/api/server/routes/api/workspaces/[workspaceId]/billing/checkout.post.ts
date: 2026-08-28
problem_type: bug
component: billing
severity: high
applies_when:
  - "calling auth.api.upgradeSubscription, or changing what the checkout route sends"
  - "reasoning about how the Stripe quantity relates to org membership"
  - 'considering passing customerType: "organization" to the Stripe plugin'
  - "investigating a prorated charge a customer says they were never shown"
related_components:
  - billing_reconcile
  - plan_picker
tags:
  - billing
  - stripe
  - better-auth
  - seats
  - checkout
---

# Upgrade quoted a one-person price to a five-person workspace

## Context

Treehouse sells Grove and Forest per member, with no base fee: the whole
subscription is one per-seat line, so the Stripe quantity IS the member count.
`syncSeatsForOrg` keeps that quantity level with the member list afterwards, and
the hourly reconcile repairs any drift.

Clicking **Upgrade** on an existing five-person workspace still opened a Stripe
page priced for one person.

## What was actually happening

`@better-auth/stripe` resolves the customer type from the request body:

```ts
const customerType = ctx.body.customerType || "user";
const isAutoManagedSeats = !!(plan.seatPriceId && customerType === "organization");
// ...
quantity: isAutoManagedSeats ? memberCount : ctx.body.seats || 1;
```

The checkout route passed `referenceId` (the org id) but no `customerType`, so
the plugin treated it as a user-type checkout: seat auto-management never
engaged, `seats` was unset, and the quantity fell through to **1**.

Setting `seatPriceId === priceId` in the plugin config does not change this. It
marks the plan as seat-only; it does not, on its own, make the quantity follow
membership.

The failure was quiet rather than loud, which is what made it expensive: the
customer was charged for one seat, and then the hourly reconcile noticed the
drift and corrected the quantity to five — arriving as a prorated charge nobody
had been shown a price for.

## The fix

Count the org's members in the checkout route and pass `seats`. No floor beyond
one: the paid tiers are a capacity upgrade as much as a team one.

The member count is also reported to the app as `WorkspaceBilling.members`
(distinct from `seats`, which is what Stripe bills for _today_ and is null until
something has been bought), so the plan picker can quote the workspace's real
total rather than a per-member figure it will never be charged.

## Why not `customerType: "organization"`

It would make the plugin derive seats itself, and it is the conceptually right
description of who the customer is — but it also changes which Stripe customer
the checkout resolves. Existing subscriptions live on a _user_-scoped customer;
with `customerType: "organization"` the plugin looks for the org's customer
instead, finds no active subscription under it, and opens a fresh checkout —
selling a second subscription to someone who already pays. Moving to it needs a
backfill of `organization.stripeCustomerId` first, not a one-line change.

## Verifying it

There is no way to check this from a unit test: what matters is the quantity on
a real checkout session. Locally, with no Stripe keys, the route can be driven
and the computed seat count logged; in an environment with test-mode keys, the
plugin writes the local `subscription` row when checkout OPENS with the seats it
asked Stripe for, which is what
`packages/api/test/billing-checkout.test.ts` asserts.