/**
 * Signup links are how a comparison page's signups get measured, so their tags
 * must stay stable: renaming one splits the history in two.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  formatCheckedDate,
  hubJsonLd,
  isLandingPath,
  landingJsonLd,
  needsFullLoad,
  signupCampaign,
  signupHref,
  type LandingPage,
} from "../../app/utils/landing";
import { landingLlmsSections, renderLandingTwin } from "../../server/utils/landing-markdown";

const PAGE: LandingPage = {
  path: "/compare/obsidian",
  title: "Keep Obsidian",
  seoTitle: "Obsidian for teams",
  description: "A description.",
  kind: "comparison",
  competitor: "Obsidian",
  eyebrow: "Obsidian for teams",
  cardTitle: "Obsidian",
  position: 1,
  lastChecked: "2026-10-30",
  summary: ["The first point."],
  cta: {
    heading: "Share your vault",
    body: "Point it at a folder.",
    label: "Share",
    note: "Free.",
  },
  endCta: { heading: "Bring your vault", body: "Connect it.", label: "Start" },
  comparison: [{ label: "A | B", treehouse: "Yes", them: "No" }],
  faq: [{ question: "Why?", answer: "Because." }],
  sources: [{ label: "Pricing", url: "https://obsidian.md/pricing" }],
};

describe("isLandingPath", () => {
  it("matches the sections and nothing that merely starts the same", () => {
    expect(isLandingPath("/compare")).toBe(true);
    expect(isLandingPath("/compare/obsidian")).toBe(true);
    expect(isLandingPath("/guides/a-guide")).toBe(true);
    expect(isLandingPath("/compare-plans")).toBe(false);
    expect(isLandingPath("/")).toBe(false);
    expect(isLandingPath("/docs")).toBe(false);
  });
});

describe("needsFullLoad", () => {
  it("is for arriving at a landing page, never for staying on one", () => {
    expect(needsFullLoad("/compare", "/")).toBe(true);
    expect(needsFullLoad("/compare/obsidian", "/compare")).toBe(true);
    expect(needsFullLoad("/compare", "/compare")).toBe(false);
    expect(needsFullLoad("/docs", "/compare")).toBe(false);
  });
});

describe("signup attribution", () => {
  it("names each page", () => {
    expect(signupCampaign("/compare/obsidian")).toBe("compare-obsidian");
    expect(signupCampaign("/compare")).toBe("compare-hub");
    expect(signupCampaign("/guides/a-guide")).toBe("guide-a-guide");
  });

  it("tags the link with the page and placement", () => {
    const url = new URL(signupHref("https://app.example.com", "/guides/a-guide", "hero"));
    expect(url.origin + url.pathname).toBe("https://app.example.com/sign-up");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: "trytree.house",
      utm_medium: "guide",
      utm_campaign: "guide-a-guide",
      utm_content: "hero",
    });
  });
});

describe("formatCheckedDate", () => {
  it("reads a date, and gives nothing for a bad one", () => {
    expect(formatCheckedDate("2026-10-30")).toBe("30 October 2026");
    expect(formatCheckedDate("not a date")).toBe("");
    expect(formatCheckedDate(undefined)).toBe("");
  });
});

describe("structured data", () => {
  it("describes the article, its breadcrumbs and its FAQ, with no prices or ratings", () => {
    const json = landingJsonLd(PAGE, "https://trytree.house");
    const types = (json["@graph"] as { "@type": string }[]).map((node) => node["@type"]);
    expect(types).toEqual(["Article", "BreadcrumbList", "FAQPage"]);
    expect(JSON.stringify(json)).not.toMatch(/aggregateRating|"offers"/);
  });

  it("leaves the FAQ out when the page has none", () => {
    const json = landingJsonLd({ ...PAGE, faq: undefined }, "https://trytree.house");
    const types = (json["@graph"] as { "@type": string }[]).map((node) => node["@type"]);
    expect(types).not.toContain("FAQPage");
  });

  it("lists the hub's pages", () => {
    const json = hubJsonLd([PAGE], "https://trytree.house");
    expect(JSON.stringify(json)).toContain("https://trytree.house/compare/obsidian");
  });
});

describe("renderLandingTwin", () => {
  const twin = renderLandingTwin(
    {
      ...PAGE,
      body: { value: [["p", {}, "See ", ["a", { href: "/docs/files/trash" }, "the trash"], "."]] },
    },
    { siteUrl: "https://trytree.house", appUrl: "https://app.example.com" },
  );

  it("stands on its own, dated and with its sources", () => {
    expect(twin).toMatch(/^# Keep Obsidian\n/);
    expect(twin).toContain("Last checked 30 October 2026.");
    expect(twin).toContain("- The first point.");
    expect(twin).toContain("[Pricing](https://obsidian.md/pricing)");
  });

  it("keeps table cells intact and makes links absolute", () => {
    expect(twin).toContain("| A \\| B | Yes | No |");
    expect(twin).toContain("[the trash](https://trytree.house/docs/files/trash)");
  });

  it("tags its signup links as coming from the twin", () => {
    expect(twin).toContain("utm_campaign=compare-obsidian&utm_content=twin");
  });
});

describe("landingLlmsSections", () => {
  it("groups pages by kind and links to their twins", () => {
    const [compare, guides] = landingLlmsSections([
      PAGE,
      { ...PAGE, path: "/guides/a-guide", kind: "guide" },
    ]);
    expect(compare?.title).toBe("Compare");
    expect(compare?.links[0]?.href).toBe("/compare/obsidian.md");
    expect(guides?.links[0]?.href).toBe("/guides/a-guide.md");
  });
});