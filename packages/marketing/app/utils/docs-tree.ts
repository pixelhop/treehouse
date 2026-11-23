/**
 * The public docs tree: nested URLs, hubs, ordering, release stages.
 *
 * `content/docs/<section>/<page>.md` is served at `/docs/<section>/<page>`, and a
 * folder's `index.md` is its hub at the folder URL (see
 * `.agent/docs/public-docs.md`). Everything that needs the tree - the sidebar,
 * hub child lists, breadcrumbs, prev/next, the search index, llms.txt, the
 * sitemap - derives it from page paths + frontmatter through these helpers, so
 * they can never disagree about order or visibility.
 *
 * Pure (no Nuxt auto-imports, no Node APIs): imported by the app, by Nitro
 * server code, by nuxt.config and by the docs content tests.
 */

export const DOCS_ROOT = "/docs";

export const DOCS_RELEASES = ["public", "early-access", "unreleased"] as const;
export type DocsRelease = (typeof DOCS_RELEASES)[number];

export const DOCS_PAGE_TYPES = ["hub", "concept", "guide", "how-to", "reference"] as const;
export type DocsPageType = (typeof DOCS_PAGE_TYPES)[number];

// Plan tiers as named in the app (see packages/api/server/utils/plans.ts).
export const DOCS_PLANS = ["seedling", "grove", "forest"] as const;

/** The frontmatter fields every tree consumer selects (never the body). */
export const DOCS_META_FIELDS = [
  "path",
  "title",
  "navTitle",
  "seoTitle",
  "description",
  "type",
  "position",
  "updated",
  "release",
  "related",
  "plans",
] as const;

/** Page metadata as stored in the `docs` collection (optional fields may be null). */
export interface DocsPageMeta {
  path: string;
  title?: string | null;
  navTitle?: string | null;
  seoTitle?: string | null;
  description?: string | null;
  type?: string | null;
  position?: number | null;
  updated?: string | null;
  release?: string | null;
  related?: string[] | null;
  plans?: string[] | null;
}

export interface DocsTreeNode {
  path: string;
  title: string;
  /** Sidebar label: `navTitle || title`. */
  label: string;
  description: string;
  position: number;
  /** A folder `index.md` (type hub, or anything with child pages). */
  isHub: boolean;
  children: DocsTreeNode[];
}

export interface DocsLink {
  path: string;
  title: string;
  description: string;
}

/**
 * Canonical form of a docs path: no query/hash, no trailing slash, no `.md`
 * suffix. `/docs/` -> `/docs`, `/docs/knowledge/` -> `/docs/knowledge`.
 */
export function normalizeDocsPath(path: string): string {
  const bare = (path.split(/[?#]/)[0] || "").replace(/\.md$/, "");
  const trimmed = bare.replace(/\/+$/, "");
  return trimmed || "/";
}

/** `/docs/a/b` -> `/docs/a`, `/docs/a` -> `/docs`, `/docs` -> null. */
export function docsParentPath(path: string): string | null {
  const normalized = normalizeDocsPath(path);
  if (normalized === DOCS_ROOT || !normalized.startsWith(`${DOCS_ROOT}/`)) {
    return null;
  }
  return normalized.slice(0, normalized.lastIndexOf("/")) || null;
}

/** The release stage, defaulting to `public` like the collection schema. */
export function docsRelease(page: Pick<DocsPageMeta, "release">): DocsRelease {
  const release = page.release as DocsRelease | null | undefined;
  return release && DOCS_RELEASES.includes(release) ? release : "public";
}

/**
 * Listed pages appear in the sidebar, hub lists, search, sitemap and llms.txt.
 * Early-access and unreleased pages are built but never listed.
 */
export function isListedDoc(page: Pick<DocsPageMeta, "release">): boolean {
  return docsRelease(page) === "public";
}

/**
 * Legacy/private files (`_index.md`, `_partials/...`) are not pages. Content v3
 * still creates entries for them, so filter them out everywhere.
 */
export function isIgnoredDocPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("_"));
}

export function docsLabel(page: Pick<DocsPageMeta, "navTitle" | "title">) {
  return page.navTitle || page.title || "";
}

function byPosition(a: DocsTreeNode, b: DocsTreeNode) {
  return a.position - b.position || a.title.localeCompare(b.title);
}

function toNode(page: DocsPageMeta): DocsTreeNode {
  return {
    path: normalizeDocsPath(page.path),
    title: page.title || "",
    label: docsLabel(page),
    description: page.description || "",
    position: page.position ?? Number.MAX_SAFE_INTEGER,
    isHub: page.type === "hub",
    children: [],
  };
}

/**
 * Build the listed docs tree rooted at `/docs`. Only public pages are included;
 * a page whose parent hub is missing or not listed is dropped (the content
 * tests require every folder to have a public `index.md`). Children are ordered
 * by `position`, then title.
 */
export function buildDocsTree(pages: DocsPageMeta[]): DocsTreeNode {
  const nodes = new Map<string, DocsTreeNode>();
  for (const page of pages) {
    const path = normalizeDocsPath(page.path);
    if (!path.startsWith(DOCS_ROOT) || isIgnoredDocPath(path)) continue;
    if (!isListedDoc(page)) continue;
    nodes.set(path, toNode(page));
  }

  const root = nodes.get(DOCS_ROOT) ?? {
    path: DOCS_ROOT,
    title: "Docs",
    label: "Docs",
    description: "",
    position: 0,
    isHub: true,
    children: [],
  };
  root.isHub = true;

  for (const node of nodes.values()) {
    if (node.path === DOCS_ROOT) continue;
    const parentPath = docsParentPath(node.path);
    const parent = parentPath === DOCS_ROOT ? root : parentPath && nodes.get(parentPath);
    if (!parent) continue;
    parent.children.push(node);
    parent.isHub = true;
  }

  const sort = (node: DocsTreeNode) => {
    node.children.sort(byPosition);
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Depth-first reading order of the tree, starting with the root. */
export function flattenDocsTree(root: DocsTreeNode): DocsTreeNode[] {
  const out: DocsTreeNode[] = [];
  const walk = (node: DocsTreeNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function findDocsNode(root: DocsTreeNode, path: string): DocsTreeNode | undefined {
  const target = normalizeDocsPath(path);
  return flattenDocsTree(root).find((node) => node.path === target);
}

/** The top-level section a path belongs to (`/docs/channels/website/x` -> `/docs/channels`). */
export function docsSectionPath(path: string): string | null {
  const parts = normalizeDocsPath(path).split("/").filter(Boolean);
  return parts.length >= 2 ? `/${parts[0]}/${parts[1]}` : null;
}

/**
 * Areas split the docs into separately navigated halves, each with its own
 * sidebar, reading order and breadcrumb root: "Docs" for people using a
 * workspace and "Agents" for everything an agent (or the person connecting
 * one) needs - connecting, the agent handbook and the API reference. A page's
 * area follows from its top-level section folder; URLs don't change.
 * `sections: "rest"` claims every section no other area lists (so a new
 * section lands in Docs without touching this list). The playbooks stay in
 * Docs on purpose: they're written for the person shaping a workspace.
 */
export interface DocsArea {
  key: string;
  title: string;
  /** The area's landing page (its sidebar root and first breadcrumb). */
  home: string;
  /** Top-level section folders in this area, or "rest" for the default area. */
  sections: readonly string[] | "rest";
}

export const DOCS_AREAS: readonly DocsArea[] = [
  { key: "docs", title: "Docs", home: DOCS_ROOT, sections: "rest" },
  {
    key: "agents",
    title: "Agents",
    home: `${DOCS_ROOT}/agents`,
    sections: ["agents"],
  },
];

const DEFAULT_DOCS_AREA = DOCS_AREAS.find((area) => area.sections === "rest")!;

/** The area a docs path belongs to. `/docs` itself (and anything unknown) is Docs. */
export function docsAreaForPath(path: string): DocsArea {
  const section = docsSectionPath(path)?.split("/")[2];
  return (
    (section &&
      DOCS_AREAS.find((area) => area.sections !== "rest" && area.sections.includes(section))) ||
    DEFAULT_DOCS_AREA
  );
}

/**
 * The part of the tree an area's sidebar and prev/next walk. The default area
 * keeps the `/docs` root with only its own sections; an area whose home is a
 * section hub is rooted at that hub. Falls back to an empty root when the hub
 * isn't listed.
 */
export function docsAreaTree(root: DocsTreeNode, area: DocsArea): DocsTreeNode {
  if (area.home === DOCS_ROOT) {
    return {
      ...root,
      children: root.children.filter((section) => docsAreaForPath(section.path).key === area.key),
    };
  }
  const home = findDocsNode(root, area.home);
  if (home) return home;
  return {
    path: area.home,
    title: area.title,
    label: area.title,
    description: "",
    position: 0,
    isHub: true,
    children: [],
  };
}

/**
 * Previous/next pages in reading order. A page that is not listed (early
 * access) has no neighbours - it is reached by direct link only.
 */
export function docsPrevNext(
  order: DocsTreeNode[],
  path: string,
): { prev: DocsTreeNode | null; next: DocsTreeNode | null } {
  const target = normalizeDocsPath(path);
  const index = order.findIndex((node) => node.path === target);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: order[index - 1] ?? null,
    next: order[index + 1] ?? null,
  };
}

export interface DocsBreadcrumb {
  name: string;
  url: string;
}

/**
 * Breadcrumb trail from the page's area home to `path` (inclusive): "Docs /
 * Channels / ..." in the Docs area, "Agents / Connect / ..." in the Agents area
 * (never "Docs / Agents / ..."). Ancestors are resolved from `pages`
 * regardless of release stage so an early-access page still shows its real
 * location.
 */
export function docsBreadcrumbs(pages: DocsPageMeta[], path: string): DocsBreadcrumb[] {
  const byPath = new Map(pages.map((page) => [normalizeDocsPath(page.path), page]));
  const trail: DocsBreadcrumb[] = [];
  let current: string | null = normalizeDocsPath(path);
  while (current) {
    const page = byPath.get(current);
    trail.unshift({
      name: page ? docsLabel(page) || "Docs" : current === DOCS_ROOT ? "Docs" : current,
      url: current,
    });
    current = docsParentPath(current);
  }
  const area = docsAreaForPath(path);
  const start = trail.findIndex((crumb) => crumb.url === area.home);
  const areaTrail = start > 0 ? trail.slice(start) : trail;
  if (areaTrail[0]?.url === area.home) areaTrail[0].name = area.title;
  return areaTrail;
}

/**
 * Resolve `related` frontmatter paths to titled links. Paths that don't exist
 * (or are ignored files) are skipped rather than rendered as dead links.
 */
export function resolveRelatedDocs(
  pages: DocsPageMeta[],
  related: string[] | null | undefined,
): DocsLink[] {
  if (!related?.length) return [];
  const byPath = new Map(pages.map((page) => [normalizeDocsPath(page.path), page]));
  const links: DocsLink[] = [];
  for (const raw of related) {
    const page = byPath.get(normalizeDocsPath(raw));
    if (!page || isIgnoredDocPath(page.path)) continue;
    links.push({
      path: normalizeDocsPath(page.path),
      title: page.title || "",
      description: page.description || "",
    });
  }
  return links;
}

/** `<seoTitle || title> - Treehouse Docs`, the single docs title format. */
export const DOCS_TITLE_SUFFIX = " - Treehouse Docs";

export function docsDocumentTitle(page: Pick<DocsPageMeta, "seoTitle" | "title">): string {
  return page.seoTitle || page.title || "";
}

/** A heading in a page's "On this page" list (h2 with its h3 children). */
export interface DocsTocHeading {
  id: string;
  title: string;
  children: DocsTocHeading[];
}

/** Every heading id in reading order: each heading, then its children. */
export function docsTocIds(headings: readonly DocsTocHeading[]): string[] {
  return headings.flatMap((heading) => [heading.id, ...heading.children.map((child) => child.id)]);
}

/**
 * Scroll-spy for "On this page": the last heading whose top has scrolled to
 * within `offset` px of the viewport top (the sticky header), else the first.
 * `topOf` gives a heading's viewport top, or null when it isn't in the page.
 */
export function activeTocId(
  ids: readonly string[],
  topOf: (id: string) => number | null,
  offset: number,
): string {
  let current = ids[0] ?? "";
  for (const id of ids) {
    const top = topOf(id);
    if (top === null) continue;
    if (top - offset > 0) break;
    current = id;
  }
  return current;
}

interface ContentTocLink {
  id: string;
  text: string;
  children?: ContentTocLink[];
}

/** Map @nuxt/content's `body.toc.links` to the TOC heading shape. */
export function docsTocHeadings(links: ContentTocLink[] | null | undefined): DocsTocHeading[] {
  return (links ?? []).map((link) => ({
    id: link.id,
    title: link.text,
    children: docsTocHeadings(link.children),
  }));
}