import { afterEach, describe, expect, it } from "vite-plus/test";
import "./env";

// The per-workspace member limit.
//
// The workspace-count rule lives in billing-surface.test.ts instead: it is now a
// cap on FREE workspaces per user rather than total workspaces, so it belongs
// with the billing surface it is expressed in.

const { usePrismaClient } = await import("db");
const { assertCanAddMember } = await import("../server/utils/limits");
const { clearPlanCache } = await import("../server/utils/plans");

const db = usePrismaClient();

let seq = 0;
const uid = () => `${Date.now()}_${Math.round(Math.random() * 1e9)}_${seq++}`;

async function newUser() {
  return db.user.create({
    data: {
      id: `usr_${uid()}`,
      name: "Test",
      email: `u${uid()}@example.test`,
      emailVerified: true,
    },
  });
}

async function newOrg(opts: { owner?: { id: string }; members?: number } = {}) {
  const org = await db.organization.create({ data: { id: `org_${uid()}`, name: "Org" } });
  const owner = opts.owner ?? (await newUser());
  await db.member.create({
    data: { id: `mem_${uid()}`, organizationId: org.id, userId: owner.id, role: "owner" },
  });
  for (let i = 1; i < (opts.members ?? 1); i++) {
    const u = await newUser();
    await db.member.create({
      data: { id: `mem_${uid()}`, organizationId: org.id, userId: u.id, role: "member" },
    });
  }
  return { org, owner };
}

/** Capture the h3 error a guard throws, or null when it allowed the action. */
async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as {
      statusCode?: number;
      data?: { error?: string; used?: number; limit?: number };
    };
    return { statusCode: e.statusCode, ...e.data };
  }
}

afterEach(() => {
  delete process.env.DEFAULT_PLAN_SLUG;
  delete process.env.BILLING_ENABLED;
  clearPlanCache();
});

describe("member count limit", () => {
  it("refuses a second member on the free tier", async () => {
    const { org } = await newOrg({ members: 1 });
    process.env.DEFAULT_PLAN_SLUG = "seedling"; // 1 member
    clearPlanCache();

    const refused = await refusal(() => assertCanAddMember(org.id));
    expect(refused).toEqual({ statusCode: 402, error: "member_limit_reached", used: 1, limit: 1 });
  });

  it("allows members freely on a paid plan", async () => {
    const { org } = await newOrg({ members: 6 });
    process.env.DEFAULT_PLAN_SLUG = "grove";
    clearPlanCache();
    expect(await refusal(() => assertCanAddMember(org.id))).toBeNull();
  });

  it("never refuses when billing is off", async () => {
    const { org } = await newOrg({ members: 4 });
    expect(await refusal(() => assertCanAddMember(org.id))).toBeNull();
  });
});