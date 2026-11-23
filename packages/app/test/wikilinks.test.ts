import { describe, expect, it } from "vite-plus/test";
import { markdownRenderer } from "../app/utils/wikilinks";

const render = (src: string) => (markdownRenderer.parse(src) as string).trim();

describe("wikilink extension", () => {
  it("renders a bare wikilink as a data-carrying anchor", () => {
    expect(render("[[Note]]")).toContain(`<a href="#" data-wikilink="Note">Note</a>`);
  });

  it("uses the alias as display text", () => {
    expect(render("[[Projects/Alpha|Alpha]]")).toContain(
      `<a href="#" data-wikilink="Projects/Alpha">Alpha</a>`,
    );
  });

  it("carries a heading as a fragment marker and labels it", () => {
    expect(render("[[Note#Section]]")).toContain(
      `<a href="#" data-wikilink="Note" data-wikilink-fragment="Section">Note &gt; Section</a>`,
    );
  });

  it("supports heading and alias together (Obsidian order)", () => {
    expect(render("[[Note#Section|Jump]]")).toContain(
      `<a href="#" data-wikilink="Note" data-wikilink-fragment="Section">Jump</a>`,
    );
  });

  it("renders an embed as a plain link, swallowing the bang", () => {
    expect(render("See ![[Diagram.png]]")).toBe(
      `<p>See <a href="#" data-wikilink="Diagram.png">Diagram.png</a></p>`,
    );
  });

  it("renders a same-note heading link as a native fragment anchor", () => {
    const out = render("[[#Overview]]");
    expect(out).toContain(`<a href="#Overview">Overview</a>`);
    expect(out).not.toContain("data-wikilink");
  });

  it("tokenises adjacent wikilinks separately", () => {
    const out = render("[[A]] [[B]]");
    expect(out).toContain(`data-wikilink="A"`);
    expect(out).toContain(`data-wikilink="B"`);
  });

  it("leaves empty wikilinks and code alone", () => {
    expect(render("[[]]")).toContain("[[]]");
    expect(render("`[[Code]]`")).toBe("<p><code>[[Code]]</code></p>");
  });

  it("escapes markup in the target so nothing survives raw", () => {
    const out = render("[[<img src=x onerror=alert(1)>]]");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).not.toContain("<img src=x");
  });

  it("does not treat normal markdown links as wikilinks", () => {
    expect(render("[label](path.md)")).not.toContain("data-wikilink");
  });
});