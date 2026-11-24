import { DOCS_META_FIELDS, isIgnoredDocPath, type DocsPageMeta } from "~/utils/docs-tree";

/**
 * Metadata (never bodies) for every docs page, shared by the docs layout
 * (sidebar) and the docs page (breadcrumbs, hub lists, prev/next, related).
 * One key, so the query runs once per render and lands once in the payload.
 * Runs at prerender; the Worker never queries content.
 */
export function useDocsIndex() {
  return useAsyncData(
    "docs.index",
    async () => {
      const rows = await queryCollection("docs")
        .select(...DOCS_META_FIELDS)
        .all();
      return (rows as DocsPageMeta[]).filter((page) => page.path && !isIgnoredDocPath(page.path));
    },
    { default: () => [] as DocsPageMeta[] },
  );
}

/**
 * SEO meta for a docs page. The docs layout's title template appends the docs
 * suffix, so `title` is `seoTitle || title`. Pages that aren't generally
 * available are noindexed.
 */
export function useDocsHead(page: {
  title: string;
  description?: string | null;
  updated?: string | null;
  path: string;
  noindex?: boolean;
}) {
  const { siteUrl } = useRuntimeConfig().public;
  const description = page.description || "";
  const canonical = `${siteUrl}${page.path}`;
  const meta = [
    { name: "description", content: description },
    { property: "og:title", content: page.title },
    { property: "og:description", content: description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: canonical },
    { property: "og:site_name", content: "Treehouse" },
  ];
  if (page.updated) {
    meta.push({ property: "article:modified_time", content: page.updated });
  }
  if (page.noindex) {
    meta.push({ name: "robots", content: "noindex" });
  }
  useHead({ title: page.title, meta, link: [{ rel: "canonical", href: canonical }] });
}