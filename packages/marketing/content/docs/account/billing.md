---
title: Upgrade and manage billing
navTitle: Billing
description: Move a workspace onto Grove or Forest, understand how seats are charged, and what happens if a payment fails or you cancel.
type: how-to
position: 2
updated: 2026-09-29
plans: [grove, forest]
related:
  - /docs/account/plans-and-limits
  - /docs/sharing/invite-people
---

::callout{type="note"}
Only owners and admins of a workspace can upgrade it or manage its billing. Members see who to ask instead.
::

Each workspace is billed on its own. Upgrading one doesn't change any of your other workspaces.

## Upgrade a workspace

1. Open the workspace and go to its front page. The right-hand panel shows the workspace's usage and, under **Plan**, its current plan.
2. Select **Upgrade**.
3. In **Choose a plan**, pick **Monthly** or **Yearly**. With **Yearly**, each plan shows how much you save.
4. Select **Upgrade to Grove** or **Upgrade to Forest**.
5. Complete the payment on the secure Stripe checkout page. You're brought back to Treehouse afterwards.

The new limits apply as soon as the payment goes through. The **Plan** section then shows the plan, how many seats you're paying for, and when it renews.

You can also choose a plan when you first sign up (**Choose Grove** or **Choose Forest** instead of **Start on Seedling**), or when you create a new workspace after using your free one.

## Seats

Paid plans are priced per member, per month. Every member of the workspace is a seat, including [Viewers](/docs/sharing/invite-people#roles), and the checkout starts with a seat for each person already in it.

- When someone [accepts an invite](/docs/sharing/invite-people), a seat is added to the bill straight away, charged pro rata for the rest of the billing period.
- When someone is removed, the seat comes off the same way.
- Agents, API keys and visitors on share links are never seats.

The price of a seat is shown on the invite card and in the members panel, so you always know what adding someone costs.

## Update your card or cancel

1. On the workspace's front page, under **Plan**, select **Manage billing**.
2. The Stripe billing portal opens. From there you can update your payment details, see your invoices and cancel.

If you cancel, the workspace keeps its plan until the end of the period you've paid for. The **Plan** section shows **Ends** with the date.

## If a payment fails or a subscription ends

Treehouse never deletes your files because of billing. When a payment fails or a subscription ends, it works like this:

1. **Grace period.** The workspace keeps working normally, with its paid limits, for 14 days after the end of the last paid period. Owners and admins see **There's a problem with your subscription** with a **Fix payment** button. Members see "Ask an owner to update billing."
2. **Read-only.** If it isn't sorted out by then, the workspace becomes read-only. The banner says **This workspace is read-only**. Nobody can add or edit files or comments, but everyone can still read, download, move and delete. Nothing has been removed.
3. **Renewing** with **Fix payment** restores writing immediately.

Agents see the same thing: a write to a read-only workspace is refused with a message explaining that the subscription lapsed.

## A workspace waiting for checkout

If you create a workspace on a paid plan and don't finish paying, it's kept read-only until you do, and shows **Finish setting up this workspace**. Select **Finish checkout** to complete it. You can only have one workspace waiting for payment at a time.

## Troubleshooting

### I can't see Upgrade or Manage billing

You're a member rather than an owner or admin. Ask an owner or admin of the workspace to do it. **Manage billing** also only appears once the workspace has been through checkout at least once.