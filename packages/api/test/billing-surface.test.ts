import { afterEach, describe, expect, it } from "vite-plus/test";
import "./env";

// What the app is told about a workspace's plan, and the free-workspace cap.
//
// The gap this closes: everything below already existed server-side but was
// never sent to the client, so a paying customer could not see that they were
// paying and had no way to manage or cancel.

const { usePrismaClient } = await import("db");
const { auth } = await import("../server/utils/auth");
const { billingForWorkspace } = await import("../server/utils/billing-summary");
const { assertCanCreateWorkspace, freeWorkspacesPerUser } = await import("../server/utils/limits");
const { assignPlan, clearPlanCache } = await import("../server/utils/plans");
const { createWorkspaceWithOrg } = await import("../server/utils/workspace");
const db = usePrismaClient();

let seq = 0;
const uid = () => `${Date.now()}_${Math.round(Math.random() * 1e9)}_${seq++}`;

async function userWithWorkspace(plan?: "seedling" | "grove") {
  // New workspaces only carry a plan stamp when billing is on, so the tests
  // that care about tiers switch it on explicitly.
  const email = `bs${uid()}@example.test`;
  const { user } = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "BS" },
  });
  const ws = await db.workspace.findFirst({
    where: { organization: { members: { some: { userId: user.id } } } },
  });
  if (plan) await assignPlan(ws!.organizationId, plan);
  return { user, ws: ws! };
}

/** A second workspace for the same user, on a given plan. */
async function extraWorkspace(userId: string, plan: "seedling" | "grove") {
  const org = await db.organization.create({ data: { id: `org_x_${uid()}`, name: "X" } });
  await db.member.create({
    data: { id: `mem_x_${uid()}`, organizationId: org.id, userId, role: "owner" },
  });
  await db.workspace.create({ data: { organizationId: org.id, name: "X" } });
  await assignPlan(org.id, plan);
}

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { statusCode?: number; data?: { error?: string } };
    return { statusCode: e.statusCode, error: e.data?.error };
  }
}

afterEach(() => {
  delete process.env.BILLING_ENABLED;
  delete process.env.FREE_WORKSPACES_PER_USER;
  delete process.env.DEFAULT_PLAN_SLUG;
  clearPlanCache();
});

describe("what the app is told about a plan", () => {
  it("names the plan rather than leaving the client to guess", async () => {
    const { user, ws } = await userWithWorkspace("grove");
    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.plan).toBe("grove");
    expect(b.planLabel).toBe("Grove");
    expect(b.paid).toBe(true);
  });

  it("reports a free workspace as free, not as an absence", async () => {
    const { user, ws } = await userWithWorkspace("seedling");
    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.planLabel).toBe("Seedling");
    expect(b.paid).toBe(false);
    expect(b.readOnly).toBe(false);
    expect(b.grace).toBe("none");
  });

  it("never exposes an internal slug as a label", async () => {
    // A grandfathered org predates billing, so it carries no plan stamp — the
    // shape a workspace created before this feature has.
    const { user, ws } = await userWithWorkspace();
    await db.organization.update({
      where: { id: ws.organizationId },
      data: { metadata: null },
    });
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.plan).toBe("legacy");
    // "legacy" is an internal word nobody chose; they see what it means instead.
    expect(b.planLabel).toBe("Unlimited");
  });

  it("lets an owner manage billing and a member not", async () => {
    const { user, ws } = await userWithWorkspace("grove");
    expect((await billingForWorkspace(ws.id, user.id)).canManageBilling).toBe(true);

    const other = await db.user.create({
      data: {
        id: `usr_m_${uid()}`,
        name: "M",
        email: `m${uid()}@example.test`,
        emailVerified: true,
      },
    });
    await db.member.create({
      data: {
        id: `mem_m_${uid()}`,
        organizationId: ws.organizationId,
        userId: other.id,
        role: "member",
      },
    });
    expect((await billingForWorkspace(ws.id, other.id)).canManageBilling).toBe(false);
  });

  it("offers billing management once a subscription carries a customer", async () => {
    // The plugin records the Stripe customer on the SUBSCRIPTION row, not on the
    // organization. Reading only the org meant a customer who had just paid was
    // never offered "Manage billing" — no way to change a card or cancel.
    const { user, ws } = await userWithWorkspace();
    await db.subscription.create({
      data: {
        id: `sub_${uid()}`,
        plan: "grove",
        referenceId: ws.organizationId,
        status: "active",
        seats: 1,
        periodEnd: new Date(Date.now() + 86_400_000),
        stripeCustomerId: `cus_${uid()}`,
        stripeSubscriptionId: `sub_stripe_${uid()}`,
      },
    });
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.hasBillingAccount).toBe(true);
    expect(b.seats).toBe(1);
    expect(b.periodEnd).not.toBeNull();
  });

  it("does not report seats or a portal for a checkout that was abandoned", async () => {
    // The plugin writes the subscription row when checkout OPENS — status
    // "incomplete", seats already set, a Stripe customer already created. A free
    // workspace whose owner once opened a Forest checkout and closed the tab was
    // therefore telling them "Seedling — 5 seats" and offering "Manage billing"
    // for a subscription that had never taken a penny.
    const { user, ws } = await userWithWorkspace("seedling");
    await db.subscription.create({
      data: {
        id: `sub_${uid()}`,
        plan: "forest-annual",
        referenceId: ws.organizationId,
        status: "incomplete",
        seats: 5,
        stripeCustomerId: `cus_${uid()}`,
      },
    });
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();

    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.plan).toBe("seedling");
    expect(b.seats).toBeNull();
    expect(b.status).toBeNull();
    expect(b.hasBillingAccount).toBe(false);
  });

  it("counts the people a checkout would have to buy seats for", async () => {
    // The number the plan picker quotes a total from, and the one the checkout
    // route opens Stripe with. It is NOT `seats`: a workspace that has bought
    // nothing has no seats and still has people in it, which is exactly the
    // case that was being quoted a one-person price.
    const { user, ws } = await userWithWorkspace();
    expect((await billingForWorkspace(ws.id, user.id)).members).toBe(1);

    for (let i = 0; i < 4; i++) {
      const other = await db.user.create({
        data: {
          id: `usr_c_${uid()}`,
          name: "C",
          email: `c${uid()}@example.test`,
          emailVerified: true,
        },
      });
      await db.member.create({
        data: {
          id: `mem_c_${uid()}`,
          organizationId: ws.organizationId,
          userId: other.id,
          role: "member",
        },
      });
    }

    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.members).toBe(5);
    // Still nothing billed — membership is what a purchase WOULD cost.
    expect(b.seats).toBeNull();
  });

  it("reports no seats or renewal date when nothing is actually billed", async () => {
    // A plan assigned by hand has no Stripe presence; claiming a renewal date
    // for it would be a fiction.
    const { user, ws } = await userWithWorkspace("grove");
    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.seats).toBeNull();
    expect(b.periodEnd).toBeNull();
    expect(b.hasBillingAccount).toBe(false);
  });
});

describe("a new workspace starts on the free tier", () => {
  it("is seedling, not the grandfathering fallback", async () => {
    // The fallback is `legacy` (unlimited) and exists for organizations that
    // predate billing. A workspace created just now has no subscription either,
    // so without an explicit plan it would inherit unlimited — and the free tier
    // would apply to nobody who signed up after launch.
    //
    // Billing must be on BEFORE creation: the plan is stamped at creation time,
    // which is what keeps workspaces made on a dormant deployment unlimited.
    process.env.BILLING_ENABLED = "1";
    const { user, ws } = await userWithWorkspace();
    clearPlanCache();
    const b = await billingForWorkspace(ws.id, user.id);
    expect(b.plan).toBe("seedling");
    expect(b.paid).toBe(false);
  });

  it("stays unlimited when created on a deployment with billing off", async () => {
    // The dormancy guarantee: a self-hosted or unbilled deployment must behave
    // exactly as it did before this feature existed.
    const { user, ws } = await userWithWorkspace();
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    expect((await billingForWorkspace(ws.id, user.id)).plan).toBe("legacy");
  });
});

describe("free workspace cap", () => {
  it("allows the first workspace for a brand-new user", async () => {
    const user = await db.user.create({
      data: {
        id: `usr_n_${uid()}`,
        name: "N",
        email: `n${uid()}@example.test`,
        emailVerified: true,
      },
    });
    expect(await refusal(() => assertCanCreateWorkspace(user.id))).toBeNull();
  });

  it("refuses a second free workspace", async () => {
    const { user } = await userWithWorkspace("seedling");
    clearPlanCache();
    expect(await refusal(() => assertCanCreateWorkspace(user.id))).toEqual({
      statusCode: 402,
      error: "free_workspace_limit_reached",
    });
  });

  it("does not let one paid workspace unlock unlimited free ones", async () => {
    // The hole this closes: the old rule took the most generous allowance across
    // everything owned, so a single paid workspace made the cap unlimited — and
    // every new workspace starts free. Pay once, get unlimited free.
    const { user } = await userWithWorkspace("grove");
    await extraWorkspace(user.id, "seedling");
    clearPlanCache();
    expect((await refusal(() => assertCanCreateWorkspace(user.id)))?.error).toBe(
      "free_workspace_limit_reached",
    );
  });

  it("does not count paid workspaces against the allowance", async () => {
    const { user } = await userWithWorkspace("grove");
    await extraWorkspace(user.id, "grove");
    clearPlanCache();
    // Two paid workspaces, no free ones — a free one is still available.
    expect(await refusal(() => assertCanCreateWorkspace(user.id))).toBeNull();
  });

  it("does not count workspaces the user was merely invited into", async () => {
    const { user } = await userWithWorkspace("seedling");
    const host = await userWithWorkspace("seedling");
    await db.member.create({
      data: {
        id: `mem_i_${uid()}`,
        organizationId: host.ws.organizationId,
        userId: user.id,
        role: "member",
      },
    });
    clearPlanCache();
    // Still exactly one OWNED free workspace, so the refusal names one, not two.
    const r = await refusal(() => assertCanCreateWorkspace(user.id));
    expect(r?.error).toBe("free_workspace_limit_reached");
  });

  it("honours a raised allowance", async () => {
    const { user } = await userWithWorkspace("seedling");
    process.env.FREE_WORKSPACES_PER_USER = "3";
    clearPlanCache();
    expect(freeWorkspacesPerUser()).toBe(3);
    expect(await refusal(() => assertCanCreateWorkspace(user.id))).toBeNull();
  });
});

describe("buying a workspace instead of upgrading one", () => {
  // The flaw this closes: the free cap's only escape was upgrading an EXISTING
  // workspace. Someone whose personal files sat in their free workspace, wanting
  // a paid one for work, was told to start paying for their personal files.

  it("does not spend the free allowance on a workspace being bought", async () => {
    const { user } = await userWithWorkspace("seedling");
    clearPlanCache();
    // The same user, same instant: refused a free one, allowed a paid one.
    expect((await refusal(() => assertCanCreateWorkspace(user.id)))?.error).toBe(
      "free_workspace_limit_reached",
    );
    expect(await refusal(() => assertCanCreateWorkspace(user.id, true))).toBeNull();
  });

  it("holds it read-only until the subscription actually starts", async () => {
    // Otherwise "create it on Grove" plus an abandoned checkout is simply a
    // second free workspace with extra steps.
    process.env.BILLING_ENABLED = "1";
    const { user } = await userWithWorkspace("seedling");
    const bought = await createWorkspaceWithOrg({
      userId: user.id,
      name: "Work",
      intendsToPay: true,
    });
    clearPlanCache();

    const b = await billingForWorkspace(bought.id, user.id);
    expect(b.grace).toBe("awaiting_payment");
    expect(b.readOnly).toBe(true);
    expect(b.paid).toBe(false);
    // Free-tier limits, not paid ones — nothing is granted before payment.
    expect(b.plan).toBe("seedling");
  });

  it("opens up the moment the subscription arrives", async () => {
    process.env.BILLING_ENABLED = "1";
    const { user } = await userWithWorkspace("seedling");
    const bought = await createWorkspaceWithOrg({
      userId: user.id,
      name: "Work",
      intendsToPay: true,
    });
    const ws = await db.workspace.findUnique({ where: { id: bought.id } });
    await db.subscription.create({
      data: {
        id: `sub_${uid()}`,
        plan: "grove",
        referenceId: ws!.organizationId,
        status: "active",
        seats: 1,
        periodEnd: new Date(Date.now() + 86_400_000),
        stripeCustomerId: `cus_${uid()}`,
        stripeSubscriptionId: `sub_stripe_${uid()}`,
      },
    });
    clearPlanCache();

    const b = await billingForWorkspace(bought.id, user.id);
    // The `awaitingPayment` stamp is still on the org; an entitling subscription
    // simply outranks it, so nothing has to clear it on the webhook path.
    expect(b.grace).toBe("none");
    expect(b.readOnly).toBe(false);
    expect(b.plan).toBe("grove");
  });

  it("refuses a second unpaid one, so the paid path is not an unlimited button", async () => {
    process.env.BILLING_ENABLED = "1";
    const { user } = await userWithWorkspace("seedling");
    await createWorkspaceWithOrg({ userId: user.id, name: "Work", intendsToPay: true });
    clearPlanCache();
    expect(await refusal(() => assertCanCreateWorkspace(user.id, true))).toEqual({
      statusCode: 402,
      error: "pending_checkout_limit_reached",
    });
  });

  it("does not count an unpaid bought workspace against the FREE allowance", async () => {
    // It is read-only and unusable as a free workspace, so it must not also
    // consume the free one someone is entitled to.
    process.env.BILLING_ENABLED = "1";
    process.env.FREE_WORKSPACES_PER_USER = "2";
    const { user } = await userWithWorkspace("seedling");
    await createWorkspaceWithOrg({ userId: user.id, name: "Work", intendsToPay: true });
    clearPlanCache();
    // One free workspace owned, allowance of two: the second free one is still
    // available despite the pending purchase sitting alongside it.
    expect(await refusal(() => assertCanCreateWorkspace(user.id))).toBeNull();
  });
});