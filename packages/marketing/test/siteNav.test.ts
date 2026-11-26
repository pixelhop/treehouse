import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { readLandingFiles } from "../server/lib/landing-files";
import { FOOTER_PRODUCT, isNavGroup, SITE_NAV, type SiteNavLink } from "../app/utils/siteNav";

const homepage = readFileSync(
  fileURLToPath(new URL("../app/pages/index.vue", import.meta.url)),
  "utf8",
);

const allLinks = (): SiteNavLink[] =>
  SITE_NAV.flatMap((entry) =>
    isNavGroup(entry) ? [...entry.links, ...(entry.footer ? [entry.footer] : [])] : [entry],
  );

describe("SITE_NAV", () => {
  it("keeps the header to four entries", () => {
    expect(SITE_NAV.map((entry) => entry.label)).toEqual(["Product", "Compare", "Pricing", "Docs"]);
  });

  it("points every section link at a section the homepage has", () => {
    const anchors = allLinks()
      .map((link) => link.to)
      .filter((to) => to.startsWith("/#"));
    expect(anchors.length).toBeGreaterThan(0);
    for (const to of anchors) expect(homepage).toContain(`id="${to.slice(2)}"`);
  });

  it("points every comparison link at a page that exists", () => {
    const pages = new Set(["/compare", ...readLandingFiles().map((file) => file.path)]);
    const links = allLinks()
      .map((link) => link.to)
      .filter((to) => to.startsWith("/compare") || to.startsWith("/guides"));
    expect(links.length).toBeGreaterThan(0);
    for (const to of links) expect(pages).toContain(to);
  });

  it("links to the open-source section", () => {
    expect(allLinks().map((link) => link.label)).toContain("Open source");
  });
});

describe("FOOTER_PRODUCT", () => {
  it("lists the product sections and pricing", () => {
    expect(FOOTER_PRODUCT.map((link) => link.label)).toEqual([
      "How it works",
      "Features",
      "Sharing",
      "For agents",
      "Second brain",
      "Pricing",
      "Open source",
    ]);
  });
});