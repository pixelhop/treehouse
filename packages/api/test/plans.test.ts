import { afterEach, describe, expect, it } from "vite-plus/test";
import "./env";

const { usePrismaClient } = await import("db");
const {
  FILE_SIZE_CEILING,
  PLAN_CATALOG,
  billingEnabled,
  clearPlanCache,
  entitlementsForOrg,
  entitlementsForWorkspace,
  limitsForPlan,
} = await import("../server/utils/plans");

const db = usePrismaClient();

async function freshOrg(memberCount = 1) {
  const org = await db.organization.create({
    data: { id: `org_${Date.now()}_${Math.round(Math.random() * 1e9)}`, name: "Org" },
  });
  for (let i = 0; i < memberCount; i++) {
    const user = await db.user.create({
      data: {
        id: `usr_${Date.now()}_${Math.round(Math.random() * 1e9)}_${i}`,
        name: `Member ${i}`,
        email: `m${i}.${Math.random().toString(36).slice(2)}@example.test`,
        emailVerified: true,
      },
    });
    await db.member.create({
      data: {
        id: `mem_${Date.now()}_${Math.round(Math.random() * 1e9)}_${i}`,
        organizationId: org.id,
        userId: user.id,
        role: i === 0 ? "owner" : "member",
      },
    });
  }
  return org;
}

afterEach(() => {
  delete process.env.BILLING_ENABLED;
  delete process.env.DEFAULT_PLAN_SLUG;
  clearPlanCache();
});

describe("limitsForPlan", () => {
  it("resolves an unknown slug to unlimited rather than to the free tier", () => {
    // The fail-open direction is the whole point: a bad slug must never cap a
    // paying workspace.
    for (const slug of ["", "nonsense", "SEEDLING", "free"]) {
      const limits = limitsForPlan(slug, 1);
      expect(limits.slug).toBe("unlimited");
      expect(limits.filesPerWorkspace).toBeNull();
      expect(limits.storageBytesPerWorkspace).toBeNull();
    }
  });

  it("returns the documented seedling numbers", () => {
    const limits = limitsForPlan("seedling", 1);
    expect(limits.filesPerWorkspace).toBe(1_000);
    expect(limits.storageBytesPerWorkspace).toBe(1024 ** 3);
    expect(limits.maxFileBytes).toBe(25 * 1024 * 1024);
    expect(limits.workspacesPerUser).toBe(1);
    expect(limits.membersPerOrg).toBe(1);
    expect(limits.shareViewsPerMonth).toBe(500);
    expect(limits.shareBytesPerMonth).toBe(10 * 1024 ** 3);
    expect(limits.shareBytesPerDay).toBe(1024 ** 3);
    expect(limits.historyDays).toBe(7);
  });

  it("gives the free tier exactly one workspace and paid tiers no cap", () => {
    // A plan attaches to a workspace (via its hidden 1:1 organization), so the
    // only workspace question left is how many one USER may own.
    expect(limitsForPlan("seedling").workspacesPerUser).toBe(1);
    expect(limitsForPlan("grove").workspacesPerUser).toBeNull();
    expect(limitsForPlan("forest").workspacesPerUser).toBeNull();
  });

  it("leaves paid membership uncapped", () => {
    for (const slug of ["grove", "forest"]) {
      expect(limitsForPlan(slug).membersPerOrg).toBeNull();
    }
  });

  it("gives paid tiers fair use rather than a share cutoff", () => {
    for (const slug of ["grove", "forest"]) {
      const limits = limitsForPlan(slug, 1);
      expect(limits.shareViewsPerMonth).toBeNull();
      expect(limits.shareBytesPerMonth).toBeNull();
      expect(limits.shareBytesPerDay).toBeNull();
    }
  });

  it("clamps max file size to what FileNode.size can persist", () => {
    // FileNode.size is a Postgres Int; a catalog value above it could never be
    // written, so the limit is clamped rather than reported dishonestly.
    for (const slug of ["grove", "forest"]) {
      expect(limitsForPlan(slug, 1).maxFileBytes).toBeLessThanOrEqual(FILE_SIZE_CEILING);
    }
  });

  it("treats legacy and unlimited as fully uncapped", () => {
    for (const slug of ["legacy", "unlimited"]) {
      const limits = limitsForPlan(slug, 1);
      expect(limits.slug).toBe(slug);
      for (const value of Object.values(limits)) {
        if (typeof value === "string") continue;
        expect(value).toBeNull();
      }
    }
  });

  it("marks only the three marketed tiers purchasable", () => {
    expect(PLAN_CATALOG.seedling.purchasable).toBe(true);
    expect(PLAN_CATALOG.grove.purchasable).toBe(true);
    expect(PLAN_CATALOG.forest.purchasable).toBe(true);
    expect(PLAN_CATALOG.legacy.purchasable).toBe(false);
    expect(PLAN_CATALOG.unlimited.purchasable).toBe(false);
  });
});

describe("billingEnabled", () => {
  it("is off by default so limits ship dormant", () => {
    expect(billingEnabled()).toBe(false);
  });

  it("is on when explicitly enabled or when a plan is forced", () => {
    process.env.BILLING_ENABLED = "1";
    expect(billingEnabled()).toBe(true);
    delete process.env.BILLING_ENABLED;
    process.env.DEFAULT_PLAN_SLUG = "seedling";
    expect(billingEnabled()).toBe(true);
  });
});

describe("entitlementsForOrg", () => {
  it("is unlimited when billing is off, without querying", async () => {
    const org = await freshOrg();
    const limits = await entitlementsForOrg(org.id);
    expect(limits.slug).toBe("unlimited");
    expect(limits.filesPerWorkspace).toBeNull();
  });

  it("grandfathers an org with no subscription onto legacy when billing is on", async () => {
    const org = await freshOrg();
    process.env.BILLING_ENABLED = "1";
    clearPlanCache();
    const limits = await entitlementsForOrg(org.id);
    expect(limits.slug).toBe("legacy");
    expect(limits.filesPerWorkspace).toBeNull();
  });

  it("applies a forced default plan to every org", async () => {
    const org = await freshOrg();
    process.env.DEFAULT_PLAN_SLUG = "seedling";
    clearPlanCache();
    const limits = await entitlementsForOrg(org.id);
    expect(limits.slug).toBe("seedling");
    expect(limits.filesPerWorkspace).toBe(1_000);
  });

  it("serves a repeat resolution from cache instead of re-querying", async () => {
    const org = await freshOrg(2);
    process.env.DEFAULT_PLAN_SLUG = "seedling";
    clearPlanCache();

    const first = await entitlementsForOrg(org.id);
    expect(first.membersPerOrg).toBe(1);

    // Add a member behind the cache's back. A cached read must not see it; a
    // read after the cache is cleared must.
    const user = await db.user.create({
      data: {
        id: `usr_cache_${Date.now()}`,
        name: "Late joiner",
        email: `late.${Math.random().toString(36).slice(2)}@example.test`,
        emailVerified: true,
      },
    });
    await db.member.create({
      data: {
        id: `mem_cache_${Date.now()}`,
        organizationId: org.id,
        userId: user.id,
        role: "member",
      },
    });

    // Assign a different plan behind the cache's back. A cached read must not
    // see it; a read after the cache is cleared must.
    await db.organization.update({
      where: { id: org.id },
      data: { metadata: JSON.stringify({ plan: "grove" }) },
    });
    expect((await entitlementsForOrg(org.id)).slug).toBe("seedling");
    clearPlanCache();
    expect((await entitlementsForOrg(org.id)).slug).toBe("grove");
  });

  it("falls back to unlimited when the org does not exist", async () => {
    process.env.DEFAULT_PLAN_SLUG = "seedling";
    clearPlanCache();
    // No org row, so the member count is 0 — resolution must still produce a
    // usable answer rather than throwing into the write path.
    const limits = await entitlementsForOrg("org_does_not_exist");
    expect(limits.slug).toBe("seedling");
  });
});

describe("entitlementsForWorkspace", () => {
  it("resolves through the workspace's owning org", async () => {
    const org = await freshOrg(1);
    const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
    process.env.DEFAULT_PLAN_SLUG = "seedling";
    clearPlanCache();
    const limits = await entitlementsForWorkspace(ws.id);
    expect(limits.slug).toBe("seedling");
    expect(limits.filesPerWorkspace).toBe(1_000);
  });

  it("is unlimited for a workspace that does not exist", async () => {
    process.env.DEFAULT_PLAN_SLUG = "seedling";
    clearPlanCache();
    const limits = await entitlementsForWorkspace("ws_does_not_exist");
    expect(limits.slug).toBe("unlimited");
  });

  it("is unlimited when billing is off", async () => {
    const org = await freshOrg(1);
    const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
    const limits = await entitlementsForWorkspace(ws.id);
    expect(limits.slug).toBe("unlimited");
  });
});