import { Window } from "happy-dom";
import { describe, expect, it } from "vite-plus/test";
import {
  framedLinkPath,
  type HtmlRefContext,
  mapSrcset,
  rewriteHtmlRefs,
} from "../app/utils/htmlRefs";

// The rewrite pass takes an explicit Document so tests run in the default Node
// environment with a happy-dom document instead of a DOM test environment.
const doc = new Window().document as unknown as Document;

const ctx: HtmlRefContext = {
  docDir: "reports/q1",
  fileUrl: (p) =>
    `https://api.test/api/workspaces/ws1/files/${p.split("/").map(encodeURIComponent).join("/")}`,
  pageUrl: (p) => `/w/ws1/${p.split("/").map(encodeURIComponent).join("/")}`,
  origin: "https://app.test",
};

/** Wrap a body fragment the way DOMPurify's WHOLE_DOCUMENT output arrives. */
const wrap = (body: string) => `<html><head></head><body>${body}</body></html>`;

const rewrite = (body: string, over: Partial<HtmlRefContext> = {}) =>
  rewriteHtmlRefs(wrap(body), { ...ctx, ...over }, doc);

/** Just the body content, for assertions that don't care about the head. */
const bodyOf = (html: string) =>
  html.replace(/^.*<body[^>]*>/s, "").replace(/<\/body><\/html>$/, "");

describe("rewriteHtmlRefs", () => {
  it("pins the frame's base URL so it can't inherit the app route", () => {
    // The whole bug: without this, a srcdoc frame resolves relative refs against
    // the app page and navigates itself into an SPA it cannot boot.
    expect(rewrite("<h1>hi</h1>")).toContain('<head><base href="about:srcdoc">');
  });

  it("pins the base even with no resolution context", () => {
    expect(rewriteHtmlRefs(wrap("<a href='x.html'>x</a>"), null, doc)).toContain(
      '<base href="about:srcdoc">',
    );
  });

  it("puts the base first in <head>, ahead of anything already there", () => {
    const out = rewriteHtmlRefs(
      `<html><head><base href="https://evil.example/"><style>h1{color:red}</style></head><body></body></html>`,
      ctx,
      doc,
    );
    // First base with an href wins per spec, so ours must lead.
    expect(out).toContain('<head><base href="about:srcdoc"><base href="https://evil.example/">');
  });

  it("rewrites a relative link to an absolute app URL that opens in the top window", () => {
    expect(bodyOf(rewrite(`<a href="other.html">other</a>`))).toBe(
      `<a href="https://app.test/w/ws1/reports/q1/other.html" target="_top">other</a>`,
    );
  });

  it("resolves ../ and root-absolute links against the workspace root", () => {
    expect(bodyOf(rewrite(`<a href="../index.html">up</a>`))).toContain(
      `href="https://app.test/w/ws1/reports/index.html"`,
    );
    expect(bodyOf(rewrite(`<a href="/dash.html">root</a>`))).toContain(
      `href="https://app.test/w/ws1/dash.html"`,
    );
  });

  it("keeps a link's fragment on the rewritten URL", () => {
    expect(bodyOf(rewrite(`<a href="other.html#totals">t</a>`))).toBe(
      `<a href="https://app.test/w/ws1/reports/q1/other.html#totals" target="_top">t</a>`,
    );
  });

  it("sends links to a new tab when the frame is running scripts", () => {
    // Scripts mode drops the frame's top-navigation permission on purpose, so a
    // _top link there would be a click that does nothing at all.
    expect(bodyOf(rewrite(`<a href="other.html">other</a>`, { linkTarget: "_blank" }))).toBe(
      `<a href="https://app.test/w/ws1/reports/q1/other.html" target="_blank">other</a>`,
    );
  });

  it("absolutizes the URL — a root-relative href cannot resolve under about:srcdoc", () => {
    // Regression guard: with base=about:srcdoc a "/w/…" href resolves to nothing
    // and the browser blocks the navigation outright.
    expect(bodyOf(rewrite(`<a href="other.html">o</a>`))).toContain("https://app.test/w/ws1/");
  });

  it("encodes paths with spaces", () => {
    expect(bodyOf(rewrite(`<a href="my report.html">r</a>`))).toContain(
      `https://app.test/w/ws1/reports/q1/my%20report.html`,
    );
  });

  it("rewrites relative media srcs to the raw-bytes URL", () => {
    expect(bodyOf(rewrite(`<img src="../chart.png">`))).toBe(
      `<img src="https://api.test/api/workspaces/ws1/files/reports/chart.png">`,
    );
    expect(bodyOf(rewrite(`<video src="clip.mp4" poster="thumb.png"></video>`))).toBe(
      `<video src="https://api.test/api/workspaces/ws1/files/reports/q1/clip.mp4" poster="https://api.test/api/workspaces/ws1/files/reports/q1/thumb.png"></video>`,
    );
  });

  it("rewrites srcset candidates, keeping their descriptors", () => {
    // srcset beats src, so leaving it alone would silently defeat the src rewrite.
    expect(bodyOf(rewrite(`<img src="c.png" srcset="c.png 1x, c@2x.png 2x">`))).toBe(
      `<img src="https://api.test/api/workspaces/ws1/files/reports/q1/c.png" srcset="https://api.test/api/workspaces/ws1/files/reports/q1/c.png 1x, https://api.test/api/workspaces/ws1/files/reports/q1/c%402x.png 2x">`,
    );
  });

  it("rewrites srcset on <picture> sources", () => {
    expect(bodyOf(rewrite(`<picture><source srcset="../wide.webp 640w"></picture>`))).toBe(
      `<picture><source srcset="https://api.test/api/workspaces/ws1/files/reports/wide.webp 640w"></picture>`,
    );
  });

  it("leaves external and unresolvable srcset candidates as authored", () => {
    expect(bodyOf(rewrite(`<img srcset="https://x.com/a.png 2x, ../../../../e.png 1x">`))).toBe(
      `<img srcset="https://x.com/a.png 2x, ../../../../e.png 1x">`,
    );
  });
});

describe("mapSrcset", () => {
  const up = (u: string) => `<${u}>`;

  it("keeps commas inside a data: URL intact", () => {
    // The reason this is not a split(",") — a data: URL is full of commas.
    expect(mapSrcset(`data:image/svg+xml,<svg/> 2x, b.png 1x`, up)).toBe(
      `<data:image/svg+xml,<svg/>> 2x, <b.png> 1x`,
    );
  });

  it("handles a bare URL, trailing commas and extra whitespace", () => {
    expect(mapSrcset("a.png", up)).toBe("<a.png>");
    // "a.png," ends the URL token, so that candidate simply has no descriptor.
    expect(mapSrcset("a.png,  b.png 2x", up)).toBe("<a.png>, <b.png> 2x");
    expect(mapSrcset("  a.png 1x ,  b.png 2x  ", up)).toBe("<a.png> 1x, <b.png> 2x");
  });

  it("returns empty for an empty attribute", () => {
    expect(mapSrcset("", up)).toBe("");
    expect(mapSrcset("   ", up)).toBe("");
  });
});

describe("rewriteHtmlRefs (continued)", () => {
  it("leaves in-document fragment links alone so they scroll natively", () => {
    expect(bodyOf(rewrite(`<a href="#section">s</a>`))).toBe(`<a href="#section">s</a>`);
  });

  it("opens external links in a new tab, leaving the href alone", () => {
    expect(bodyOf(rewrite(`<a href="https://x.com/a">x</a>`))).toBe(
      `<a href="https://x.com/a" target="_blank" rel="noopener noreferrer">x</a>`,
    );
  });

  // A mailto:/tel:/sms: link opens an app, not a page. Forced into a new tab,
  // Chrome hands it off and closes the tab, but Arc opens a blank tab and stalls
  // there — the mail app never opens. With no target the frame hands the click
  // straight to the OS handler, which both sandboxes permit (each carries
  // allow-popups) and which never unloads the frame.
  it("leaves mail, phone and SMS links without a target so they open their app", () => {
    for (const href of [
      "mailto:a@b.co?subject=Hi%20there",
      "tel:+441234567890",
      "sms:+441234567890",
    ]) {
      expect(bodyOf(rewrite(`<a href="${href}">x</a>`))).toBe(`<a href="${href}">x</a>`);
    }
  });

  it("strips an author target off mail links, whatever the scheme's case", () => {
    expect(bodyOf(rewrite(`<a href="MAILTO:a@b.co" target="_blank">x</a>`))).toBe(
      `<a href="MAILTO:a@b.co">x</a>`,
    );
    expect(bodyOf(rewrite(`<a href="mailto:a@b.co" target="_top">x</a>`))).toBe(
      `<a href="mailto:a@b.co">x</a>`,
    );
  });

  it("leaves unresolvable refs untouched (broken beats wrong-file)", () => {
    expect(bodyOf(rewrite(`<img src="../../../../etc/passwd">`))).toBe(
      `<img src="../../../../etc/passwd">`,
    );
    expect(bodyOf(rewrite(`<a href="../../../secret.html">s</a>`))).toBe(
      `<a href="../../../secret.html">s</a>`,
    );
  });

  it("leaves external media srcs unchanged", () => {
    expect(bodyOf(rewrite(`<img src="https://x.com/a.png">`))).toBe(
      `<img src="https://x.com/a.png">`,
    );
  });

  it("strips an author target off links it does not rewrite", () => {
    // Nothing the author wrote may reach the sandbox's top-navigation permission.
    expect(bodyOf(rewrite(`<a href="#s" target="_top">s</a>`))).toBe(`<a href="#s">s</a>`);
    expect(bodyOf(rewrite(`<a href="../../../x.html" target="_top">x</a>`))).toBe(
      `<a href="../../../x.html">x</a>`,
    );
  });

  // A single-file share serves exactly one path, so neither a sibling page nor
  // its bytes are addressable: the viewer passes both builders as null and
  // every relative reference is left as authored, to fail inertly against the
  // `about:srcdoc` base rather than resolve to the shared file itself.
  it("leaves references as authored when siblings aren't reachable (single-file share)", () => {
    const unreachable = { pageUrl: null, fileUrl: null };
    expect(bodyOf(rewrite(`<a href="other.html">o</a>`, unreachable))).toBe(
      `<a href="other.html">o</a>`,
    );
    expect(bodyOf(rewrite(`<img src="chart.png">`, unreachable))).toBe(`<img src="chart.png">`);
    expect(bodyOf(rewrite(`<img srcset="chart.png 1x, chart@2x.png 2x">`, unreachable))).toBe(
      `<img srcset="chart.png 1x, chart@2x.png 2x">`,
    );
    expect(bodyOf(rewrite(`<video poster="thumb.jpg"></video>`, unreachable))).toBe(
      `<video poster="thumb.jpg"></video>`,
    );
  });

  it("preserves head, body attributes and inline styles", () => {
    const out = rewriteHtmlRefs(
      `<html><head><style>h1{color:red}</style></head><body class="dark" style="margin:0"><h1>D</h1></body></html>`,
      ctx,
      doc,
    );
    expect(out).toContain("<style>h1{color:red}</style>");
    expect(out).toContain(`<body class="dark" style="margin:0">`);
  });

  it("returns the HTML unchanged with no DOM available", () => {
    // `doc` omitted and no global document (SSR) — fail soft, never throw.
    expect(rewriteHtmlRefs("<p>x</p>", ctx)).toBe("<p>x</p>");
  });
});
describe("framedLinkPath", () => {
  const ORIGIN = "https://app.test";

  /** A click on `href`, with optional modifier/button overrides. */
  const click = (href: string | null, over: Partial<MouseEvent> = {}) => {
    const a = doc.createElement("a");
    if (href !== null) a.setAttribute("href", href);
    const el = doc.createElement("span");
    a.appendChild(el);
    return framedLinkPath(
      { button: 0, defaultPrevented: false, target: el, ...over } as unknown as MouseEvent,
      ORIGIN,
    );
  };

  it("returns the in-app path for a plain left-click on our origin", () => {
    expect(click(`${ORIGIN}/w/ws1/reports/q1/other.html`)).toBe("/w/ws1/reports/q1/other.html");
  });

  it("keeps query and fragment (the share route navigates by ?p=)", () => {
    expect(click(`${ORIGIN}/s/tok?p=reports%2Fa.html`)).toBe("/s/tok?p=reports%2Fa.html");
    expect(click(`${ORIGIN}/w/ws1/a.html#totals`)).toBe("/w/ws1/a.html#totals");
  });

  it("declines external links so they open natively in a new tab", () => {
    expect(click("https://example.com/x")).toBeNull();
  });

  it("declines mail links so the browser hands them to the mail app", () => {
    expect(click("mailto:a@b.co?subject=Hi")).toBeNull();
  });

  it("declines modified and non-left clicks, so cmd-click still opens a tab", () => {
    const href = `${ORIGIN}/w/ws1/a.html`;
    expect(click(href, { metaKey: true })).toBeNull();
    expect(click(href, { ctrlKey: true })).toBeNull();
    expect(click(href, { shiftKey: true })).toBeNull();
    expect(click(href, { altKey: true })).toBeNull();
    expect(click(href, { button: 1 })).toBeNull();
    expect(click(href, { defaultPrevented: true })).toBeNull();
  });

  it("declines clicks that aren't on a link, and unparseable hrefs", () => {
    expect(click(null)).toBeNull();
    expect(click("http://[bad")).toBeNull();
  });

  it("declines every href the rewriter left relative", () => {
    // Regression: these were resolving against the origin, so an in-document
    // "#appendix" SPA-navigated to the workspace root, and a ref that escaped the
    // workspace navigated to an unrelated page instead of staying inert.
    expect(click("#appendix")).toBeNull();
    expect(click("")).toBeNull();
    expect(click("../../../secret.html")).toBeNull();
    expect(click("/w/ws1/a.html")).toBeNull();
  });
});