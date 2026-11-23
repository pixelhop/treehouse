import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { readLandingFiles } from "../server/lib/landing-files";
import { footerProductFor, isNavGroup, siteNavFor, type SiteNavLink } from "../app/utils/siteNav";

const homepage = readFileSync(
  fileURLToPath(new URL("../app/pages/index.vue", import.meta.url)),
  "utf8",
);

const allLinks = (path: string): SiteNavLink[] =>
  siteNavFor(path).flatMap((entry) =>
    isNavGroup(entry) ? [...entry.links, ...(entry.footer ? [entry.footer] : [])] : [entry],
  );

describe("siteNavFor", () => {
  it("keeps the header to four entries", () => {
    expect(siteNavFor("/").map((entry) => entry.label)).toEqual([
      "Product",
      "Compare",
      "Pricing",
      "Docs",
    ]);
  });

  it("points every section link at a section the homepage has", () => {
    const anchors = allLinks("/")
      .map((link) => link.to)
      .filter((to) => to.startsWith("/#"));
    expect(anchors.length).toBeGreaterThan(0);
    for (const to of anchors) expect(homepage).toContain(`id="${to.slice(2)}"`);
  });

  it("points every comparison link at a page that exists", () => {
    const pages = new Set(["/compare", ...readLandingFiles().map((file) => file.path)]);
    const links = allLinks("/")
      .map((link) => link.to)
      .filter((to) => to.startsWith("/compare") || to.startsWith("/guides"));
    expect(links.length).toBeGreaterThan(0);
    for (const to of links) expect(pages).toContain(to);
  });

  it("makes no open-source claim on comparison pages and guides", () => {
    for (const path of ["/compare", "/compare/obsidian", "/guides/a-guide"]) {
      expect(allLinks(path).map((link) => link.label)).not.toContain("Open source");
      expect(footerProductFor(path).map((link) => link.label)).not.toContain("Open source");
    }
    expect(allLinks("/").map((link) => link.label)).toContain("Open source");
  });
});

describe("footerProductFor", () => {
  it("lists the product sections and pricing", () => {
    expect(footerProductFor("/").map((link) => link.label)).toEqual([
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