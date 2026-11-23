/**
 * `/llms-docs.txt`: every public docs page in full, as flattened markdown, in
 * sidebar reading order - the whole manual in one fetch for an agent that
 * wants to learn the product.
 *
 * Prerendered (nitro.prerender.routes); runs at build in Node where the content
 * database is available. Early-access and unreleased pages are left out.
 */
import { queryCollection } from "@nuxt/content/server";
import { buildDocsTree, flattenDocsTree, normalizeDocsPath } from "../../app/utils/docs-tree";
import { docsSiteUrl, queryDocsMeta } from "../lib/docs-content";
import { buildLlmsDocs } from "../utils/docs-llms";
import { renderDocsTwin, type DocsTwinPage } from "../utils/docs-markdown";
import { DOCS_SITE_DESCRIPTION } from "../utils/docs-site";

export default defineEventHandler(async (event) => {
  const [meta, full] = await Promise.all([
    queryDocsMeta(event),
    queryCollection(event, "docs").all() as Promise<DocsTwinPage[]>,
  ]);
  const byPath = new Map(full.map((page) => [normalizeDocsPath(page.path), page]));
  const siteUrl = docsSiteUrl(event);

  const pages = flattenDocsTree(buildDocsTree(meta)).flatMap((node) => {
    const page = byPath.get(node.path);
    return page ? [{ path: node.path, markdown: renderDocsTwin(page, meta, { siteUrl }) }] : [];
  });

  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  return buildLlmsDocs(
    { title: "Treehouse", description: DOCS_SITE_DESCRIPTION, url: siteUrl },
    pages,
  );
});