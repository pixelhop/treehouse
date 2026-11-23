/**
 * Build-time search index for the docs Cmd+K palette. The content work runs at
 * build under prerender (Node, where @nuxt/content's SQLite backing works), and
 * the result ships as a static JSON asset. The Cloudflare Worker has no content
 * DB at runtime, so the client fetches this file rather than querying content.
 *
 * Emitted to `.output/public/docs/search-index.json` via the prerender route
 * added in `nuxt.config.ts`. Only public pages are indexed (hubs included).
 *
 * `queryCollectionSearchSections` is imported explicitly from the server entry:
 * the global auto-import is ambiguous under typecheck (the client form drops
 * the `event` arg), so an explicit import pins the server signature.
 */
import { queryCollectionSearchSections } from "@nuxt/content/server";
import { isListedDoc, normalizeDocsPath } from "../../../app/utils/docs-tree";
import { queryDocsMeta } from "../../lib/docs-content";
import { docsSearchAliases, toDocsSearchEntries } from "../../utils/docs-search-index";

export default defineEventHandler(async (event) => {
  const [sections, pages] = await Promise.all([
    // Code samples bloat the per-section cap without helping anyone find a
    // page by what they're trying to do; `style` is the CSS Shiki injects for
    // highlighted code.
    queryCollectionSearchSections(event, "docs", { ignoredTags: ["pre", "style"] }),
    queryDocsMeta(event),
  ]);
  const listed = new Set(pages.filter(isListedDoc).map((page) => normalizeDocsPath(page.path)));

  setResponseHeader(event, "content-type", "application/json");

  return toDocsSearchEntries(sections, listed, docsSearchAliases(pages));
});