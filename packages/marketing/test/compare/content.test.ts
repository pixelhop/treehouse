/**
 * Contract checks for comparison pages and guides (content/pages/**), per
 * .agent/docs/compare-pages.md. Most of what matters on these pages is what they
 * must not say, so the rules on claims live here rather than in a reviewer's head.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { docsPages, readDocsFiles } from "../../server/lib/docs-files";
import { landingPrerenderRoutes, readLandingFiles } from "../../server/lib/landing-files";

const files = readLandingFiles();
const docsPaths = new Set(docsPages(readDocsFiles()).map((file) => file.path));
const landingPaths = new Set(landingPrerenderRoutes(files));

/** Every string in a frontmatter value, skipping the competitor's table column. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => (key === "them" ? [] : strings(item)));
  }
  return [];
}

/** Frontmatter strings and body, one per line, without code, which can quote anything. */
function text(file: (typeof files)[number]): string {
  const body = file.body.replace(/^(`{3,})[\s\S]*?^\1\s*$/gm, "");
  return [...strings(file.frontmatter), body].join("\n");
}

/** Anchors as @nuxt/content generates them from a heading. */
function headingAnchors(body: string): Set<string> {
  return new Set(
    [...body.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((match) =>
      (match[1] ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-"),
    ),
  );
}

/**
 * Sentences about Treehouse must not make these claims. Each has a reason:
 * search and per-tier history are held back by the owner, encryption is at rest
 * only, and the trash retention period is still being confirmed. Update this list
 * when one of them changes.
 */
const BANNED_TREEHOUSE_CLAIMS: [string, RegExp][] = [
  ["zero-knowledge", /zero[- ]knowledge/i],
  ["search", /\b(semantic|full[- ]text|fuzzy) search|search (your|across|every)/i],
  ["history retention", /(history|retention).{0,40}\b(days|tier|plan)\b/i],
  ["trash retention", /trash.{0,60}\b(forever|indefinitely|days)\b/i],
];

describe("comparison pages and guides", () => {
  it("has the pages we link to from the site", () => {
    expect([...landingPaths].sort()).toEqual([
      "/compare",
      "/compare/fastio",
      "/compare/notion",
      "/compare/obsidian",
      "/guides/ai-second-brain-for-teams",
      "/guides/obsidian-and-claude-code-for-teams",
      "/guides/open-source-notion-alternatives",
      "/guides/self-hosted-obsidian-sync",
    ]);
  });

  describe.each(files.map((file) => [file.path, file] as const))("%s", (_path, file) => {
    const fm = file.frontmatter as Record<string, unknown>;

    it("has what search engines and AI answers need", () => {
      expect(String(fm.title).length).toBeGreaterThan(10);
      expect(String(fm.seoTitle).length).toBeLessThanOrEqual(75);
      expect(String(fm.description).length).toBeGreaterThanOrEqual(50);
      expect(String(fm.description).length).toBeLessThanOrEqual(160);
      expect(fm.kind === "comparison" || fm.kind === "guide").toBe(true);
    });

    it("shows the date its claims were checked", () => {
      const checked =
        fm.lastChecked instanceof Date ? fm.lastChecked.toISOString() : fm.lastChecked;
      expect(String(checked)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it("cites its sources", () => {
      const sources = fm.sources as { label: string; url: string }[];
      expect(sources.length).toBeGreaterThanOrEqual(5);
      for (const source of sources) expect(source.url).toMatch(/^https:\/\//);
    });

    it("has a signup call to action at the top and the end", () => {
      for (const cta of [fm.cta, fm.endCta] as Record<string, string>[]) {
        expect(cta.heading && cta.body && cta.label).toBeTruthy();
      }
      expect((fm.cta as Record<string, string>).note).toMatch(/Grove/);
    });

    it("says what the other product does better", () => {
      if (fm.kind === "comparison") expect(file.body).toMatch(/^## Where .+ better choice$/m);
    });

    it("uses no em dashes", () => {
      expect(text(file).includes("—")).toBe(false);
    });

    it("avoids words the voice guide rules out", () => {
      const banned =
        /\b(supercharge[sd]?|revolutioni[sz]e[sd]?|empower(s|ed|ing)?|leverag(e|es|ed|ing)|seamless(ly)?|game-changing|cutting-edge)\b/i;
      expect(text(file).match(banned)?.[0] ?? null).toBeNull();
    });

    it("makes no claim that isn't live", () => {
      const sentences = text(file).split(/(?<=[.!?:])\s+|\n/);
      const about = sentences.filter((sentence) => !/\b(Notion|Fastio|Obsidian)\b/.test(sentence));
      const broken = BANNED_TREEHOUSE_CLAIMS.flatMap(([name, pattern]) =>
        about.filter((sentence) => pattern.test(sentence)).map((line) => `${name}: ${line}`),
      );
      expect(broken).toEqual([]);
    });

    it("links only to pages and anchors that exist", () => {
      const links = [...file.body.matchAll(/(?<!!\[[^\]]*)\]\((\/[^)\s]+)\)/g)].map(
        (match) => match[1] ?? "",
      );
      const broken = links.filter((href) => {
        const [path = "", anchor] = href.split("#");
        if (!docsPaths.has(path) && !landingPaths.has(path)) return true;
        const target = files.find((other) => other.path === path);
        return Boolean(anchor && target && !headingAnchors(target.body).has(anchor));
      });
      expect(broken).toEqual([]);
    });

    it("embeds only images and videos that exist", () => {
      const media = [
        ...[...file.body.matchAll(/!\[[^\]]*\]\((\/[^)\s]+)\)/g)].map((match) => match[1] ?? ""),
        ...[...file.body.matchAll(/::demo-video\{([^}]*)\}/g)].flatMap((match) =>
          [...(match[1] ?? "").matchAll(/(?:src|poster)="([^"]+)"/g)].map((attr) => attr[1] ?? ""),
        ),
      ];
      const missing = media.filter(
        (src) => !existsSync(new URL(`../../public${src}`, import.meta.url)),
      );
      expect(missing).toEqual([]);
    });
  });
});