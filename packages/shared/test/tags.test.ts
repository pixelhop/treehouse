import { describe, expect, it } from "vite-plus/test";
import { noteIndexEntry, scanNote } from "../linkScan";
import { frontMatterTagList, normalizeTag, tagAncestors, tidyTag } from "../tags";

describe("normalizeTag", () => {
  it("drops the hash, outer slashes and spaces, and rejects what isn't a tag", () => {
    expect(normalizeTag("#Planning")).toBe("Planning");
    expect(normalizeTag(" project/alpha/ ")).toBe("project/alpha");
    expect(normalizeTag("project//alpha///")).toBe("project/alpha");
    expect(tidyTag("#2026")).toBe("2026");
    expect(tidyTag("#")).toBeNull();
    expect(normalizeTag("2026")).toBeNull();
    expect(normalizeTag("#")).toBeNull();
    expect(normalizeTag("x".repeat(101))).toBeNull();
  });
});

describe("tag nesting", () => {
  it("files a nested tag under each of its parents", () => {
    expect(tagAncestors("Project/Alpha")).toEqual(["project", "project/alpha"]);
  });
});

describe("frontMatterTagList", () => {
  it("reads a list, or text separated by commas", () => {
    expect(frontMatterTagList(["a", "#b", 7, "v2", null])).toEqual(["a", "b", "v2"]);
    expect(frontMatterTagList("planning, product")).toEqual(["planning", "product"]);
    expect(frontMatterTagList({ a: 1 })).toEqual([]);
  });
});

describe("scanNote tags", () => {
  const tags = (src: string) => scanNote(src).tags;

  it("reads front matter and inline tags, once each", () => {
    const src = "---\ntags: [Planning, product]\n---\n\nShip it #planning #launch/beta.\n";
    expect(tags(src)).toEqual(["Planning", "product", "launch/beta"]);
  });

  it("doesn't misfire on headings, fragments, entities, code or links", () => {
    const src = [
      "# Heading",
      "## Heading #real",
      "See page#section and &#35; and https://x.test/#frag.",
      "`#inline-code` \\#escaped [see #in-link](x.md)",
      "",
      "```",
      "#fenced",
      "```",
      "",
      "- item",
      "",
      "      #nested-code",
      "",
      "<div>",
      "#in-html",
      "</div>",
      "",
      'Text <span title=" #in-attribute">visible</span>',
      "",
      "#2026 is a year, #a2026 is a tag",
    ].join("\n");
    expect(tags(src)).toEqual(["real", "a2026"]);
  });

  it("keeps combining marks, so a decomposed tag matches its composed form", () => {
    expect(tags("#cafe\u0301 and #नमस्ते")).toEqual(["café", "नमस्ते"]);
  });

  it("doesn't read tags from reference-style link text or image alt text", () => {
    const refs = "\n\n[ref]: image.png\n";
    expect(tags(`![caption #ghost][ref]${refs}`)).toEqual([]);
    expect(tags(`[text #ghost][ref]${refs}`)).toEqual([]);
    expect(tags(`[ref #no]${refs}`)).toEqual(["no"]);
    expect(tags(`[ref][] then #real${refs}`)).toEqual(["real"]);
    expect(tags(`[a #plain](x.md) [not a ref #here]`)).toEqual(["here"]);
  });

  it("ignores front matter that doesn't parse", () => {
    expect(tags("---\ntags: [a\n---\n#b")).toEqual(["b"]);
  });

  it("indexes each tag under itself and its parents", () => {
    const { keys, tags: found } = noteIndexEntry("#Project/Alpha", "n.md");
    expect(found).toEqual(["Project/Alpha"]);
    expect(keys).toEqual(["t:project", "t:project/alpha"]);
  });
});