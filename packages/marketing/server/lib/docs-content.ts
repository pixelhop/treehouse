/**
 * Server-side docs collection access shared by the search index, llms.txt,
 * llms-docs.txt and the markdown twins. All of these run at prerender (Node,
 * where @nuxt/content's SQLite works); the Worker never queries content.
 */
import type { H3Event } from "h3";
import { queryCollection } from "@nuxt/content/server";
import { useRuntimeConfig } from "#imports";
import {
  DOCS_META_FIELDS,
  isIgnoredDocPath,
  normalizeDocsPath,
  type DocsPageMeta,
} from "../../app/utils/docs-tree";
import { LANDING_META_FIELDS, isLandingPath, type LandingPageMeta } from "../../app/utils/landing";
import { renderDocsTwin, type DocsTwinPage } from "../utils/docs-markdown";
import { renderLandingTwin } from "../utils/landing-markdown";

/** Metadata (no bodies) for every docs page, legacy `_` files excluded. */
export async function queryDocsMeta(event: H3Event): Promise<DocsPageMeta[]> {
  const rows = await queryCollection(event, "docs")
    .select(...DOCS_META_FIELDS)
    .all();
  return (rows as DocsPageMeta[]).filter((page) => page.path && !isIgnoredDocPath(page.path));
}

/** Metadata for every comparison page and guide, for `/llms.txt`. */
export async function queryLandingMeta(event: H3Event): Promise<LandingPageMeta[]> {
  const rows = await queryCollection(event, "pages")
    .select(...LANDING_META_FIELDS)
    .order("position", "ASC")
    .all();
  return rows as LandingPageMeta[];
}

/** The canonical site origin every twin and llms file links against. */
export function docsSiteUrl(event: H3Event): string {
  return useRuntimeConfig(event).public.siteUrl;
}

/**
 * Replacement for nuxt-ai-ready's `#ai-ready-virtual/content-lookup.mjs` (swapped
 * in by the inline module in nuxt.config). Same contract - return the page's
 * markdown or null to fall back to HTML conversion - but docs pages come back
 * fully flattened (no MDC residue) via `renderDocsTwin`.
 */
export async function lookupContentPage(event: H3Event, path: string) {
  const normalized = normalizeDocsPath(path);
  if (isLandingPath(normalized)) return lookupLandingPage(event, normalized);
  if (normalized !== "/docs" && !normalized.startsWith("/docs/")) return null;
  if (isIgnoredDocPath(normalized)) return null;

  const page = (await queryCollection(event, "docs")
    .path(normalized)
    .first()) as DocsTwinPage | null;
  if (!page) return null;

  const pages = await queryDocsMeta(event);
  return {
    markdown: renderDocsTwin(page, pages, { siteUrl: docsSiteUrl(event) }),
    title: page.title || "",
    description: page.description || "",
    updatedAt: page.updated || undefined,
  };
}

/** A comparison page or guide's twin; null (HTML conversion) for the hub. */
async function lookupLandingPage(event: H3Event, path: string) {
  const page = await queryCollection(event, "pages").path(path).first();
  if (!page) return null;
  const { appUrl } = useRuntimeConfig(event).public;
  const landing = { ...page, path } as unknown as Parameters<typeof renderLandingTwin>[0];
  return {
    markdown: renderLandingTwin(landing, { siteUrl: docsSiteUrl(event), appUrl }),
    title: landing.title,
    description: landing.description,
    updatedAt: landing.lastChecked,
  };
}