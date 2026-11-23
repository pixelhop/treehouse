import { usePrismaClient } from "db";
import { createError } from "h3";
import { entitlementsForOrg } from "./plans";

// Org-scoped plan limits: how many workspaces an org may hold, how many members
// it may have, and how many orgs one user may create.
//
// These sit apart from quota.ts, which owns the per-WORKSPACE write limits. The
// split follows the billing entity: an org is what carries a plan, so anything
// counted per-org lives here and anything counted per-workspace lives there.
//
// Every guard is a no-op when the org's plan is unlimited, which is the case for
// every deployment until billing is switched on.

/**
 * 402 Payment Required with a machine-readable discriminator.
 *
 * 402 rather than 403 deliberately: this is not "you may not", it is "your plan
 * does not include this", and the app keys its upgrade prompts off the
 * distinction. A permission failure elsewhere still returns 403/404.
 */
function planLimitError(code: string, used: number, limit: number) {
  return createError({
    statusCode: 402,
    statusMessage: "Plan limit reached",
    data: { error: code, used, limit },
  });
}

/**
 * How many FREE workspaces one user may own.
 *
 * Paid workspaces are deliberately uncapped — each one pays for itself, so
 * there is nothing to ration. Free ones are the cost, and this is the only
 * thing standing between us and one person holding fifty of them.
 *
 * A per-user constant rather than a plan field: it is an abuse guard, not a
 * feature anyone buys, and expressing it per-tier would imply that paying earns
 * you more *free* workspaces, which is precisely the loophole this closes.
 */
const DEFAULT_FREE_WORKSPACES_PER_USER = 1;

/**
 * How many workspaces a user may hold waiting for a payment that has not
 * arrived.
 *
 * Buying skips the free allowance, so without a bound here "create it on Grove"
 * would be an unlimited-workspace button for anyone willing to abandon checkout.
 * They would all be read-only, but rows are still rows. One at a time is enough
 * for the real flow — finish paying, or the one you left is still there to
 * finish paying for.
 */
const PENDING_WORKSPACES_PER_USER = 1;

export function freeWorkspacesPerUser(): number {
  const raw = process.env.FREE_WORKSPACES_PER_USER;
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_FREE_WORKSPACES_PER_USER;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : DEFAULT_FREE_WORKSPACES_PER_USER;
}

/**
 * Throw 402 when a user already owns their allowance of FREE workspaces.
 *
 * Counts only the free ones. A new workspace always starts free — it has no
 * subscription yet — so creating one consumes a slot until it is upgraded.
 *
 * This replaced a "most generous allowance across everything you own" rule that
 * had exactly the wrong shape: owning one paid workspace made the allowance
 * unlimited, so a single $12 subscription bought an unbounded number of free
 * workspaces. Paid workspaces are now simply not counted.
 *
 * Counts workspaces the user OWNS, never ones they were invited into: being a
 * member of someone else's workspace must not consume your own allowance.
 *
 * Someone creating a workspace to PAY for it is not consuming the free
 * allowance and is not checked against it — see `intendsToPay`. They are held to
 * a separate, much smaller allowance of workspaces awaiting a payment that has
 * not arrived, so the paid path cannot be used as an unlimited-workspace button.
 *
 * Called from `createWorkspaceWithOrg`, the single funnel every creation path
 * goes through — REST, MCP, and the signup hook.
 */
export async function assertCanCreateWorkspace(
  userId: string,
  /**
   * The caller is creating this workspace ON a paid plan and will be sent to
   * checkout for it. The free allowance does not apply — they are not asking for
   * another free workspace, they are asking to buy one.
   *
   * Without this the only way past the cap was to upgrade an EXISTING workspace,
   * which is backwards: someone with a free personal workspace who wants a paid
   * one for work would have had to start paying for their personal files.
   */
  intendsToPay = false,
): Promise<void> {
  const db = usePrismaClient();
  const owned = await db.member.findMany({
    where: { userId, role: "owner" },
    select: { organizationId: true },
  });
  // Nothing owned yet: the first workspace is always allowed, which keeps
  // sign-up working no matter how the limit is configured.
  if (owned.length === 0) return;

  let free = 0;
  let pending = 0;
  for (const { organizationId } of owned) {
    const limits = await entitlementsForOrg(organizationId);
    if (limits.grace === "awaiting_payment") {
      // Created on the promise of a subscription that never arrived. Not a free
      // workspace — it is read-only until it is paid for — so it is counted
      // against the pending allowance instead.
      pending++;
      continue;
    }
    // "Free" means the entitling plan is the free tier. legacy/unlimited are
    // not free tiers — they are grandfathered or self-hosted, and capping those
    // would punish exactly the people who predate billing.
    if (limits.slug === "seedling") free++;
  }

  if (intendsToPay) {
    if (pending >= PENDING_WORKSPACES_PER_USER) {
      throw planLimitError("pending_checkout_limit_reached", pending, PENDING_WORKSPACES_PER_USER);
    }
    return;
  }

  const allowance = freeWorkspacesPerUser();
  if (free >= allowance) {
    throw planLimitError("free_workspace_limit_reached", free, allowance);
  }
}

/**
 * Throw 402 when adding one more member would exceed the org's plan.
 *
 * Called both when an invite link is minted (so the limit surfaces at the moment
 * someone tries to grow the team, which is the useful upgrade prompt) and when
 * one is accepted (which is the gate that actually holds, since a link can be
 * forwarded). Two simultaneous accepts can both pass this check and overshoot by
 * one; the org is then one member over until someone is removed, which is
 * harmless — the alternative is locking the member table on every accept.
 */
export async function assertCanAddMember(orgId: string): Promise<void> {
  const limits = await entitlementsForOrg(orgId);
  if (limits.membersPerOrg == null) return;
  const used = await usePrismaClient().member.count({ where: { organizationId: orgId } });
  if (used >= limits.membersPerOrg) {
    throw planLimitError("member_limit_reached", used, limits.membersPerOrg);
  }
}