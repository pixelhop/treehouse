import { describe, expect, it } from "vite-plus/test";
import {
  noteIndexEntry,
  relativePath,
  relinkForMove,
  type RelinkInput,
  scanLinks,
  scanLinksFully,
} from "../linkScan";
import {
  createWikilinkResolver,
  incomingLinkKeys,
  parseWikilinkInner,
  wikilinkLabel,
  wikilinkTargetFor,
} from "../links";

describe("parseWikilinkInner", () => {
  it("splits target, heading and alias in Obsidian order", () => {
    expect(parseWikilinkInner("Note#Section|Jump")).toMatchObject({
      target: "Note",
      fragment: "Section",
      alias: "Jump",
    });
    expect(parseWikilinkInner("Note")).toMatchObject({
      target: "Note",
      fragment: null,
      alias: null,
    });
    expect(parseWikilinkInner("#Overview")).toMatchObject({ target: "", fragment: "Overview" });
  });

  it("treats a table-escaped \\| as the alias separator", () => {
    expect(parseWikilinkInner("Note\\|Short")).toMatchObject({ target: "Note", alias: "Short" });
  });

  it("records where the target sits so a rename can swap just it", () => {
    const p = parseWikilinkInner("  Old Name #h|a");
    expect("  Old Name #h|a".slice(p.targetStart, p.targetEnd)).toBe("Old Name");
  });

  it("labels with the alias, else the target and heading", () => {
    expect(wikilinkLabel(parseWikilinkInner("Note|Shown"))).toBe("Shown");
    expect(wikilinkLabel(parseWikilinkInner("Note#Sec"))).toBe("Note > Sec");
    expect(wikilinkLabel(parseWikilinkInner("#Sec"))).toBe("Sec");
  });
});

describe("createWikilinkResolver", () => {
  const resolve = createWikilinkResolver([
    "Projects/Alpha/Alpha.md",
    "Journal/2026-01-01.md",
    "a/Note.md",
    "deep/b/Note.md",
    "assets/diagram.png",
  ]);

  it("resolves a unique name, with .md optional", () => {
    expect(resolve("Alpha")).toBe("Projects/Alpha/Alpha.md");
    expect(resolve("Alpha.md")).toBe("Projects/Alpha/Alpha.md");
    expect(resolve("2026-01-01")).toBe("Journal/2026-01-01.md");
  });

  it("matches case-insensitively", () => {
    expect(resolve("alpha")).toBe("Projects/Alpha/Alpha.md");
  });

  it("resolves a full path or any trailing part of one", () => {
    expect(resolve("deep/b/Note")).toBe("deep/b/Note.md");
    expect(resolve("b/Note")).toBe("deep/b/Note.md");
  });

  it("breaks an ambiguous name toward the shallowest path", () => {
    expect(resolve("Note")).toBe("a/Note.md");
  });

  it("prefers the exact path over a deeper file with the same tail", () => {
    const r = createWikilinkResolver(["x/sub/Deep.md", "sub/Deep.md", "Deep.md"]);
    expect(r("sub/Deep")).toBe("sub/Deep.md");
    expect(r("Deep")).toBe("Deep.md");
  });

  it("anchors a leading slash at the root", () => {
    expect(resolve("/a/Note")).toBe("a/Note.md");
    expect(resolve("/Note")).toBeNull();
  });

  it("reaches non-markdown files by their full name only", () => {
    expect(resolve("diagram.png")).toBe("assets/diagram.png");
    expect(resolve("diagram")).toBeNull();
  });

  it("matches composed and decomposed accents alike", () => {
    const r = createWikilinkResolver(["Cafe\u0301.md"]);
    expect(r("Café")).toBe("Cafe\u0301.md");
  });

  it("returns null for unknown, empty, backslashed or traversing targets", () => {
    expect(resolve("Nonexistent")).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("a\\Note")).toBeNull();
    expect(resolve("../Note")).toBeNull();
  });

  it("skips workspace paths it can't reason about", () => {
    const r = createWikilinkResolver(["a\\evil.md", "safe.md"]);
    expect(r("evil")).toBeNull();
    expect(r("safe")).toBe("safe.md");
  });
});

describe("scanLinks", () => {
  const kinds = (src: string) =>
    scanLinks(src).map((l) => (l.kind === "wiki" ? `w:${l.parts.target}` : `m:${l.href}`));

  it("finds wikilinks, embeds and markdown links with exact offsets", () => {
    const src = "See [[Note|n]] and ![[Pic.png]] and [x](./x.md) and ![i](i.png).";
    const links = scanLinks(src);
    expect(kinds(src)).toEqual(["w:Note", "w:Pic.png", "m:./x.md"]);
    const [a, b, c] = links;
    expect(src.slice(a!.start, a!.end)).toBe("[[Note|n]]");
    expect(b).toMatchObject({ kind: "wiki", embed: true });
    expect(src.slice(b!.start, b!.end)).toBe("![[Pic.png]]");
    expect(c!.kind === "markdown" && src.slice(c!.hrefStart, c!.hrefEnd)).toBe("./x.md");
  });

  it("skips code, comments, escapes and front matter", () => {
    const src = [
      "---",
      "related: '[[Meta]]'",
      "---",
      "`[[Inline]]` \\[[Escaped]] <!-- [[Hidden]] -->",
      "```",
      "[[Fenced]]",
      "```",
      "~~~~",
      "[x](fenced.md)",
      "~~~~",
      "[[Real]]",
    ].join("\n");
    expect(kinds(src)).toEqual(["w:Real"]);
  });

  it("skips indented code blocks but not indented list continuations", () => {
    const src = [
      "Example:",
      "",
      "    [[In code]]",
      "",
      "\t[[Tab code]]",
      "",
      "- item",
      "",
      "    [[Continuation]]",
      "",
      "- nested",
      "    ```",
      "    [[Nested fence]]",
      "    ```",
      "",
      "Para",
      "    [[Lazy line]]",
    ].join("\n");
    expect(kinds(src)).toEqual(["w:Continuation", "w:Lazy line"]);
  });

  it("skips code nested in lists and quotes, at any depth", () => {
    const src = [
      "- item",
      "  - nested",
      "",
      "        [[Nested indented code]]",
      "",
      ">     [[Quoted indented code]]",
      "",
      "> ```",
      "> [[Quoted fence]]",
      "> ```",
      "",
      "> - quoted item",
      ">",
      ">       [[Quoted list code]]",
      "",
      "- [[Real]]",
    ].join("\n");
    expect(kinds(src)).toEqual(["w:Real"]);
  });

  it("skips raw HTML blocks, and closes a fence on a CRLF line", () => {
    const src = "<div>\n[[In HTML]]\n</div>\n\n```\r\n[[Fenced]]\r\n```\r\n[[Real]]";
    expect(kinds(src)).toEqual(["w:Real"]);
  });

  it("decodes escapes in a destination, keeping where it was written", () => {
    const src = String.raw`[x](Old\(1\).md) [y](<a\>b.md>)`;
    const [x, y] = scanLinks(src);
    expect(x).toMatchObject({ href: "Old(1).md", raw: String.raw`Old\(1\).md` });
    expect(y).toMatchObject({ href: "a>b.md", angle: true });
    expect(x?.kind === "markdown" && src.slice(x.hrefStart, x.hrefEnd)).toBe(
      String.raw`Old\(1\).md`,
    );
  });

  it("reads reference definitions, but not text that only looks like one", () => {
    const src = [
      "See [the plan][plan] and [plan].",
      "",
      "[plan]: <Old Name.md> 'Title'",
      "> [quoted]: ./q.md",
      "",
      "A paragraph",
      "[not]: a definition.md",
    ].join("\n");
    expect(kinds(src)).toEqual(["m:Old Name.md", "m:./q.md"]);
  });

  it("skips links inside inline HTML tags, but not between them", () => {
    const src = '<span title="[[Hidden]] [x](h.md)">[[Shown]]</span> <a\nhref="[[Also hidden]]">';
    expect(kinds(src)).toEqual(["w:Shown"]);
  });

  it("recognises front matter after a byte-order mark", () => {
    expect(kinds("\uFEFF---\nrelated: '[[Meta]]'\n---\n[[Body]]")).toEqual(["w:Body"]);
  });

  it("reads a reference definition whose destination is on the next line", () => {
    const src = "See [plan][p].\n\n[p]:\n  Old.md\n";
    const [link] = scanLinks(src);
    expect(link).toMatchObject({ href: "Old.md" });
    expect(link?.kind === "markdown" && src.slice(link.hrefStart, link.hrefEnd)).toBe("Old.md");
  });

  it("says when a hostile document stopped it before the end", () => {
    expect(scanLinksFully("[".repeat(200_000) + "\n\nSee [[Old]].").complete).toBe(false);
    expect(scanLinksFully("See [[Old]].").complete).toBe(true);
  });

  it("doesn't let a backtick left open run into the next block", () => {
    expect(kinds("Unclosed ` here\n# Example `[[Old]]`\n")).toEqual([]);
    expect(kinds("- open ` here\n- item `[[Old]]`\n- [[Real]]\n")).toEqual(["w:Real"]);
    expect(kinds("Para with ` tick\n\n[[Real]] and ` again\n")).toEqual(["w:Real"]);
  });

  it("reads a link whose title holds an escaped quote", () => {
    expect(kinds(String.raw`[x](Old.md 'it\'s old') and [y](Other.md "say \"hi\"")`)).toEqual([
      "m:Old.md",
      "m:Other.md",
    ]);
  });

  it("reads a link broken across lines", () => {
    expect(kinds("[x](\nOld.md\n)")).toEqual(["m:Old.md"]);
    expect(kinds('[x](Old.md "title"\n)')).toEqual(["m:Old.md"]);
    expect(kinds('[x](Old.md\n"title")')).toEqual(["m:Old.md"]);
    expect(kinds("> [x](\n> Old.md\n> )")).toEqual(["m:Old.md"]);
    expect(kinds("[x](\r\nOld.md\r\n)")).toEqual(["m:Old.md"]);
  });

  it("doesn't let a link's gap cross a blank line", () => {
    expect(kinds("[x](\n\nOld.md)")).toEqual([]);
  });

  it("leaves a note with too many lines unscanned, and says so", () => {
    const src = `[[Real]]\n${"a\n".repeat(100_001)}`;
    expect(scanLinksFully(src)).toMatchObject({ links: [], complete: false });
    expect(scanLinksFully(`[[Real]]\n${"a\n".repeat(1000)}`).complete).toBe(true);
  });

  it("leaves empty wikilinks as text", () => {
    expect(kinds("[[]] [[|x]]")).toEqual([]);
  });

  it("tokenises adjacent wikilinks separately", () => {
    expect(kinds("[[A]] [[B]]")).toEqual(["w:A", "w:B"]);
  });

  it("reads angle-bracket destinations, titles and balanced parens", () => {
    expect(kinds('[a](<my note.md> "t") [b](x_(1).md)')).toEqual(["m:my note.md", "m:x_(1).md"]);
  });

  it("does not treat a bare bracket or checkbox as a link", () => {
    expect(kinds("- [ ] task\n[not a link] (later)")).toEqual([]);
  });

  it("stays fast on hostile input", () => {
    for (const src of [
      "[".repeat(1_000_000),
      "`` `".repeat(250_000),
      "[a](".repeat(250_000),
      "![[".repeat(300_000),
      "[a](<".repeat(200_000),
      '[a](x "'.repeat(150_000),
      "[r]: x\n".repeat(150_000) + "[r]",
      "a\n\n".repeat(50_000),
      "- a\n".repeat(100_000),
      Array.from({ length: 1400 }, (_, i) => `${" ".repeat(i * 2)}- x`).join("\n"),
      "text " + "<!--".repeat(250_000),
      '<a title="'.repeat(100_000),
      "> - ".repeat(250_000),
    ]) {
      const t = Date.now();
      scanLinks(src);
      // Generous for a busy CI machine; quadratic scanning takes tens of seconds.
      expect(Date.now() - t).toBeLessThan(3000);
    }
  });
});

describe("index keys", () => {
  it("records wikilinks by name and markdown links by resolved path", () => {
    const { keys } = noteIndexEntry(
      "[[Note]] [[Alpha/Note.md#h]] [[/Root]] [up](../Other.md) [ext](https://x.com) [[#Self]]",
      "docs/here.md",
    );
    expect(keys.sort()).toEqual(["p:Other.md", "w:/root", "w:alpha/note", "w:note"]);
  });

  it("lists every key a link to a path could have used", () => {
    expect(incomingLinkKeys("Projects/Alpha/Note.md").map((k) => k.key)).toEqual([
      "p:Projects/Alpha/Note.md",
      "w:projects/alpha/note",
      "w:alpha/note",
      "w:note",
      "w:/projects/alpha/note",
    ]);
  });

  it("agrees with outgoing keys for every way of naming a file", () => {
    const incoming = new Set(incomingLinkKeys("Projects/Alpha/Note.md").map((k) => k.key));
    for (const link of ["[[Note]]", "[[note.md]]", "[[Alpha/Note]]", "[[/Projects/Alpha/Note]]"]) {
      expect(noteIndexEntry(link, "x.md").keys.every((k) => incoming.has(k))).toBe(true);
    }
    expect(noteIndexEntry("[n](Alpha/Note.md)", "Projects/x.md").keys).toEqual([
      "p:Projects/Alpha/Note.md",
    ]);
  });
});

describe("relativePath", () => {
  it("walks up only as far as the shared ancestor", () => {
    expect(relativePath("a/b", "a/c/x.md")).toBe("../c/x.md");
    expect(relativePath("", "a/x.md")).toBe("a/x.md");
    expect(relativePath("a", "x.md")).toBe("../x.md");
    expect(relativePath("a", "a/x.md")).toBe("x.md");
  });
});

describe("wikilinkTargetFor", () => {
  it("returns null for a name a wikilink can't hold", () => {
    for (const name of ["New#1.md", "New|Name.md", "a[b].md", " padded.md"]) {
      const r = createWikilinkResolver([name]);
      expect(wikilinkTargetFor(name, "Was", r)).toBeNull();
    }
  });

  it("uses the bare name when it is unambiguous, else enough folders", () => {
    const r = createWikilinkResolver(["new/Plan.md", "old/Plan.md", "Solo.md"]);
    expect(wikilinkTargetFor("Solo.md", "Was", r)).toBe("Solo");
    expect(wikilinkTargetFor("new/Plan.md", "Was", r)).toBe("Plan");
    expect(wikilinkTargetFor("old/Plan.md", "Was", r)).toBe("old/Plan");
    expect(wikilinkTargetFor("Solo.md", "Was.md", r)).toBe("Solo.md");
  });
});

describe("relinkForMove", () => {
  function relink(
    content: string,
    opts: { doc?: string; docAfter?: string; from: string; to: string; paths: string[] },
  ) {
    const after = opts.paths.map((p) => (p === opts.from ? opts.to : p));
    const input: RelinkInput = {
      content,
      docPathBefore: opts.doc ?? "notes/index.md",
      docPathAfter: opts.docAfter ?? opts.doc ?? "notes/index.md",
      move: { from: opts.from, to: opts.to },
      resolveBefore: createWikilinkResolver(opts.paths),
      resolveAfter: createWikilinkResolver(after),
      existedBefore: (p) => opts.paths.includes(p),
    };
    return relinkForMove(input);
  }
  const paths = ["notes/index.md", "notes/Old Name.md", "notes/Other.md"];

  it("renames the target and keeps heading, alias and everything else", () => {
    const src = "Intro [[Old Name#Plan|the plan]] and [[old name]] but not `[[Old Name]]`.";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New Name.md", paths });
    expect(out.content).toBe(
      "Intro [[New Name#Plan|the plan]] and [[New Name]] but not `[[Old Name]]`.",
    );
    expect(out.changed).toBe(2);
  });

  it("leaves a wikilink alone when a folder move keeps it resolving", () => {
    const src = "[[Old Name]]";
    const out = relink(src, { from: "notes/Old Name.md", to: "archive/Old Name.md", paths });
    expect(out).toEqual({ content: src, changed: 0, unwritable: 0, complete: true });
  });

  it("qualifies the new name when it would be ambiguous", () => {
    const out = relink("[[Old Name]]", {
      from: "notes/Old Name.md",
      to: "archive/Other.md",
      paths,
    });
    expect(out.content).toBe("[[archive/Other]]");
  });

  it("re-points relative and root-absolute markdown links, keeping fragments", () => {
    const src =
      "[a](Old%20Name.md#top) [b](./Old%20Name.md) [c](/notes/Old%20Name.md) [d](<Old Name.md>)";
    const out = relink(src, { from: "notes/Old Name.md", to: "archive/New (1).md", paths });
    expect(out.content).toBe(
      "[a](../archive/New%20%281%29.md#top) [b](../archive/New%20%281%29.md) [c](/archive/New%20%281%29.md) [d](<../archive/New (1).md>)",
    );
  });

  it("keeps the moved file's own relative links reaching their files", () => {
    const src = "[o](Other.md) [self](Old%20Name.md) [[Other]] [gone](Missing.md)";
    const out = relink(src, {
      doc: "notes/Old Name.md",
      docAfter: "archive/2026/Old Name.md",
      from: "notes/Old Name.md",
      to: "archive/2026/Old Name.md",
      paths,
    });
    expect(out.content).toBe(
      "[o](../../notes/Other.md) [self](Old%20Name.md) [[Other]] [gone](Missing.md)",
    );
  });

  it("changes nothing in a document that doesn't link to the file", () => {
    const src = "[[Other]] [x](Other.md)";
    expect(relink(src, { from: "notes/Old Name.md", to: "notes/New.md", paths })).toEqual({
      content: src,
      changed: 0,
      unwritable: 0,
      complete: true,
    });
  });

  it("only rewrites links that resolved to the moved file, not a same-named sibling", () => {
    const p = ["Plan.md", "deep/Plan.md", "notes/index.md"];
    const out = relink("[[Plan]] [[deep/Plan]]", {
      from: "deep/Plan.md",
      to: "deep/Roadmap.md",
      paths: p,
    });
    expect(out.content).toBe("[[Plan]] [[Roadmap]]");
  });

  it("never rewrites a code sample", () => {
    const src = "Real [[Old Name]]\n\n    Example: [[Old Name]]\n";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New.md", paths });
    expect(out.content).toBe("Real [[New]]\n\n    Example: [[Old Name]]\n");
  });

  it("reports a wikilink it can't write instead of breaking it", () => {
    const src = "[[Old Name]] and [x](Old%20Name.md)";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New#1.md", paths });
    expect(out).toEqual({
      content: "[[Old Name]] and [x](New%231.md)",
      changed: 1,
      unwritable: 1,
      complete: true,
    });
  });

  it("encodes what an angle destination would otherwise mangle", () => {
    const src = "[a](<Old Name.md>)";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/50% off #2?.md", paths });
    expect(out.content).toBe("[a](<50%25 off %232%3F.md>)");
  });

  it("rewrites escaped destinations and reference definitions", () => {
    const docs = ["notes/index.md", "notes/Old(1).md"];
    const src = String.raw`[a](Old\(1\).md) [b][r]` + "\n\n[r]: Old(1).md\n";
    const out = relink(src, { from: "notes/Old(1).md", to: "notes/New.md", paths: docs });
    expect(out.content).toBe("[a](New.md) [b][r]\n\n[r]: New.md\n");
    expect(out.changed).toBe(2);
  });

  it("never rewrites code nested in a list", () => {
    const src = "- Example:\n\n      [[Old Name]]\n\n- [[Old Name]]";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New.md", paths });
    expect(out.content).toBe("- Example:\n\n      [[Old Name]]\n\n- [[New]]");
  });

  it("writes an angle destination markdown won't decode differently", () => {
    const src = "[a](<Old Name.md>)";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/R&amp;D.md", paths });
    expect(out.content).toBe("[a](<R%26amp;D.md>)");
    expect(out.unwritable).toBe(0);
  });

  it("keeps a fragment written as an entity", () => {
    const out = relink("[x](Old%20Name.md&#35;Budget)", {
      from: "notes/Old Name.md",
      to: "notes/New.md",
      paths,
    });
    expect(out.content).toBe("[x](New.md&#35;Budget)");
  });

  it("reports a document it couldn't scan to the end", () => {
    const src = "[".repeat(200_000) + "\n\n[[Old Name]]";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New.md", paths });
    expect(out.complete).toBe(false);
  });

  it("leaves front matter alone after a byte-order mark", () => {
    const src = "\uFEFF---\nrelated: '[[Old Name]]'\n---\n[[Old Name]]";
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New.md", paths });
    expect(out.content).toBe("\uFEFF---\nrelated: '[[Old Name]]'\n---\n[[New]]");
  });

  it("stays linear in the number of links rewritten", () => {
    const src = "[[Old Name]] ".repeat(100_000);
    const t = Date.now();
    const out = relink(src, { from: "notes/Old Name.md", to: "notes/New.md", paths });
    expect(out.changed).toBe(100_000);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});