# Test evidence — billing, entitlements and usage limits

Captured 2026-08-26T12:29:39Z on branch feat/billing-limits at c5df9cf.

## Full API suite against a live server

Route-level tests (`files-routes`, `share-public-routes`, `invite-flow`, `device-flow`,
`read-state-routes`, `mcp`, `cli-sync`, `shares-routes`) self-skip unless a dev server is
reachable. They were run against a real one rather than left skipped:

```
$ PORT=3010 HOST=127.0.0.1 DEVICE_CODE_MAX=1000 DEVICE_APPROVE_MAX=1000 \
    DEVICE_POLL_INTERVAL_S=0 pnpm --filter api exec nitro dev
$ SMOKE_BASE=http://127.0.0.1:3010 vp test packages/api
```

     Test Files  23 passed (23)
          Tests  327 passed | 4 skipped (331)
       Duration  16.26s (transform 2.95s, setup 0ms, import 20.88s, tests 102.03s, environment 2ms)

## CLI ignore rules, measured on this repository

The file limit is only humane if the CLI stops trying to sync dependency trees.
Running the new pre-flight against this checkout:

```
root: <treehouse worktree>
would sync:   6,303 files
would ignore: 60,620 files
  node_modules: 60,118
  packages/api/node_modules: 126
  packages/workers/node_modules: 120
  packages/desktop/node_modules: 64
  packages/app/node_modules: 61
```

Before this change all 66,923 would have been attempted. Against a 1,000-file
Seedling workspace that is roughly 66,000 server rejections with no explanation.

Worth noting honestly: 6,303 syncable files still exceeds Seedling's 1,000. That
is correct — this is a source repository, not the documents folder Treehouse is
for — but it is why the pre-flight reports the count _before_ uploading rather
than letting the user discover it at file 1,001.

## Driven in a real browser

A demo org on the free tier (Seedling), with a proposal shared to a client.
Screenshots in this directory.

### The workspace limit reads as an offer, not a failure

`workspace-limit-upsell.png` — the free tier includes one workspace, and this org
already has it. Creating a second keeps the dialog open and explains the trade in
the user's own terms. The sidebar shows all three new usage panels at once:
_3 of 1,000 files_, _11.9 KB of 1.0 GB_, _0 of 500 share views this month_.

### View counting deduplicates real traffic

Five requests against one link:

```
client A opens it three times   -> 200 200 200
client B opens it once          -> 200
a Slack unfurl fetches it       -> 200
resulting share.viewCount       -> 2
```

Three visits by one person are one view; a second visitor is a second view; the
unfurl counts for nothing. `share-view-count.png` shows what the owner sees:
**"2 views · last opened just now"**, directly under the link.

Note: the bot filter also excludes headless Chrome, so a headless browser visit
correctly counts as zero. That is why the traffic above was generated with real
browser user-agents rather than through the automation browser.

### The paused page never blames the customer

`share-paused-client-view.png` — with the workspace over its monthly view
allowance, the client sees _"This link is temporarily unavailable. Please check
back shortly."_ No plan name, no limit, no mention of payment. The upgrade nudge
goes to the owner by email instead.

### ...and the owner keeps working throughout

`owner-unaffected-while-paused.png` — taken while that link was dark. The owner
reads the same file normally, and a write during the same window returned
`HTTP 201`. A usage ceiling pauses public serving; it never becomes a
data-access block.

## Live Stripe test-mode checkout, end to end

Against the real Treehouse Stripe account (test mode),
with `stripe listen` forwarding to the local API.

**Catalogue**, created by `packages/api/scripts/setup-stripe-catalogue.mts`:

```
treehouse_grove_monthly    12.00 usd/month  usage=licensed  tax=exclusive
treehouse_grove_annual    120.00 usd/year   usage=licensed  tax=exclusive
treehouse_forest_monthly   24.00 usd/month  usage=licensed  tax=exclusive
treehouse_forest_annual   240.00 usd/year   usage=licensed  tax=exclusive
```

A second `--apply` run reported every object as already existing and changed
nothing, which is the idempotency claim tested rather than asserted.

**Checkout.** A real session for a real org, paid with test card `4242…`. Stripe
computed VAT itself: `US$12.00 + VAT (20%) US$2.40 = US$14.40`.

**Webhooks.** Eight events delivered, every one answered `200`:

```
checkout.session.completed      customer.subscription.created
invoice.created                 invoice.finalized
invoice.paid                    invoice.payment_succeeded
payment_intent.created          payment_intent.succeeded
```

All recorded in `stripe_event` with `processedAt` set and no error.

**The subscription that resulted:**

```
plan   status  seats  stripe id  period end
grove  active  1      yes        2026-09-26
```

**Entitlements resolved from it** — the point of the whole exercise:

```
plan:             grove
grace:            none
files/workspace:  25,000
storage/ws:       50 GB
workspaces:       4
members:          unlimited
share views:      fair use
```

**Reconciliation**, run against Stripe afterwards:

```
{ checked: 4, corrected: 0, orphaned: 3, errors: 0 }
```

The three orphans are unit-test rows carrying invented subscription ids. Running
this for real is what surfaced them: they had been counted as _errors_, which
would have meant a permanent error on every hourly run. They are now a distinct
outcome, reported once, and — per the fail-open rule — the affected orgs are
**not** downgraded, because a row Stripe cannot confirm is exactly the ambiguous
state that rule exists for.

## After merging #68 (organizations collapsed into workspaces)

The billing entity did not move. An organization now _is_ a workspace, so
`entitlementsForWorkspace`, the subscription reference, `authorizeReference` and
seat sync all kept working with no change.

What changed: the workspace cap became per-user and moved into
`createWorkspaceWithOrg` (the single funnel for REST, MCP and signup — the old
better-auth org-creation hook never fires now that workspaces mint their shadow
org through Prisma). `workspacesPerOrg` and `orgsPerUser` were deleted, since
neither can bind at 1:1.

Re-verified against the live stack:

```
$ SMOKE_BASE=http://127.0.0.1:3010 vp test
  Test Files  95 passed (95)
       Tests  1195 passed | 4 skipped (1199)
```

And the reworked cap driven over HTTP:

```
signup provisioned workspace: Merge Check's Workspace
second workspace (seedling) -> 402 workspace_limit_reached
```

```
owner on grove: create "Client A" -> 200
                create "Client B" -> 200
                create "Client C" -> 200
                workspaces owned: 4
```

One note from doing this: assigning a plan takes up to the resolution cache's
30s TTL to become visible to a running API instance. That is the cache doing its
job — it is what keeps plan lookup off the write path — but it means a plan set
by script is not instantly live, and a test that assigns one _after_ a request
has already cached the old value will read stale.

## The billing UI

Driven in a browser against the live stack; screenshots in this directory.

**`plan-panel-paid.png`** — a Grove workspace now says so. Before this the same
screen read "2 of 25,000 used" and never named the plan, so a paying customer had
no way to see what they were paying for.

**`free-workspace-cap.png`** — a second free workspace is refused with
_"You've used your free workspace"_ and _"Using 1 of 1."_, alongside the sidebar's
persistent **Seedling · Upgrade**.

**`billing-grace-banner.png`** — a failed payment, explained: _"Nothing has
changed yet and your workspace is working normally."_ The plan row reads
**Payment due 6 Aug 2026**, not "Renews" — the period end on a failing
subscription is in the past, and calling that a renewal would tell the customer
their billing is fine at the exact moment it is not.

**`billing-read-only.png`** — after grace expires. The copy leads with what still
works, because someone who cannot write assumes their files are gone. Verified
against the API at the same moment:

```
GET file: HTTP 200   (reads still work)
PUT file: HTTP 402   (writes refused)
```

### Two bugs this surfaced

**Every new workspace was unlimited.** With no subscription and no assigned plan,
a freshly created workspace fell through to the `legacy` grandfathering fallback
— which exists for organizations that predate billing and cannot tell those apart
from one created a second ago. The free tier would have applied to nobody who
signed up after launch. New workspaces are now stamped with the free plan,
conditional on billing being enabled so a self-hosted deployment stays unlimited.

**One paid workspace unlocked unlimited free ones.** The cap counted _total_
workspaces and took the most generous allowance across everything owned, so a
single subscription made the allowance unlimited — and every new workspace starts
free. It now counts only free workspaces.

Confirmed over HTTP after the fix:

```
signup gives 1 workspace. Now asking for a second free one:
  HTTP 402  -> free_workspace_limit_reached
```

## A note on running the suite

The suite runs against the **shipped default: billing dormant**. That is the
posture this whole feature is built around — an existing deployment, and every
self-host, sees no behaviour change until billing is switched on.

Forcing `BILLING_ENABLED=1` on the API is a _demo_ configuration, and two
integration tests correctly fail under it:

- `invite-flow` mints an invite for a freshly created workspace. With billing on
  that workspace is Seedling — one person — so minting the invite is refused.
  That is the pricing working, not a bug.
- The same suite creates two workspaces for one user, which the free-workspace
  cap refuses unless `FREE_WORKSPACES_PER_USER` is raised.

Both are the limits doing their job. They are noted here rather than worked
around, because a test bent to pass under a non-default config would hide
exactly the behaviour it should be proving.