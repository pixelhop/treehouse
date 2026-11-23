// Post-sanitize rewrite pass for HTML files rendered in the preview iframe —
// the counterpart to `rewriteMarkdownRefs`, with one extra problem to solve.
//
// The preview is a `srcdoc` iframe, and a srcdoc document inherits its base URL
// from the parent page. That parent is the app route for the file being viewed
// (`/w/<id>/reports/dash.html`), so a relative `href="other.html"` resolves to
// ANOTHER APP ROUTE and the frame navigates itself there. The SPA can't boot
// under this sandbox (no `allow-scripts`), so the frame renders blank — the same
// goes for `href="#section"`, which reloads the frame with the app page inside
// itself. Both are why links in uploaded HTML appeared to do nothing.
//
// So the pass does two things:
//   1. Neutralizes the inherited base with `<base href="about:srcdoc">`. That
//      keeps `#fragment` links in-document (they scroll, as authored) and makes
//      any reference we could NOT resolve fail inertly instead of silently
//      loading the app into the frame — broken beats wrong-page.
//   2. Resolves workspace-relative references to ABSOLUTE URLs: media to the raw
//      bytes, links to the page that displays that file, with `target="_top"` so
//      the click lands in the app rather than inside the inert frame.
//
// Absolute is not a style choice: under `about:srcdoc` there is no path to
// resolve against, so a root-relative `/w/…` href resolves to nothing and the
// browser blocks the navigation.
//
// Runs on DOMPurify's output, never before it, so it can't reintroduce anything
// the sanitizer stripped — it only swaps values the resolver classified as
// workspace paths, and only on elements that survived sanitization.
import { resolveRef } from "shared";

export interface HtmlRefContext {
  /** Directory of the rendered document ("" at the workspace root). */
  docDir: string;
  /**
   * URL for a workspace path's raw bytes, or null when sibling files aren't
   * reachable (a single-file share). Unresolved references then fail inertly
   * against the `about:srcdoc` base rather than loading the wrong file.
   */
  fileUrl: ((path: string) => string) | null;
  /**
   * URL of the page that displays another workspace file, or null when sibling
   * files aren't reachable (a single-file public share) — then links are left
   * as authored rather than pointed somewhere wrong.
   */
  pageUrl: ((path: string) => string) | null;
  /** Base for absolutizing the two builders above (`location.origin` in the app). */
  origin: string;
  /**
   * Where a link to another workspace file should land. `_top` (the default)
   * navigates the window the frame sits in — right for the inert preview, whose
   * frame cannot boot the SPA itself. Scripts mode passes `_blank`: it drops the
   * frame's top-navigation permission precisely so an executing page cannot
   * redirect the tab, which would leave a `_top` link doing nothing at all. A
   * new tab is the cost of that; a dead click would be the bug. (Normally the
   * link relay navigates in place before the new tab happens — see
   * utils/htmlLinkRelay.ts.)
   */
  linkTarget?: "_top" | "_blank";
}

/** Inert base URL: no scheme-relative resolution, so fragments stay in-document. */
const SRCDOC_BASE = "about:srcdoc";

/**
 * Schemes that open an app rather than a page. These get NO target: forced into
 * a new tab, Chrome hands the link off and closes the tab, but Arc opens a blank
 * tab and stalls there, so the mail app never opens. With no target the frame
 * passes the click straight to the OS handler. Both sandboxes allow that (each
 * carries `allow-popups`), and an external-protocol navigation never unloads the
 * frame. Not `_top`: the scripts sandbox deliberately has no top-navigation
 * token, so a `_top` mail link would do nothing there.
 */
const APP_SCHEME = /^\s*(?:mailto|tel|sms):/i;

/** Media that carries a single resolvable URL and survives sanitization. */
const MEDIA_SRC = "img[src], source[src], video[src], audio[src], track[src]";

/** Responsive candidates. `srcset` WINS over `src`, so skipping it would silently
 * defeat the `src` rewrite on any element carrying both. */
const MEDIA_SRCSET = "img[srcset], source[srcset]";

/**
 * Rewrite every URL in a `srcset`, preserving descriptors.
 *
 * Follows the HTML parsing rules rather than splitting on commas: a URL runs to
 * the next ASCII whitespace and MAY contain commas (a `data:` URL routinely
 * does), so a naive `split(",")` would shred it. Trailing commas on the URL
 * token mean the candidate has no descriptor.
 */
export function mapSrcset(value: string, map: (url: string) => string): string {
  const candidates: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (/\s/.test(value[i] as string) || value[i] === ",")) i++;
    if (i >= value.length) break;

    const urlStart = i;
    while (i < value.length && !/\s/.test(value[i] as string)) i++;
    const rawUrl = value.slice(urlStart, i);
    const url = rawUrl.replace(/,+$/, "");
    if (url === "") continue;

    let descriptor = "";
    if (url === rawUrl) {
      const descStart = i;
      while (i < value.length && value[i] !== ",") i++;
      descriptor = value.slice(descStart, i).trim();
      i++; // consume the separating comma
    }
    candidates.push(descriptor ? `${map(url)} ${descriptor}` : map(url));
  }
  return candidates.join(", ");
}

/**
 * Rewrite references in sanitized HTML and pin the document's base. `ctx` may be
 * null (no resolution context) — the base is still pinned, which is what keeps an
 * unresolvable link inert instead of blank-loading the app. `doc` defaults to the
 * browser document; tests pass a happy-dom document instead of configuring a DOM
 * test environment. With no DOM at all, the HTML is returned unchanged.
 */
export function rewriteHtmlRefs(html: string, ctx: HtmlRefContext | null, doc?: Document): string {
  const d = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!d) return html;

  // A whole document, not a fragment: parsing into a template would drop <head>
  // and every attribute on <body> (dashboards routinely style both).
  const parsed = d.implementation.createHTMLDocument("");
  parsed.documentElement.innerHTML = html;

  // First in <head>, and first wins per spec — so this beats any author <base>
  // that a future sanitizer config lets through.
  const base = parsed.createElement("base");
  base.setAttribute("href", SRCDOC_BASE);
  parsed.head.insertBefore(base, parsed.head.firstChild);

  if (ctx) {
    const absolute = (url: string) => {
      try {
        return new URL(url, ctx.origin).href;
      } catch {
        return url; // Nothing sane to point at — leave it visibly broken.
      }
    };

    for (const el of parsed.querySelectorAll(MEDIA_SRC)) rewriteUrlAttr(el, "src", ctx, absolute);
    for (const el of parsed.querySelectorAll("video[poster]")) {
      rewriteUrlAttr(el, "poster", ctx, absolute);
    }
    for (const el of parsed.querySelectorAll(MEDIA_SRCSET)) {
      const rewritten = mapSrcset(el.getAttribute("srcset") ?? "", (url) => {
        const ref = resolveRef(ctx.docDir, url);
        return ref.kind === "workspace" && ctx.fileUrl ? absolute(ctx.fileUrl(ref.path)) : url;
      });
      if (rewritten) el.setAttribute("srcset", rewritten);
    }

    for (const a of parsed.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      const ref = resolveRef(ctx.docDir, href);
      if (ref.kind === "workspace" && ctx.pageUrl) {
        const hash = ref.fragment ? `#${ref.fragment}` : "";
        a.setAttribute("href", `${absolute(ctx.pageUrl(ref.path))}${hash}`);
        // The frame can't render the target itself either way: inert, it can't
        // boot the SPA; scripting, it isn't our origin. So the click has to leave.
        a.setAttribute("target", ctx.linkTarget ?? "_top");
      } else if (ref.kind === "external" && APP_SCHEME.test(href)) {
        a.removeAttribute("target");
      } else if (ref.kind === "external") {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      } else {
        // Fragment, unresolvable, or a workspace path we can't route to. Leave the
        // href (native/visibly broken) but never let an author-supplied target
        // reach the sandbox's top-navigation permission.
        a.removeAttribute("target");
      }
    }
  }

  return parsed.documentElement.outerHTML;
}

/**
 * The in-app path for a click inside the preview frame, or null to leave the
 * click alone.
 *
 * Null is never a dead end: the anchor keeps its real href and `target="_top"`,
 * so anything this declines still navigates natively — a modified/middle click
 * opens its new tab, an external link opens its new tab, and an internal link
 * falls back to a full page load. This only upgrades the plain-left-click case
 * on our own origin to an SPA navigation.
 */
export function framedLinkPath(e: MouseEvent, origin: string): string | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const anchor = (e.target as Element | null)?.closest?.("a[href]");
  const href = anchor?.getAttribute("href");
  if (!href) return null;
  let url: URL;
  try {
    // Deliberately parsed with NO base, so only an absolute URL survives. That is
    // precisely the set `rewriteHtmlRefs` produced; everything it left as authored
    // (a `#fragment`, or a `../../../` ref that escaped the workspace) is relative
    // and must stay untouched. Resolving those against the origin instead would
    // send `#section` to the workspace root and a broken ref to an unrelated page.
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null; // external — let it open natively
  return `${url.pathname}${url.search}${url.hash}`;
}

function rewriteUrlAttr(
  el: Element,
  attr: string,
  ctx: HtmlRefContext,
  absolute: (url: string) => string,
): void {
  const ref = resolveRef(ctx.docDir, el.getAttribute(attr) ?? "");
  if (ref.kind === "workspace" && ctx.fileUrl) {
    el.setAttribute(attr, absolute(ctx.fileUrl(ref.path)));
  }
}