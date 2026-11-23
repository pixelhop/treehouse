import type { DocsSearchEntry } from "../../app/utils/docs-search";
import { isIgnoredDocPath, normalizeDocsPath } from "../../app/utils/docs-tree";

export interface DocsSearchSection {
  id: string;
  title: string;
  titles: string[];
  content: string;
  level?: number;
}

// Cap per-section content so the shipped index stays reasonable. Sections are
// a heading plus everything up to the next heading; 1000 chars keeps most of a
// how-to step list or settings table matchable (300 cut answers off
// mid-sentence), while the whole index stays in the low hundreds of KB.
export const DOCS_SEARCH_CONTENT_CAP = 1000;

/**
 * Shape the output of `queryCollectionSearchSections` into the static search
 * index. Pure (no Nuxt auto-imports) so it is unit-testable in plain Vitest and
 * reusable by the findability tests.
 *
 * Section ids are `<page path>#<heading id>` and pages are served at their
 * content path (nested URLs, hubs at the folder URL), so the id *is* the URL.
 * Only pages in `listedPaths` are kept: early-access and unreleased pages never
 * appear in search. Legacy `_` files are dropped. `aliases` (see
 * `docsSearchAliases`) are attached to each page's top-level entry.
 */
export function toDocsSearchEntries(
  sections: DocsSearchSection[],
  listedPaths?: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string[]>,
): DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = [];
  for (const section of sections) {
    const [rawPath = "", anchor] = section.id.split("#");
    const path = normalizeDocsPath(rawPath);
    if (!path.startsWith("/docs") || isIgnoredDocPath(path)) continue;
    if (listedPaths && !listedPaths.has(path)) continue;

    const pageAliases = anchor ? undefined : aliases?.get(path);
    entries.push({
      url: anchor ? `${path}#${anchor}` : path,
      title: section.title,
      titles: section.titles,
      content: (section.content || "").slice(0, DOCS_SEARCH_CONTENT_CAP),
      ...(pageAliases?.length ? { aliases: pageAliases } : {}),
    });
  }
  return entries;
}

/**
 * A page's alternative names for search: `navTitle` and `seoTitle` when they
 * differ from the title. Keyed by page path.
 */
export function docsSearchAliases(
  pages: {
    path: string;
    title?: string | null;
    navTitle?: string | null;
    seoTitle?: string | null;
  }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const page of pages) {
    const names = [page.navTitle, page.seoTitle].filter(
      (name): name is string => Boolean(name) && name !== page.title,
    );
    if (names.length) out.set(normalizeDocsPath(page.path), names);
  }
  return out;
}