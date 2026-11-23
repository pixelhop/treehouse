import { describe, expect, it } from "vite-plus/test";
import { type PlanOffer, planCardPrice, planLimitLines } from "../app/utils/planPricing";

// Shaped like the live `/api/plans` response.
const seedling: PlanOffer = {
  slug: "seedling",
  label: "Seedling",
  paid: false,
  monthly: null,
  annual: null,
  highlights: {
    filesPerWorkspace: 1_000,
    storageBytesPerWorkspace: 1024 ** 3,
    membersPerOrg: 1,
    shareViewsPerMonth: 500,
    workspacesPerUser: 1,
  },
};

const grove: PlanOffer = {
  slug: "grove",
  label: "Grove",
  paid: true,
  monthly: { interval: "month", unitAmount: 1200, currency: "usd" },
  annual: { interval: "year", unitAmount: 12_000, currency: "usd" },
  highlights: {
    filesPerWorkspace: 25_000,
    storageBytesPerWorkspace: 50 * 1024 ** 3,
    membersPerOrg: null,
    shareViewsPerMonth: null,
    workspacesPerUser: null,
  },
};

describe("homepage plan cards", () => {
  it("calls the free tier free, with no billing period", () => {
    expect(planCardPrice("seedling", seedling)).toEqual({
      price: "Free",
      period: "",
      yearly: null,
    });
  });

  it("quotes a paid tier per member per month, with the yearly rate beside it", () => {
    const card = planCardPrice("grove", grove);
    expect(card.price).toMatch(/12$/);
    expect(card.period).toBe("per member / month");
    expect(card.yearly).toMatch(/^or .*10 a month, billed yearly$/);
  });

  it("shows no number for a paid tier whose price could not be read", () => {
    // Never a guessed price: the API was unreachable or Stripe had no price.
    expect(planCardPrice("grove", undefined)).toEqual({ price: null, period: "", yearly: null });
    expect(planCardPrice("grove", { ...grove, monthly: null, annual: null }).price).toBeNull();
  });

  it("lists the free tier's caps", () => {
    expect(planLimitLines(seedling)).toEqual([
      "One workspace",
      "Just you",
      "1 GB storage per workspace",
      "1,000 files per workspace",
      "500 share-link views a month",
    ]);
  });

  it("calls a paid tier's missing caps unlimited", () => {
    expect(planLimitLines(grove)).toEqual([
      "Unlimited workspaces",
      "Unlimited members",
      "50 GB storage per workspace",
      "25,000 files per workspace",
      "Unlimited share-link views",
    ]);
  });

  it("counts plural caps", () => {
    const team = {
      ...seedling,
      highlights: {
        ...seedling.highlights,
        workspacesPerUser: 3,
        membersPerOrg: 5,
        storageBytesPerWorkspace: 500 * 1024 ** 2,
      },
    };
    expect(planLimitLines(team).slice(0, 3)).toEqual([
      "3 workspaces",
      "Up to 5 members",
      "500 MB storage per workspace",
    ]);
  });
});