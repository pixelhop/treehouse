/**
 * Pure builders for the agent-facing docs indexes.
 *
 * - `/llms.txt`: a curated, spec-shaped index - H1 + summary blockquote, then
 *   `## Section` groups of `- [title](absolute url): description` links. Docs
 *   are grouped by their top-level docs section in sidebar order, public pages
 *   only, each linking to its markdown twin.
 * - `/llms-docs.txt`: every public docs page in full (markdown twins
 *   concatenated in reading order), docs only - unlike nuxt-ai-ready's
 *   `/llms-full.txt`, which is the whole site.
 *
 * Kept pure (no Nuxt auto-imports) so they unit-test in plain Vitest. Served by
 * server/middleware/llms-txt.ts and server/routes/llms-docs.txt.get.ts.
 */
import { buildDocsTree, flattenDocsTree, type DocsPageMeta } from "../../app/utils/docs-tree";

export interface LlmsSiteMeta {
  title: string;
  description?: string;
  /** Canonical origin, e.g. `https://trytree.house`. */
  url?: string;
  /**
   * Free-form markdown after the summary (the llms.txt spec allows prose
   * before the first section): the facts an agent needs before reading on.
   */
  details?: string;
}

export interface LlmsLink {
  title: string;
  /** Absolute URL, or a root-relative path made absolute against the site URL. */
  href: string;
  description?: string;
}

export interface LlmsSection {
  title: string;
  links: LlmsLink[];
}

/** The markdown twin path of a docs page (`/docs/a/b` -> `/docs/a/b.md`). */
export function docsTwinPath(path: string): string {
  return `${path.replace(/\/+$/, "")}.md`;
}

/**
 * One llms.txt section per top-level docs section, in sidebar order. Each
 * section lists its hub first, then its pages (a nested sub-section's hub is
 * followed by its own pages). Only public pages are included - the tree drops
 * early-access and unreleased ones.
 */
export function docsLlmsSections(pages: DocsPageMeta[]): LlmsSection[] {
  const root = buildDocsTree(pages);
  return root.children.map((section) => ({
    title: section.title,
    links: flattenDocsTree(section).map((node) => ({
      title: node.title,
      href: docsTwinPath(node.path),
      description: node.description,
    })),
  }));
}

function absolute(href: string, origin?: string): string {
  if (!origin || !href.startsWith("/") || href.startsWith("//")) return href;
  return `${origin.replace(/\/+$/, "")}${href}`;
}

function renderLink(link: LlmsLink, origin?: string): string {
  const desc = link.description ? `: ${link.description}` : "";
  return `- [${link.title}](${absolute(link.href, origin)})${desc}`;
}

/**
 * Assemble the llms.txt document: site header, then each section (docs
 * sections first, curated extras after). Empty sections are dropped; every link
 * is absolute.
 */
export function buildLlmsIndex(site: LlmsSiteMeta, sections: LlmsSection[]): string {
  const parts: string[] = [`# ${site.title}`];
  if (site.description) parts.push(`> ${site.description}`);
  if (site.url) parts.push(`Canonical Origin: ${site.url}`);
  if (site.details) parts.push(site.details.trim());

  for (const section of sections) {
    if (!section.links.length) continue;
    parts.push(`## ${section.title}`);
    parts.push(section.links.map((link) => renderLink(link, site.url)).join("\n"));
  }

  // Blank line between every block; single trailing newline.
  return `${parts.join("\n\n")}\n`;
}

/**
 * `/llms-docs.txt`: a short header, then each rendered page twin (already a
 * self-contained markdown document starting with its H1) with its source URL,
 * separated by horizontal rules.
 */
export function buildLlmsDocs(
  site: LlmsSiteMeta,
  pages: { path: string; markdown: string }[],
): string {
  const origin = site.url?.replace(/\/+$/, "") ?? "";
  const header = [
    `# ${site.title} documentation`,
    site.description ? `> ${site.description}` : "",
    `Every public page of ${origin}/docs in full, in reading order. Each page is also available on its own as markdown by adding \`.md\` to its URL.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const body = pages.map((page) => `Source: ${origin}${page.path}\n\n${page.markdown.trim()}`);
  return `${[header, ...body].join("\n\n---\n\n")}\n`;
}