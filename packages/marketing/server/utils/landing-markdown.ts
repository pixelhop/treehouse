/**
 * Markdown twins for comparison pages and guides (`/compare/<slug>.md`). AI
 * answers are a real discovery channel for these pages, and an agent reading a
 * twin gets the same page a person does: the short answer, the table, the long
 * version, the sources and the date, with signup links tagged as `twin`.
 *
 * Pure - no Nuxt auto-imports - so it unit-tests in plain Vitest.
 */
import {
  formatCheckedDate,
  signupHref,
  type LandingPage,
  type LandingPageMeta,
} from "../../app/utils/landing";
import type { LlmsSection } from "./docs-llms";
import { docsTwinPath } from "./docs-llms";
import { minimarkToMarkdown, type MinimarkBody } from "./docs-markdown";

export interface LandingTwinContext {
  siteUrl: string;
  appUrl: string;
}

const cell = (text: string) => text.replace(/\|/g, "\\|");

export function renderLandingTwin(
  page: LandingPage & { body?: MinimarkBody | null },
  ctx: LandingTwinContext,
): string {
  const siteUrl = ctx.siteUrl.replace(/\/+$/, "");
  const signup = signupHref(ctx.appUrl, page.path, "twin");
  const blocks: string[] = [`# ${page.title}`, page.description];

  blocks.push(`Last checked ${formatCheckedDate(page.lastChecked)}.`);
  blocks.push(`[${page.cta.heading}](${signup}). ${page.cta.body}`);
  if (page.cta.note) blocks.push(page.cta.note);

  blocks.push(["## The short answer", "", ...page.summary.map((line) => `- ${line}`)].join("\n"));

  if (page.comparison?.length) {
    blocks.push(
      [
        "## At a glance",
        "",
        `| | Treehouse | ${page.competitor} |`,
        "| --- | --- | --- |",
        ...page.comparison.map(
          (row) => `| ${cell(row.label)} | ${cell(row.treehouse)} | ${cell(row.them)} |`,
        ),
      ].join("\n"),
    );
  }

  const body = minimarkToMarkdown(page.body, { siteUrl, pageUrl: `${siteUrl}${page.path}` });
  if (body) blocks.push(body);

  if (page.faq?.length) {
    blocks.push(
      [
        "## Questions people ask",
        ...page.faq.map((item) => `\n### ${item.question}\n\n${item.answer}`),
      ].join("\n"),
    );
  }

  if (page.sources?.length) {
    blocks.push(
      [
        "## Sources",
        "",
        ...page.sources.map((source) => `- [${source.label}](${source.url})`),
      ].join("\n"),
    );
  }

  blocks.push(`[${page.endCta.label}](${signup})`);
  return `${blocks.join("\n\n")}\n`;
}

/** The comparison and guide sections of `/llms.txt`. */
export function landingLlmsSections(pages: LandingPageMeta[]): LlmsSection[] {
  const section = (title: string, kind: LandingPageMeta["kind"]): LlmsSection => ({
    title,
    links: pages
      .filter((page) => page.kind === kind)
      .map((page) => ({
        title: page.title,
        href: docsTwinPath(page.path),
        description: page.description,
      })),
  });
  return [section("Compare", "comparison"), section("Guides", "guide")];
}