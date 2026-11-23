import { usePrismaClient } from "db";

// ---------------------------------------------------------------------------
// Plan catalog and entitlement resolution. This is the single place that
// answers "what limits apply to this organization?" — every limit in the
// product derives from a plan tier here, and nothing else hard-codes a number.
//
// Two invariants govern this module:
//
//  1. Resolution reads Postgres only. Never Stripe, never a cache server. A
//     file write must not be able to block on a payment provider, so the
//     billing state we consult is the local `subscription` row and nothing
//     else.
//  2. It fails OPEN. An unknown slug, a missing row, or a query error resolves
//     to unlimited — never to the free tier. A spurious downgrade would apply a
//     1,000-file cap to a workspace holding 20,000 files and lock a paying team
//     out of their own client work, which is exactly the harm the never-lose-
//     data promise exists to prevent.
// ---------------------------------------------------------------------------

/**
 * `FileNode.size` is a Postgres Int, so no single file can exceed this many
 * bytes regardless of what a plan says. Catalog values above it are clamped
 * rather than honoured — the same treatment `maxFileBytes()` in files.ts gives
 * an out-of-range `MAX_FILE_BYTES` override. Raising the paid tiers past ~2 GB
 * needs `FileNode.size` widened to BigInt first.
 */
export const FILE_SIZE_CEILING = 2_147_483_647;

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export type PlanSlug = "seedling" | "grove" | "forest" | "legacy" | "unlimited";

/** What each tier is called to a user. The UI must not invent these. */
export const PLAN_LABELS: Record<PlanSlug, string> = {
  seedling: "Seedling",
  grove: "Grove",
  forest: "Forest",
  // Grandfathered and self-hosted deployments. Both read as "no limits" rather
  // than exposing an internal slug to someone who never chose it.
  legacy: "Unlimited",
  unlimited: "Unlimited",
};

/** Whether a tier is one someone pays for. */
export function isPaidPlan(slug: PlanSlug): boolean {
  return slug === "grove" || slug === "forest";
}

interface PlanCatalogEntry {
  slug: PlanSlug;
  /** Marketed tier a user can be on deliberately; false for legacy/unlimited. */
  purchasable: boolean;
  storageBytesPerWorkspace: number | null;
  filesPerWorkspace: number | null;
  maxFileBytes: number | null;
  /** Workspaces one user may OWN on this plan. */
  workspacesPerUser: number | null;
  membersPerOrg: number | null;
  shareViewsPerMonth: number | null;
  shareBytesPerMonth: number | null;
  shareBytesPerDay: number | null;
  historyDays: number | null;
}

/**
 * The resolved limits for one organization, with seat-scaled allowances already
 * reduced to numbers. `null` means unlimited on every field.
 */
/**
 * Where an org sits on the downgrade ladder.
 *
 *  - `none`     — paying, or never was.
 *  - `grace`    — an explicit cancel/unpaid/deleted signal arrived. PAID limits
 *                 still apply; the app warns.
 *  - `expired`  — the window closed. Limits have dropped, and a workspace over
 *                 its new ones is READ-ONLY rather than losing anything.
 *  - `awaiting_payment`
 *               — created past the free allowance on the promise of a
 *                 subscription that never arrived. Read-only until it is paid
 *                 for; this is what stops an abandoned checkout from minting a
 *                 free workspace.
 */
export type GraceState = "none" | "grace" | "expired" | "awaiting_payment";

export interface PlanLimits {
  slug: PlanSlug;
  /** Present on resolved limits; absent on the pure catalogue lookup. */
  grace?: GraceState;
  storageBytesPerWorkspace: number | null;
  filesPerWorkspace: number | null;
  maxFileBytes: number | null;
  workspacesPerUser: number | null;
  membersPerOrg: number | null;
  shareViewsPerMonth: number | null;
  shareBytesPerMonth: number | null;
  shareBytesPerDay: number | null;
  /**
   * Days of change history a tier keeps.
   *
   * NOT ENFORCED, and not advertised because of it. Nothing prunes change
   * events, so every workspace — free included — keeps its full history. The
   * field is the seam a future retention job would read; until that job exists,
   * quoting these numbers to a customer would be selling a difference between
   * the tiers that does not exist.
   */
  historyDays: number | null;
}

const UNLIMITED_ENTRY: PlanCatalogEntry = {
  slug: "unlimited",
  purchasable: false,
  storageBytesPerWorkspace: null,
  filesPerWorkspace: null,
  maxFileBytes: null,
  workspacesPerUser: null,
  membersPerOrg: null,
  shareViewsPerMonth: null,
  shareBytesPerMonth: null,
  shareBytesPerDay: null,
  historyDays: null,
};

export const PLAN_CATALOG: Readonly<Record<PlanSlug, PlanCatalogEntry>> = Object.freeze({
  seedling: {
    slug: "seedling",
    purchasable: true,
    storageBytesPerWorkspace: 1 * GB,
    filesPerWorkspace: 1_000,
    maxFileBytes: 25 * MB,
    workspacesPerUser: 1,
    membersPerOrg: 1,
    shareViewsPerMonth: 500,
    shareBytesPerMonth: 10 * GB,
    shareBytesPerDay: 1 * GB,
    historyDays: 7,
  },
  grove: {
    slug: "grove",
    purchasable: true,
    storageBytesPerWorkspace: 50 * GB,
    filesPerWorkspace: 25_000,
    maxFileBytes: FILE_SIZE_CEILING,
    workspacesPerUser: null,
    membersPerOrg: null,
    // Paid tiers get fair use, not an automatic cutoff: a paying customer whose
    // client portal goes dark costs far more than the bandwidth. Monitoring
    // thresholds live outside the enforcement path.
    shareViewsPerMonth: null,
    shareBytesPerMonth: null,
    shareBytesPerDay: null,
    historyDays: 365,
  },
  forest: {
    slug: "forest",
    purchasable: true,
    storageBytesPerWorkspace: 250 * GB,
    filesPerWorkspace: 100_000,
    maxFileBytes: FILE_SIZE_CEILING,
    workspacesPerUser: null,
    membersPerOrg: null,
    shareViewsPerMonth: null,
    shareBytesPerMonth: null,
    shareBytesPerDay: null,
    historyDays: null,
  },
  // Organizations that predate billing. Unlimited, and never sold — it exists so
  // enabling billing cannot retroactively cap an existing customer.
  legacy: { ...UNLIMITED_ENTRY, slug: "legacy" },
  // Self-hosted deployments, and any deployment with billing switched off.
  unlimited: UNLIMITED_ENTRY,
});

export const UNLIMITED_LIMITS: PlanLimits = Object.freeze({
  slug: "unlimited",
  grace: "none" as GraceState,
  storageBytesPerWorkspace: null,
  filesPerWorkspace: null,
  maxFileBytes: null,
  workspacesPerUser: null,
  membersPerOrg: null,
  shareViewsPerMonth: null,
  shareBytesPerMonth: null,
  shareBytesPerDay: null,
  historyDays: null,
});

function isPlanSlug(value: unknown): value is PlanSlug {
  return typeof value === "string" && value in PLAN_CATALOG;
}

/**
 * Resolve a catalog entry to concrete numbers for an org with `memberCount`
 * members. Unknown slugs resolve to unlimited (fail open, never to seedling).
 */
export function limitsForPlan(slug: string, _memberCount = 1): PlanLimits {
  const entry = isPlanSlug(slug) ? PLAN_CATALOG[slug] : UNLIMITED_ENTRY;
  return {
    slug: entry.slug,
    storageBytesPerWorkspace: entry.storageBytesPerWorkspace,
    filesPerWorkspace: entry.filesPerWorkspace,
    maxFileBytes:
      entry.maxFileBytes == null ? null : Math.min(entry.maxFileBytes, FILE_SIZE_CEILING),
    workspacesPerUser: entry.workspacesPerUser,
    membersPerOrg: entry.membersPerOrg,
    shareViewsPerMonth: entry.shareViewsPerMonth,
    shareBytesPerMonth: entry.shareBytesPerMonth,
    shareBytesPerDay: entry.shareBytesPerDay,
    historyDays: entry.historyDays,
  };
}

/**
 * Whether this deployment enforces plan limits at all.
 *
 * Limits are dormant until billing is deliberately switched on, so an existing
 * deployment (and every self-host) sees no behaviour change from this code
 * landing. `BILLING_ENABLED=1` turns enforcement on; `DEFAULT_PLAN_SLUG` forces
 * every org onto one tier, which is how limits are exercised locally and in
 * tests without a Stripe account.
 */
export function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "1" || process.env.DEFAULT_PLAN_SLUG != null;
}

/**
 * Assign a plan to an organization by hand, without Stripe.
 *
 * Merges into the existing metadata rather than replacing it, so this never
 * clobbers whatever else is kept there.
 *
 * Takes effect on THIS process immediately and on any other API instance within
 * the resolution cache's TTL (30s). That delay is deliberate — the cache is what
 * keeps plan lookup off the write path — but it means a plan assigned by a
 * script is not instantly visible to a running server.
 */
export async function assignPlan(orgId: string, slug: PlanSlug): Promise<void> {
  const db = usePrismaClient();
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { metadata: true },
  });
  let existing: Record<string, unknown> = {};
  try {
    if (org?.metadata) existing = JSON.parse(org.metadata) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  await db.organization.update({
    where: { id: orgId },
    data: { metadata: JSON.stringify({ ...existing, plan: slug }) },
  });
  clearPlanCache();
}

/** The tier an org falls back to when it has no subscription row. */
function fallbackSlug(): PlanSlug {
  const forced = process.env.DEFAULT_PLAN_SLUG;
  if (isPlanSlug(forced)) return forced;
  // Billing on but no row: an org that predates billing. Grandfathered, not
  // downgraded — see the fail-open invariant at the top of this file.
  return "legacy";
}

// --- resolution cache ------------------------------------------------------
// `write()` calls into this inline on every write, so an uncached resolution
// would add a query per write to the hottest path in the product. Held in
// process memory rather than a cache server, matching the existing convention
// in device.ts; the API runs single-instance today, and a stale entry only
// delays a limit change by the TTL.

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  limits: PlanLimits;
  expiresAt: number;
}

const orgCache = new Map<string, CacheEntry>();
const workspaceOrgCache = new Map<string, { orgId: string; expiresAt: number }>();

/** Drop cached entitlements. Called after a plan change, and by tests. */
export function clearPlanCache(): void {
  orgCache.clear();
  workspaceOrgCache.clear();
}

/**
 * A plan assigned directly to an organization, read from better-auth's
 * `organization.metadata` JSON as `{ "plan": "grove" }`.
 *
 * This is how a plan is set without Stripe — which the rollout depends on
 * (limits ship dormant and are switched on per-org), and what lets an operator
 * comp an account or move one customer onto a tier by hand. A live subscription
 * outranks it.
 */
/**
 * Whether this org was created past the free allowance on the promise of a
 * subscription, and has not paid yet.
 */
export function awaitingPaymentFromMetadata(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    return (JSON.parse(metadata) as { awaitingPayment?: unknown }).awaitingPayment === true;
  } catch {
    return false;
  }
}

function planFromMetadata(metadata: string | null): PlanSlug | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { plan?: unknown };
    return isPlanSlug(parsed.plan) ? parsed.plan : null;
  } catch {
    // Metadata is caller-controlled and may be anything; a malformed blob must
    // not throw into the write path.
    return null;
  }
}

/**
 * Days a cancelled or unpaid subscription keeps its paid limits.
 *
 * The product is a file workspace whose core promise is never losing data. A
 * failed card must not translate, that afternoon, into a team locked out of
 * their own client work — so the limits hold while the customer sorts it out.
 */
const GRACE_DAYS = 14;

/** Statuses that entitle the plan outright. */
const ENTITLING = new Set(["active", "trialing"]);
/** Statuses that start the grace window rather than ending entitlement. */
const FAILING = new Set(["past_due", "unpaid", "canceled"]);
/**
 * Statuses meaning the first payment never landed, so nothing was ever bought.
 *
 * The Stripe plugin writes a subscription row when CHECKOUT IS CREATED, before
 * the customer has typed a card number — `status: "incomplete"`, no period end.
 * That row used to fall through to "a status we have not taught this code about,
 * so keep entitling the plan", which meant opening checkout and closing the tab
 * granted the paid tier, permanently: with no period end there was never even a
 * grace window to expire.
 *
 * This does not weaken the fail-open rule. `incomplete` is the state BEFORE a
 * first successful payment and Stripe never returns a subscription to it
 * afterwards, so treating it as "not bought" cannot downgrade anyone who has
 * paid. Everything unrecognised still entitles.
 */
const NEVER_PAID = new Set(["incomplete", "incomplete_expired"]);

interface SubscriptionRow {
  plan: string | null;
  status: string | null;
  cancelAtPeriodEnd?: boolean | null;
  periodEnd?: Date | null;
}

/**
 * Resolve a subscription row to an entitled tier plus its grace state.
 *
 * The direction of failure is the whole point: absence of data NEVER downgrades
 * anyone. Only an explicit, confirmed failing status starts the clock, and even
 * then the paid tier holds for GRACE_DAYS.
 */
export function subscriptionState(sub: SubscriptionRow | null): {
  slug: PlanSlug | null;
  grace: GraceState;
} {
  if (!sub || !sub.plan) return { slug: null, grace: "none" };

  // Plan names carry the billing interval ("grove-annual"); the interval is a
  // billing detail, not an entitlement one.
  const base = sub.plan.replace(/-annual$/, "");
  const slug = isPlanSlug(base) ? base : null;
  if (!slug) return { slug: null, grace: "none" };

  const status = sub.status ?? "";
  if (ENTITLING.has(status)) return { slug, grace: "none" };
  // Never paid for: resolve as though there were no subscription at all, so the
  // org falls back to its assigned plan (the free tier) rather than being handed
  // the tier it opened a checkout for.
  if (NEVER_PAID.has(status)) return { slug: null, grace: "none" };
  if (!FAILING.has(status)) {
    // An unknown status is not evidence of anything. Keep entitling the plan —
    // a Stripe status we have not taught this code about must not cost a
    // customer their limits.
    return { slug, grace: "none" };
  }

  const since = sub.periodEnd ?? null;
  if (!since) return { slug, grace: "grace" };
  const elapsedDays = (Date.now() - since.getTime()) / 86_400_000;
  return elapsedDays <= GRACE_DAYS ? { slug, grace: "grace" } : { slug, grace: "expired" };
}

/** Cheap check for a hand-assigned plan, cached alongside the limits. */
async function hasAssignedPlan(orgId: string): Promise<boolean> {
  try {
    const org = await usePrismaClient().organization.findUnique({
      where: { id: orgId },
      select: { metadata: true },
    });
    return planFromMetadata(org?.metadata ?? null) != null;
  } catch {
    return false;
  }
}

async function loadLimitsForOrg(orgId: string): Promise<PlanLimits> {
  const db = usePrismaClient();
  // `subscription` arrives with the Stripe plugin. Until then there is no
  // subscription state to read, and the org's own metadata is the assignment
  // mechanism — the seam stays in place without pretending the table exists.
  const [memberCount, org, subscription] = await Promise.all([
    db.member.count({ where: { organizationId: orgId } }),
    db.organization.findUnique({ where: { id: orgId }, select: { metadata: true } }),
    db.subscription.findFirst({
      where: { referenceId: orgId },
      orderBy: { periodEnd: "desc" },
      select: { plan: true, status: true, cancelAtPeriodEnd: true, periodEnd: true },
    }),
  ]);

  const state = subscriptionState(subscription);

  // Precedence: an entitling subscription, then a hand-assigned plan, then the
  // deployment fallback (which grandfathers pre-billing orgs onto legacy).
  const slug = state.slug ?? planFromMetadata(org?.metadata ?? null) ?? fallbackSlug();

  // Created past the free allowance on the promise of payment, and no
  // subscription ever arrived. Held read-only rather than refused outright: the
  // workspace and its files stay readable and exportable, it simply cannot be
  // used as a free workspace the user was not entitled to.
  //
  // Keyed on `state.slug == null`, so this only ever describes a workspace that
  // NEVER had a subscription. Someone who bought and later cancelled has a
  // subscription row, so they land on the ordinary grace ladder instead — being
  // told to "finish paying" after a year of paying would be nonsense.
  const unpaid = state.slug == null && awaitingPaymentFromMetadata(org?.metadata ?? null);

  return {
    ...limitsForPlan(slug, memberCount),
    grace: unpaid ? "awaiting_payment" : state.grace,
  };
}

/**
 * Effective limits for an organization. Unlimited when billing is off.
 *
 * Any failure resolves to unlimited rather than propagating: a database blip
 * must not turn into a write block on someone's files.
 */
export async function entitlementsForOrg(orgId: string): Promise<PlanLimits> {
  // An org with a plan assigned to it is enforced regardless of the deployment
  // flag — assigning a tier by hand has to actually do something.
  if (!billingEnabled() && !(await hasAssignedPlan(orgId))) return UNLIMITED_LIMITS;

  const now = Date.now();
  const cached = orgCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.limits;

  let limits: PlanLimits;
  try {
    limits = await loadLimitsForOrg(orgId);
  } catch (err) {
    console.error(`plan resolution failed for org ${orgId}; falling back to unlimited:`, err);
    return UNLIMITED_LIMITS;
  }
  orgCache.set(orgId, { limits, expiresAt: now + CACHE_TTL_MS });
  return limits;
}

/** Effective limits for the org that owns a workspace. */
export async function entitlementsForWorkspace(workspaceId: string): Promise<PlanLimits> {
  const now = Date.now();
  const cached = workspaceOrgCache.get(workspaceId);
  let orgId = cached && cached.expiresAt > now ? cached.orgId : null;

  if (orgId == null) {
    try {
      const ws = await usePrismaClient().workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      });
      if (!ws) return UNLIMITED_LIMITS;
      orgId = ws.organizationId;
      workspaceOrgCache.set(workspaceId, { orgId, expiresAt: now + CACHE_TTL_MS });
    } catch (err) {
      console.error(`workspace org lookup failed for ${workspaceId}:`, err);
      return UNLIMITED_LIMITS;
    }
  }

  return entitlementsForOrg(orgId);
}