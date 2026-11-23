import { Window } from "happy-dom";
import { describe, expect, it } from "vite-plus/test";
import { appRouteFor, internalLinkTarget, rewriteMarkdownRefs } from "../app/utils/markdownRefs";

// The rewrite pass takes an explicit Document so tests run in the default Node
// environment with a happy-dom document instead of a DOM test environment.
const doc = new Window().document as unknown as Document;

const ctx = {
  docDir: "docs/guide",
  fileUrl: (p: string) =>
    `https://api.test/api/workspaces/ws1/files/${p.split("/").map(encodeURIComponent).join("/")}`,
  pageUrl: (p: string) => appRouteFor("ws1", p),
};

const rewrite = (html: string, docDir = ctx.docDir) =>
  rewriteMarkdownRefs(html, { ...ctx, docDir }, doc);

describe("appRouteFor", () => {
  it("builds encoded in-app routes, and the overview for the root", () => {
    expect(appRouteFor("ws1", "docs/my file.md")).toBe("/w/ws1/docs/my%20file.md");
    expect(appRouteFor("ws1", "")).toBe("/w/ws1");
  });
});

describe("rewriteMarkdownRefs", () => {
  it("rewrites relative image srcs to the API file URL (AE1)", () => {
    expect(rewrite(`<img src="../assets/a.png">`)).toBe(
      `<img src="https://api.test/api/workspaces/ws1/files/docs/assets/a.png">`,
    );
  });

  it("rewrites relative link hrefs to in-app routes (AE3)", () => {
    expect(rewrite(`<a href="./setup.md">next</a>`, "docs")).toBe(
      `<a href="/w/ws1/docs/setup.md">next</a>`,
    );
  });

  it("treats raw HTML and markdown-generated tags identically (R14)", () => {
    const html = `<p><img src="./shot.png"> and <a href="./doc.md">doc</a></p>`;
    expect(rewrite(html, "docs")).toBe(
      `<p><img src="https://api.test/api/workspaces/ws1/files/docs/shot.png"> and <a href="/w/ws1/docs/doc.md">doc</a></p>`,
    );
  });

  it("marks external links to open in a new tab, leaving the href alone", () => {
    expect(rewrite(`<a href="https://x.com/a">x</a>`)).toBe(
      `<a href="https://x.com/a" target="_blank" rel="noopener noreferrer">x</a>`,
    );
    expect(rewrite(`<a href="//evil.com/x">x</a>`)).toBe(
      `<a href="//evil.com/x" target="_blank" rel="noopener noreferrer">x</a>`,
    );
  });

  it("leaves external image srcs unchanged", () => {
    expect(rewrite(`<img src="https://x.com/a.png">`)).toBe(`<img src="https://x.com/a.png">`);
  });

  it("leaves unresolvable refs byte-identical (AE2)", () => {
    expect(rewrite(`<img src="../../../a.png">`)).toBe(`<img src="../../../a.png">`);
    expect(rewrite(`<a href="./bad%E0%A4%A">x</a>`)).toBe(`<a href="./bad%E0%A4%A">x</a>`);
  });

  it("leaves fragment-only links native", () => {
    expect(rewrite(`<a href="#section">jump</a>`)).toBe(`<a href="#section">jump</a>`);
  });

  it("encodes spaces in rewritten URLs from raw or encoded refs", () => {
    expect(rewrite(`<img src="./my file.png">`, "docs")).toBe(
      `<img src="https://api.test/api/workspaces/ws1/files/docs/my%20file.png">`,
    );
    expect(rewrite(`<img src="./my%20file.png">`, "docs")).toBe(
      `<img src="https://api.test/api/workspaces/ws1/files/docs/my%20file.png">`,
    );
  });

  it("carries link fragments through to the in-app route", () => {
    expect(rewrite(`<a href="./doc.md#sec">x</a>`, "docs")).toBe(
      `<a href="/w/ws1/docs/doc.md#sec">x</a>`,
    );
  });

  it("resolves folder links to the folder route (AE5)", () => {
    expect(rewrite(`<a href="./api/">api</a>`, "docs")).toBe(`<a href="/w/ws1/docs/api">api</a>`);
  });

  it("rewrites source[src] like img[src]", () => {
    expect(rewrite(`<video><source src="./clip.mp4"></video>`, "docs")).toBe(
      `<video><source src="https://api.test/api/workspaces/ws1/files/docs/clip.mp4"></video>`,
    );
  });

  it("resolves from a root-level document (docDir empty)", () => {
    expect(rewrite(`<img src="./banner.png">`, "")).toBe(
      `<img src="https://api.test/api/workspaces/ws1/files/banner.png">`,
    );
  });

  // A single-file public share can't reach sibling files, so it passes no page
  // URL: media still resolves (the share serves its own bytes), but links stay
  // as authored rather than pointing at something the token doesn't cover.
  // A single-file share serves exactly one path: neither a sibling page nor its
  // bytes are addressable, so the viewer passes both builders as null. The link
  // is defused to plain text (a live-looking link that goes nowhere is worse
  // than none) and the image is left exactly as authored — anything else would
  // point it at the shared file itself.
  it("defuses links and leaves media alone when siblings aren't reachable", () => {
    const unreachable = { ...ctx, docDir: "docs", pageUrl: null, fileUrl: null };
    expect(rewriteMarkdownRefs(`<a href="./setup.md">next</a>`, unreachable, doc)).toBe(
      `<a title="This file isn’t part of this share">next</a>`,
    );
    expect(rewriteMarkdownRefs(`<img src="./shot.png">`, unreachable, doc)).toBe(
      `<img src="./shot.png">`,
    );
  });

  it("routes links through the given page URL builder (public share)", () => {
    const shareCtx = {
      ...ctx,
      docDir: "notes",
      pageUrl: (p: string) => `/s/tok123?p=${encodeURIComponent(p)}`,
    };
    expect(rewriteMarkdownRefs(`<a href="./two.md">two</a>`, shareCtx, doc)).toBe(
      `<a href="/s/tok123?p=notes%2Ftwo.md">two</a>`,
    );
  });

  it("leaves encoded-slash traversal refs byte-identical", () => {
    expect(rewrite(`<img src="..%2F..%2Fsecret.png">`)).toBe(`<img src="..%2F..%2Fsecret.png">`);
  });

  it("returns the HTML unrewritten when no DOM is available (SSR fail-soft)", () => {
    // This test env has no global document, so omitting `doc` exercises the path.
    const html = `<img src="./a.png">`;
    expect(rewriteMarkdownRefs(html, ctx)).toBe(html);
  });
});

describe("rewriteMarkdownRefs — wikilinks", () => {
  const rewriteWiki = (
    html: string,
    resolve?: (t: string) => string | null,
    pageUrl: ((p: string) => string) | null = ctx.pageUrl,
  ) => rewriteMarkdownRefs(html, { ...ctx, pageUrl, resolveWikilink: resolve }, doc);

  it("routes a resolved wikilink to its in-app page", () => {
    expect(rewriteWiki(`<a href="#" data-wikilink="A">A</a>`, () => "Notes/A.md")).toBe(
      `<a href="/w/ws1/Notes/A.md" class="wikilink">A</a>`,
    );
  });

  it("carries a heading through as the fragment", () => {
    expect(
      rewriteWiki(
        `<a href="#" data-wikilink="Note" data-wikilink-fragment="Sec">Note</a>`,
        () => "Note.md",
      ),
    ).toBe(`<a href="/w/ws1/Note.md#Sec" class="wikilink">Note</a>`);
  });

  it("marks an unresolved wikilink inert and says why", () => {
    expect(rewriteWiki(`<a href="#" data-wikilink="Ghost">Ghost</a>`, () => null)).toBe(
      `<a aria-disabled="true" title="No file named “Ghost”" class="wikilink wikilink-unresolved">Ghost</a>`,
    );
  });

  it("treats wikilinks as unresolved without a file list", () => {
    expect(rewriteWiki(`<a href="#" data-wikilink="A">A</a>`)).toContain("wikilink-unresolved");
  });

  it("defuses a resolved wikilink where siblings can't be reached", () => {
    const out = rewriteWiki(`<a href="#" data-wikilink="A">A</a>`, () => "A.md", null);
    expect(out).not.toContain("href");
    expect(out).toContain("This file isn’t part of this share");
  });

  it("leaves ordinary links alone alongside wikilinks", () => {
    expect(
      rewriteWiki(`<a href="./x.md">x</a> <a href="#" data-wikilink="A">A</a>`, () => "A.md"),
    ).toBe(`<a href="/w/ws1/docs/guide/x.md">x</a> <a href="/w/ws1/A.md" class="wikilink">A</a>`);
  });
});

describe("internalLinkTarget", () => {
  const anchor = (href: string) => {
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    const span = doc.createElement("span");
    a.appendChild(span);
    return span; // click lands on a nested element; closest() must find the anchor
  };
  const click = (target: unknown, mods: Partial<MouseEvent> = {}) =>
    ({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target,
      ...mods,
    }) as unknown as MouseEvent;

  it("returns the href for a plain left-click on an internal link", () => {
    expect(internalLinkTarget(click(anchor("/w/ws1/docs/a.md")))).toBe("/w/ws1/docs/a.md");
    // The public share viewer's own route shape, so links inside a shared
    // markdown file navigate the share rather than reloading the page.
    expect(internalLinkTarget(click(anchor("/s/tok123?p=notes%2Fa.md")))).toBe(
      "/s/tok123?p=notes%2Fa.md",
    );
  });

  it("ignores modified and middle clicks (R15)", () => {
    const t = () => anchor("/w/ws1/a.md");
    expect(internalLinkTarget(click(t(), { button: 1 }))).toBeNull();
    expect(internalLinkTarget(click(t(), { metaKey: true }))).toBeNull();
    expect(internalLinkTarget(click(t(), { ctrlKey: true }))).toBeNull();
    expect(internalLinkTarget(click(t(), { shiftKey: true }))).toBeNull();
    expect(internalLinkTarget(click(t(), { altKey: true }))).toBeNull();
    expect(internalLinkTarget(click(t(), { defaultPrevented: true }))).toBeNull();
  });

  it("ignores external/fragment links and clicks outside anchors", () => {
    expect(internalLinkTarget(click(anchor("https://x.com/a")))).toBeNull();
    expect(internalLinkTarget(click(anchor("#section")))).toBeNull();
    expect(internalLinkTarget(click(doc.createElement("p")))).toBeNull();
    expect(internalLinkTarget(click(null))).toBeNull();
  });
});

describe("table wrapping", () => {
  it("wraps a table so it scrolls on its own axis, not the document's", () => {
    // The reading pane is overflow-x-hidden, so a table wider than the screen
    // has to carry its own scroller or its right-hand columns are unreachable.
    expect(rewrite(`<table><tr><td>a</td></tr></table>`)).toBe(
      `<div class="table-scroll"><table><tr><td>a</td></tr></table></div>`,
    );
  });

  it("wraps every table, not just the first", () => {
    const out = rewrite(`<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>`);
    expect(out.match(/class="table-scroll"/g)).toHaveLength(2);
  });

  it("is idempotent, so re-rendering can't nest wrappers", () => {
    const once = rewrite(`<table><tr><td>a</td></tr></table>`);
    expect(rewrite(once)).toBe(once);
  });

  it("leaves the rest of the document alone", () => {
    expect(rewrite(`<p>before</p><table><tr><td>a</td></tr></table><p>after</p>`)).toBe(
      `<p>before</p><div class="table-scroll"><table><tr><td>a</td></tr></table></div><p>after</p>`,
    );
  });
});