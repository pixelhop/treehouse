// Post-sanitize rewrite pass for rendered markdown: resolves relative image
// srcs to the API file URL and relative link hrefs to in-app routes. Runs on
// the DOMPurify-sanitized HTML (never before it), so it covers markdown syntax
// and raw HTML embedded in markdown identically, and the rewrite can't be used
// to smuggle anything past the sanitizer — it only swaps src/href values the
// resolver classified as workspace paths.
import { encodePath, resolveRef } from "shared";

export interface RefRewriteContext {
  /** Directory of the rendered document ("" at the workspace root). */
  docDir: string;
  /**
   * Builds the raw-bytes URL for a workspace path, or null when sibling files
   * aren't reachable (a single-file share) — then media is left as authored
   * rather than pointed at a path this source can't serve.
   */
  fileUrl: ((path: string) => string) | null;
  /**
   * URL of the page that displays another workspace file, or null when sibling
   * files aren't reachable (a single-file public share) — then links are left as
   * authored rather than pointed somewhere wrong. In the app this is
   * `appRouteFor` bound to the workspace; in a folder share it is the share's
   * own viewer route.
   */
  pageUrl: ((path: string) => string) | null;
  /**
   * Resolve a `[[wikilink]]` target to a workspace path, or null when it names
   * nothing the reader can see. Built from the reader's own file list (see
   * FileSource.paths). Absent where there is no list — then wikilinks render as
   * unresolved rather than being routed by guesswork.
   */
  resolveWikilink?: ((target: string) => string | null) | null;
}

/** In-app route for a workspace path (encoded — usable as a real href). */
export function appRouteFor(workspaceId: string, path: string): string {
  return path ? `/w/${workspaceId}/${encodePath(path)}` : `/w/${workspaceId}`;
}

/**
 * Rewrite src/href attributes in sanitized markdown HTML. `doc` defaults to the
 * browser document; tests pass a happy-dom document instead of configuring a
 * DOM test environment. With no DOM at all (SSR, should it ever be enabled),
 * the HTML is returned unrewritten — fail-soft, never a ReferenceError.
 */
export function rewriteMarkdownRefs(html: string, ctx: RefRewriteContext, doc?: Document): string {
  const d = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!d) return html;
  const template = d.createElement("template");
  template.innerHTML = html;

  for (const el of template.content.querySelectorAll("img[src], source[src]")) {
    const ref = resolveRef(ctx.docDir, el.getAttribute("src") ?? "");
    if (ref.kind === "workspace" && ctx.fileUrl) el.setAttribute("src", ctx.fileUrl(ref.path));
  }

  for (const a of template.content.querySelectorAll("a[href]")) {
    // Wikilinks resolve by NAME against the file list, not by relative path.
    if (a.hasAttribute("data-wikilink")) {
      rewriteWikilink(a, ctx);
      continue;
    }
    const ref = resolveRef(ctx.docDir, a.getAttribute("href") ?? "");
    if (ref.kind === "workspace" && ctx.pageUrl) {
      const hash = ref.fragment ? `#${ref.fragment}` : "";
      a.setAttribute("href", `${ctx.pageUrl(ref.path)}${hash}`);
    } else if (ref.kind === "workspace") {
      // A workspace file with nowhere to point it (a single-file share can't
      // reach siblings). Drop the href so it renders as plain text: a link that
      // looks live and goes nowhere is worse than no link at all.
      a.removeAttribute("href");
      a.setAttribute("title", "This file isn’t part of this share");
    } else if (ref.kind === "external") {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
    // fragment/unresolvable: leave untouched (native anchor / visibly broken).
  }

  wrapTables(template.content, d);

  return template.innerHTML;
}

/**
 * Resolve a wikilink anchor (`<a href="#" data-wikilink="target"
 * [data-wikilink-fragment]>`, from utils/wikilinks.ts) in place: route it to the
 * resolved file, or mark it visibly unresolved. The `data-*` markers are
 * stripped either way. Runs after DOMPurify, so the classes added here are ours.
 * A document can forge the markers with raw HTML; that only produces a link to a
 * file the reader can already open, the same as an ordinary markdown link.
 */
function rewriteWikilink(a: Element, ctx: RefRewriteContext): void {
  const target = a.getAttribute("data-wikilink") ?? "";
  const fragment = a.getAttribute("data-wikilink-fragment");
  a.removeAttribute("data-wikilink");
  a.removeAttribute("data-wikilink-fragment");

  const path = ctx.resolveWikilink?.(target) ?? null;
  if (path === null || !ctx.pageUrl) {
    // Unresolved, or nowhere to route it: inert and visibly distinct. Removing
    // href (rather than leaving "#") keeps a click from scrolling to the top.
    a.removeAttribute("href");
    a.setAttribute("aria-disabled", "true");
    a.setAttribute(
      "title",
      path === null ? `No file named “${target}”` : "This file isn’t part of this share",
    );
    a.classList.add("wikilink", "wikilink-unresolved");
    return;
  }
  const hash = fragment ? `#${fragment}` : "";
  a.setAttribute("href", `${ctx.pageUrl(path)}${hash}`);
  a.classList.add("wikilink");
}

/**
 * Give every table its own horizontal scroll container.
 *
 * A markdown table is as wide as its content demands, which on a phone is
 * routinely wider than the screen. Left alone it overflowed the reading column
 * and dragged the whole document sideways with it. The wrapper scrolls instead,
 * so a wide table stays a wide table and the prose around it stays put.
 *
 * Wrapping (rather than `display: block` on the table) keeps the table's own
 * layout algorithm, which is what sizes the columns.
 */
function wrapTables(root: DocumentFragment, d: Document) {
  for (const table of root.querySelectorAll("table")) {
    // Idempotent: re-rendering the same HTML must not nest wrappers.
    if (table.parentElement?.classList.contains("table-scroll")) continue;
    const wrap = d.createElement("div");
    wrap.className = "table-scroll";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

/**
 * Delegated click handler for rendered markdown: SPA-navigate plain left-clicks
 * on internal links, preserving native behavior for modified/middle clicks and
 * external/fragment links. Returns the in-app href to navigate to, or null.
 */
export function internalLinkTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  const href = a?.getAttribute("href") ?? "";
  // Only the two route shapes the rewrite above produces: a workspace file page
  // and a public share's viewer. Matching on the prefix (rather than a marker
  // attribute the document could forge) keeps an authored `javascript:` href
  // from ever reaching navigateTo.
  return href.startsWith("/w/") || href.startsWith("/s/") ? href : null;
}