import { describe, expect, it } from "vite-plus/test";
import { buildTrackChanges } from "../app/utils/trackChanges";

// The invariant these tests exist to protect (KD6): a non-technical reader must
// never see markdown syntax presented as an edit. So every assertion about a
// mark checks what is INSIDE it, not just that a diff happened.

/** The text inside every <ins>/<del> mark, in order. */
function marks(markdown: string, tag: "ins" | "del"): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  for (const m of markdown.matchAll(re)) out.push(m[1]!);
  return out;
}

describe("buildTrackChanges — visible prose changes", () => {
  it("marks a word replacement and leaves the rest of the sentence alone", () => {
    const res = buildTrackChanges("The deadline is Friday.\n", "The deadline is Monday.\n");
    expect(res.status).toBe("changed");
    expect(marks(res.markdown, "del")).toEqual(["Friday"]);
    expect(marks(res.markdown, "ins")).toEqual(["Monday"]);
    expect(res.markdown).toContain("The deadline is ");
  });

  it("marks an inserted paragraph as an insertion only", () => {
    const res = buildTrackChanges("One.\n", "One.\n\nTwo.\n");
    expect(res.status).toBe("changed");
    expect(marks(res.markdown, "ins")).toEqual(["Two."]);
    expect(marks(res.markdown, "del")).toEqual([]);
    expect(res.markdown).toContain("One.");
  });

  it("marks a removed paragraph as a deletion only, keeping it on screen", () => {
    const res = buildTrackChanges("One.\n\nTwo.\n", "One.\n");
    expect(res.status).toBe("changed");
    expect(marks(res.markdown, "del")).toEqual(["Two."]);
    expect(marks(res.markdown, "ins")).toEqual([]);
  });

  it("keeps a heading looking like a heading — only its words are marked", () => {
    const res = buildTrackChanges("## Timeline\n", "## Schedule\n");
    expect(res.markdown.startsWith("## ")).toBe(true);
    expect(marks(res.markdown, "del")).toEqual(["Timeline"]);
    expect(marks(res.markdown, "ins")).toEqual(["Schedule"]);
    // The `##` must never appear inside a mark — that is a source diff.
    for (const m of [...marks(res.markdown, "del"), ...marks(res.markdown, "ins")]) {
      expect(m).not.toContain("#");
    }
  });

  it("keeps a list item looking like a list item", () => {
    const res = buildTrackChanges("- ship on Friday\n", "- ship on Monday\n");
    expect(res.markdown.startsWith("- ")).toBe(true);
    expect(marks(res.markdown, "ins")).toEqual(["Monday"]);
  });

  it("leaves untouched bold intact outside the marks", () => {
    const res = buildTrackChanges("The **deadline** is Friday.\n", "The **deadline** is Monday.\n");
    expect(res.markdown).toContain("**deadline**");
    expect(marks(res.markdown, "ins")).toEqual(["Monday"]);
  });

  it("never leaves a bare delimiter on the line when a change splits a bold pair", () => {
    // `**September 12th**` → `**October 3rd**`: the opening `**` belongs to the
    // unchanged run and the closing `**` to the changed one, so a naive merge
    // emits an unclosed `**` — literal asterisks in the reader's face.
    const res = buildTrackChanges(
      "The launch is on **September 12th**.\n",
      "The launch is on **October 3rd**.\n",
    );
    expect(res.status).toBe("changed");
    const stars = res.markdown.replace(/<\/?(?:ins|del)[^>]*>/g, "").match(/\*/g)?.length ?? 0;
    expect(stars % 2).toBe(0);
    expect(res.markdown).toContain("October");
  });

  it("never leaves a stray emphasis delimiter inside a mark", () => {
    const res = buildTrackChanges("A **bold claim** here.\n", "A quiet claim here.\n");
    for (const m of [...marks(res.markdown, "del"), ...marks(res.markdown, "ins")]) {
      expect(m).not.toMatch(/\*/);
    }
  });
});

describe("buildTrackChanges — nothing a reader would see", () => {
  it("reads a formatting-only change as no visible change", () => {
    const res = buildTrackChanges("A *word* here.\n", "A _word_ here.\n");
    expect(res.status).toBe("no_visible_changes");
  });

  // Strikethrough was the one inline delimiter the projection didn't strip, so
  // dropping it read as a change and put the tildes themselves on screen.
  it("reads dropping strikethrough as no visible change", () => {
    const res = buildTrackChanges("A ~~struck~~ word.\n", "A struck word.\n");
    expect(res.status).toBe("no_visible_changes");
  });

  it("never renders strike delimiters as an edit when struck text changes", () => {
    const res = buildTrackChanges("We ~~ship Friday~~ soon.\n", "We ~~ship Monday~~ soon.\n");
    expect(res.status).toBe("changed");
    // The words move; the syntax never appears as inserted or deleted text.
    for (const mark of res.markdown.match(/<(ins|del)>([\s\S]*?)<\/\1>/g) ?? []) {
      expect(mark).not.toContain("~");
    }
  });

  it("keeps a lone tilde as ordinary text", () => {
    expect(buildTrackChanges("Takes ~5 minutes.\n", "Takes ~5 minutes.\n").status).toBe(
      "no_visible_changes",
    );
    expect(buildTrackChanges("Takes ~5 minutes.\n", "Takes ~9 minutes.\n").status).toBe("changed");
  });

  it("reads a front-matter-only change as no visible change", () => {
    const base = "---\ntitle: Old\n---\n\nBody stays.\n";
    const target = "---\ntitle: New\n---\n\nBody stays.\n";
    expect(buildTrackChanges(base, target).status).toBe("no_visible_changes");
  });

  it("reads identical documents as no visible change", () => {
    expect(buildTrackChanges("Same.\n", "Same.\n").status).toBe("no_visible_changes");
  });

  it("reads a reflow (hard wrap moved) as no visible change", () => {
    expect(buildTrackChanges("One two three four.\n", "One two\nthree four.\n").status).toBe(
      "no_visible_changes",
    );
  });
});

describe("buildTrackChanges — structure that must not break", () => {
  it("passes the target's front matter through untouched", () => {
    const base = "---\ntitle: Doc\n---\n\nOld body.\n";
    const target = "---\ntitle: Doc\n---\n\nNew body.\n";
    const res = buildTrackChanges(base, target);
    expect(res.markdown.startsWith("---\ntitle: Doc\n---\n")).toBe(true);
  });

  it("renders a changed code block as marked code, never as inline syntax", () => {
    const base = "```js\nconst a = 1;\n```\n";
    const target = "```js\nconst a = 2;\n```\n";
    const res = buildTrackChanges(base, target);
    expect(res.status).toBe("changed");
    expect(res.markdown).toContain("th-del-block");
    expect(res.markdown).toContain("th-ins-block");
    expect(res.markdown).not.toContain("<del");
  });

  it("keeps blocks separated so a deletion never merges into its neighbour", () => {
    const res = buildTrackChanges("One.\n\nTwo.\n\nThree.\n", "One.\n\nThree.\n");
    expect(res.markdown).toMatch(/One\.\n\n.*Two\..*\n\nThree\./s);
  });

  it("replaces a wholesale rewrite instead of interleaving word fragments", () => {
    // A word diff of two sentences that merely SHARE a few words produces
    // "Support has ~~not~~ now ~~seen~~ walked ~~through~~ the tool" — word
    // salad. Past a churn threshold the old text is struck through as a whole
    // and the new text follows, which is what track changes has always done.
    const base =
      "Support has not seen the migration tool yet, so we are guessing at ticket load.\n";
    const target =
      "Support has now walked the migration tool, so the ticket estimate is a real number.\n";
    const res = buildTrackChanges(base, target);
    expect(marks(res.markdown, "del")).toEqual([
      "Support has not seen the migration tool yet, so we are guessing at ticket load.",
    ]);
    expect(marks(res.markdown, "ins")).toEqual([
      "Support has now walked the migration tool, so the ticket estimate is a real number.",
    ]);
  });

  it("keeps a soft-wrapped paragraph as ONE paragraph when it is replaced", () => {
    // Emitting a wrapped paragraph line-by-line splits it into that many
    // paragraphs on screen — a wall of separated fragments, not a document.
    const base = "Alpha beta gamma delta epsilon.\nZeta eta theta iota kappa.\n";
    const target = "Totally different words here now.\nAnd a second unrelated line.\n";
    const res = buildTrackChanges(base, target);
    expect(res.markdown.split("\n\n")).toHaveLength(2); // one del block, one ins block
  });

  it("counts insertions and deletions for the summary", () => {
    const res = buildTrackChanges("alpha beta\n", "alpha gamma\n");
    expect(res.insertions).toBeGreaterThan(0);
    expect(res.deletions).toBeGreaterThan(0);
  });

  it("handles a large rewrite without hanging", () => {
    const base = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of the old plan.`).join(
      "\n\n",
    );
    const target = Array.from({ length: 400 }, (_, i) => `Section ${i} of the new plan.`).join(
      "\n\n",
    );
    const started = Date.now();
    const res = buildTrackChanges(base, target);
    expect(res.status).toBe("changed");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});