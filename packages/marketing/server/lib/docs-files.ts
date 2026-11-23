/**
 * Build-time view of the docs markdown on disk (`content/docs/**`).
 *
 * Docs are prerender-only (@nuxt/content is not queryable on the Worker), so the
 * route list, sitemap entries and unreleased-page exclusion must be known when
 * nuxt.config / content.config are evaluated - before the content database
 * exists. This reads the files and their frontmatter directly. The docs content
 * tests use the same reader, so what they validate is what gets built.
 *
 * Node-only: imported by nuxt.config.ts, content.config.ts and tests, never by
 * app or server runtime code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  DOCS_ROOT,
  docsRelease,
  isIgnoredDocPath,
  isListedDoc,
  type DocsPageMeta,
} from "../../app/utils/docs-tree";

export const DOCS_CONTENT_DIR = fileURLToPath(new URL("../../content/docs", import.meta.url));

export interface DocsFile {
  /** Absolute file path. */
  file: string;
  /** Path relative to `content/docs`, POSIX separators (`knowledge/index.md`). */
  relativePath: string;
  /** Served URL path (`/docs/knowledge`). */
  path: string;
  frontmatter: Record<string, unknown>;
  /** Markdown after the frontmatter block. */
  body: string;
}

/** `knowledge/index.md` -> `/docs/knowledge`, `index.md` -> `/docs`. */
export function docsPathFromFile(relativePath: string): string {
  const withoutExt = relativePath.replace(/\\/g, "/").replace(/\.md$/, "");
  const segments = withoutExt.split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index") segments.pop();
  return segments.length ? `${DOCS_ROOT}/${segments.join("/")}` : DOCS_ROOT;
}

/** Split a markdown source into parsed YAML frontmatter and body. */
function splitFrontmatter(source: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const parsed = parseYaml(match[1] ?? "") as unknown;
  return {
    data:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: source.slice(match[0].length),
  };
}

/** Every `.md` file under the docs content dir, with frontmatter. */
export function readDocsFiles(dir: string = DOCS_CONTENT_DIR): DocsFile[] {
  const files: DocsFile[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // content/docs absent - nothing to read.
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const relativePath = relative(dir, full).split(sep).join("/");
        const { data, body } = splitFrontmatter(readFileSync(full, "utf8"));
        files.push({
          file: full,
          relativePath,
          path: docsPathFromFile(relativePath),
          frontmatter: data,
          body,
        });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Frontmatter as the typed page metadata the tree helpers take. */
export function docsFileMeta(file: DocsFile): DocsPageMeta {
  const fm = file.frontmatter;
  const str = (key: string) => (typeof fm[key] === "string" ? (fm[key] as string) : undefined);
  const list = (key: string) =>
    Array.isArray(fm[key]) ? (fm[key] as unknown[]).map(String) : undefined;
  return {
    path: file.path,
    title: str("title"),
    navTitle: str("navTitle"),
    seoTitle: str("seoTitle"),
    description: str("description"),
    type: str("type"),
    position: typeof fm.position === "number" ? fm.position : undefined,
    updated: fm.updated instanceof Date ? fm.updated.toISOString().slice(0, 10) : str("updated"),
    release: str("release"),
    related: list("related"),
    plans: list("plans"),
  };
}

/**
 * Unreleased pages are built in dev and preview builds only. Production is the
 * `main` branch on Workers Builds (see wrangler.jsonc), which sets
 * `WORKERS_CI_BRANCH`.
 */
export function docsIncludeUnreleased(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.WORKERS_CI_BRANCH !== "main";
}

/** Real docs pages (legacy `_index.md` / `_partials` excluded). */
export function docsPages(files: DocsFile[] = readDocsFiles()): DocsFile[] {
  return files.filter((file) => !isIgnoredDocPath(file.path));
}

/**
 * Routes to prerender: every page (hubs and `/docs` included), minus unreleased
 * pages when they are excluded from this build.
 */
export function docsPrerenderRoutes(
  files: DocsFile[] = readDocsFiles(),
  includeUnreleased = docsIncludeUnreleased(),
): string[] {
  return docsPages(files)
    .filter((file) => includeUnreleased || docsRelease(docsFileMeta(file)) !== "unreleased")
    .map((file) => file.path);
}

/** Sitemap entries: public pages only, `lastmod` from `updated`. */
export function docsSitemapEntries(
  files: DocsFile[] = readDocsFiles(),
): { loc: string; lastmod?: string }[] {
  return docsPages(files)
    .map(docsFileMeta)
    .filter(isListedDoc)
    .map((page) => (page.updated ? { loc: page.path, lastmod: page.updated } : { loc: page.path }));
}

/**
 * Collection `source.exclude` globs (relative to `content/`) that keep
 * unreleased pages out of the content database entirely in production builds,
 * so they can't leak into the search index, llms files, twins or the sitemap.
 */
export function docsContentExcludes(
  files: DocsFile[] = readDocsFiles(),
  includeUnreleased = docsIncludeUnreleased(),
): string[] {
  if (includeUnreleased) return [];
  return files
    .filter((file) => docsRelease(docsFileMeta(file)) === "unreleased")
    .map((file) => `docs/${file.relativePath}`);
}