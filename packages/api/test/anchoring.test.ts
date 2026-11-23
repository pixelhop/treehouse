import { describe, expect, it } from "vite-plus/test";
import {
  type AnchorRecord,
  projectMarkdown,
  resolveAnchor,
  resolveNewAnchor,
} from "../server/utils/anchoring";

// ---------------------------------------------------------------------------
// Pure-module tests: no env, no database. The fixture is a realistic markdown
// document exercising front matter, headings, emphasis, links, lists, and a
// fenced code block, because the resolver matches in projection space and the
// projection is where offset bugs hide.
// ---------------------------------------------------------------------------

const DOC = `---
title: Launch plan
owner: jozef
---

# Launch plan

We ship the new onboarding flow in **March**. The rollout starts with a
small cohort and expands weekly.

## Timeline

- Kickoff happens after the platform review.
- The beta deadline is the last Friday of March.
- Docs land in the [handbook](https://example.com/handbook).

## Risks

Deadline: TBD

The migration script must be idempotent, because retries are expected
under load. See **the deadline** section above.

\`\`\`js
const cohortSize = 25;
\`\`\`

Final note: ship it.
`;

const HASH = "hash-of-doc";

/** Create a real AnchorRecord by running the create path against a document. */
function mkAnchor(
  doc: string,
  quote: string,
  opts: {
    contextBefore?: string;
    contextAfter?: string;
    occurrence?: number;
    kind?: "range" | "point";
  } = {},
): AnchorRecord {
  const kind = opts.kind ?? "range";
  const m = resolveNewAnchor({ quote, kind, ...opts }, doc);
  if (m.status !== "matched") throw new Error(`fixture anchor did not match: ${m.status}`);
  return {
    kind,
    quote: m.quote!,
    contextBefore: m.contextBefore!,
    contextAfter: m.contextAfter!,
    sourceStart: m.start!,
    sourceEnd: m.end!,
  };
}

describe("resolveAnchor cascade", () => {
  it("1. quote removed in the new version resolves as outdated", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    const v2 = DOC.replace(
      "The migration script must be idempotent, because retries are expected\nunder load. ",
      "",
    );
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("outdated");
    expect(r.start).toBeUndefined();
    expect(r.resolvedForHash).toBe("hash-v2");
  });

  it("2. exact offset with matching context on the pinned version anchors with confidence 1", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    const r = resolveAnchor(anchor, DOC, HASH);
    expect(r.status).toBe("anchored");
    expect(r.confidence).toBe(1);
    expect(r.start).toBe(anchor.sourceStart);
    expect(r.end).toBe(anchor.sourceEnd);
    expect(r.currentText).toBe(anchor.quote);
    expect(r.resolvedForHash).toBe(HASH);
  });

  it("3. bytes matching at the stored offset without context corroboration do not anchor (short quote)", () => {
    const anchor = mkAnchor(DOC, "TBD", { contextBefore: "Deadline: " });
    // Rewrite the "Deadline:" label to an equally long, unrelated one so the
    // raw bytes "TBD" still sit at the exact recorded offset but the context
    // around them no longer corroborates.
    expect("Deadline:".length).toBe("Owner ETA".length);
    const v2 = DOC.replace("Deadline: TBD", "Owner ETA TBD");
    expect(v2.slice(anchor.sourceStart, anchor.sourceEnd)).toBe("TBD");
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("outdated");
  });

  it("4. text moved wholesale is found by context-assisted matching", () => {
    const para =
      "The migration script must be idempotent, because retries are expected\nunder load. See **the deadline** section above.\n";
    const anchor = mkAnchor(DOC, "because retries are expected");
    const v2 = DOC.replace(`${para}\n`, "") + `\n${para}`;
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("anchored");
    expect(r.start).not.toBe(anchor.sourceStart);
    expect(r.currentText).toContain("retries are expected");
  });

  it("5. a small in-quote edit fuzzy-matches with reduced confidence", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    const v2 = DOC.replace("must be idempotent", "must be fully idempotent");
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("anchored");
    expect(r.confidence).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    expect(r.currentText).toContain("idempotent");
  });

  it("6. a quote duplicated 3x with no distinguishing context is ambiguous", () => {
    const sentence = "Everything is measured twice and cut once.";
    const v1 = `# Notes\n\nUnique intro line here.\n${sentence}\n`;
    const anchor = mkAnchor(v1, sentence);
    const v2 = `# Notes\n\n${sentence}\n${sentence}\n${sentence}\n`;
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("ambiguous");
    expect(r.start).toBeUndefined();
  });

  it("6b. the create path reports the occurrence count for an ambiguous quote", () => {
    const sentence = "Everything is measured twice and cut once.";
    const doc = `${sentence}\n${sentence}\n${sentence}\n`;
    const m = resolveNewAnchor({ quote: sentence, kind: "range" }, doc);
    expect(m.status).toBe("ambiguous");
    expect(m.occurrences).toBe(3);
  });

  it("7. a duplicated quote with unique context anchors at the right occurrence", () => {
    const sentence = "Everything is measured twice and cut once.";
    const v1 = `# Notes\n\nAbout the pears specifically:\n${sentence}\n`;
    const anchor = mkAnchor(v1, sentence);
    const v2 = `# Notes\n\nAbout the apples specifically:\n${sentence}\n\nAbout the pears specifically:\n${sentence}\n`;
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("anchored");
    expect(r.start).toBe(v2.lastIndexOf(sentence));
  });

  it("7b. the occurrence index selects among true duplicates on create", () => {
    const sentence = "Everything is measured twice and cut once.";
    const doc = `${sentence}\n${sentence}\n${sentence}\n`;
    const m = resolveNewAnchor({ quote: sentence, kind: "range", occurrence: 2 }, doc);
    expect(m.status).toBe("matched");
    expect(m.start).toBe(doc.indexOf(sentence, 1));
  });

  it("8. a short quote resolves via intact context, and goes outdated when context changes", () => {
    const anchor = mkAnchor(DOC, "TBD", { contextBefore: "Deadline: " });
    // Edit elsewhere only: context around the short quote intact -> anchored.
    const v2 = DOC.replace("Final note: ship it.", "Final note: hold it.");
    const ok = resolveAnchor(anchor, v2, "hash-v2");
    expect(ok.status).toBe("anchored");
    expect(ok.currentText).toBe("TBD");
    // Context changed on BOTH sides. The quote text still exists in the doc,
    // so an unguarded fuzzy/exact scan WOULD find it — outdated here proves by
    // construction that no fuzzy stage ran for the sub-minimum-length quote.
    const v3 = DOC.replace("Deadline: TBD\n\nThe migration", "Owner ETA TBD\n\nA migration");
    const r3 = resolveAnchor(anchor, v3, "hash-v3");
    expect(r3.status).toBe("outdated");
  });

  it("9. whitespace reflow and NFC-vs-decomposed unicode still match", () => {
    const doc = `${DOC}\nTeam café notes live at the end.\n`;
    const anchor = mkAnchor(doc, "café notes");
    // Reflow the paragraph (line wrap moved, double spaces) and decompose the
    // accent (e + combining acute) — the normalized projection must not care.
    const v2 = doc
      .replace(
        "The migration script must be idempotent, because retries are expected\nunder load.",
        "The migration script must be idempotent,  because retries\nare expected under load.",
      )
      .replace("café", "café");
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("anchored");
    expect(r.currentText).toContain("café");
    // And the reflowed quote itself still anchors.
    const anchor2 = mkAnchor(doc, "because retries are expected under load");
    const r2 = resolveAnchor(anchor2, v2, "hash-v2");
    expect(r2.status).toBe("anchored");
  });
});

describe("resolveNewAnchor rendered-text bridge", () => {
  it("10a. a quote spanning bold syntax matches and returns the raw slice", () => {
    const m = resolveNewAnchor({ quote: "See the deadline", kind: "range" }, DOC);
    expect(m.status).toBe("matched");
    expect(m.quote).toBe("See **the deadline");
    expect(DOC.slice(m.start!, m.end!)).toBe("See **the deadline");
  });

  it("10b. link label text matches inside [label](url)", () => {
    const m = resolveNewAnchor({ quote: "in the handbook", kind: "range" }, DOC);
    expect(m.status).toBe("matched");
    expect(DOC.slice(m.start!, m.end!)).toBe("in the [handbook");
  });

  it("10c. heading text matches without the marker", () => {
    const m = resolveNewAnchor({ quote: "Launch plan", kind: "range" }, DOC);
    expect(m.status).toBe("matched");
    expect(DOC.slice(m.start!, m.end!)).toBe("Launch plan");
    // The match is the H1 body, not the front-matter title (which projects away).
    expect(m.start).toBe(DOC.indexOf("# Launch plan") + 2);
  });

  it("10e. a wikilink matches as the label the viewer shows", () => {
    const doc = "See [[Plan|the plan]] today, then [[Budget#Q3]] and [[Notes]].";
    const alias = resolveNewAnchor({ quote: "See the plan today", kind: "range" }, doc);
    expect(alias.status).toBe("matched");
    expect(doc.slice(alias.start!, alias.end!)).toBe("See [[Plan|the plan]] today");
    const heading = resolveNewAnchor({ quote: "then Budget > Q3 and", kind: "range" }, doc);
    expect(heading.status).toBe("matched");
    expect(doc.slice(heading.start!, heading.end!)).toBe("then [[Budget#Q3]] and");
    const plain = resolveNewAnchor({ quote: "and Notes.", kind: "range" }, doc);
    expect(doc.slice(plain.start!, plain.end!)).toBe("and [[Notes]].");
  });

  it("10f. a selection ending or starting inside a wikilink takes in the whole link", () => {
    const doc = "The reasoning is in [[Why Postgres|the database decision]]. Done.";
    const whole = "[[Why Postgres|the database decision]]";
    const ending = resolveNewAnchor(
      { quote: "reasoning is in the database decision", kind: "range" },
      doc,
    );
    expect(ending.quote).toBe(`reasoning is in ${whole}`);
    const starting = resolveNewAnchor({ quote: "database decision. Done.", kind: "range" }, doc);
    expect(starting.quote).toBe(`${whole}. Done.`);
    const inside = resolveNewAnchor({ quote: "the database", kind: "range" }, doc);
    expect(inside.quote).toBe(whole);
  });

  it("10d. a raw-markdown quote with syntax characters also matches", () => {
    const m = resolveNewAnchor({ quote: "See **the deadline**", kind: "range" }, DOC);
    expect(m.status).toBe("matched");
    expect(DOC.slice(m.start!, m.end!)).toContain("the deadline");
  });
});

describe("point anchors", () => {
  it("11a. a point anchor with unchanged context re-anchors at the caret", () => {
    const m = resolveNewAnchor(
      { quote: "", kind: "point", contextBefore: "expands weekly.", contextAfter: "## Timeline" },
      DOC,
    );
    expect(m.status).toBe("matched");
    expect(m.start).toBe(m.end);
    const anchor: AnchorRecord = {
      kind: "point",
      quote: "",
      contextBefore: m.contextBefore!,
      contextAfter: m.contextAfter!,
      sourceStart: m.start!,
      sourceEnd: m.end!,
    };
    const r = resolveAnchor(anchor, DOC, HASH);
    expect(r.status).toBe("anchored");
    expect(r.start).toBe(anchor.sourceStart);
  });

  it("11b. a point anchor whose context is duplicated across list items is ambiguous", () => {
    // Items longer than the point-context window (~96 chars), so the stored
    // context is entirely inside the duplicated block and cannot distinguish.
    const itemA = `- ${"alpha beta gamma delta ".repeat(5).trim()}`;
    const itemB = `- ${"omega psi chi phi ".repeat(6).trim()}`;
    const v1 = `# List\n\n${itemA}\n${itemB}\n`;
    const m = resolveNewAnchor(
      { quote: "", kind: "point", contextBefore: "gamma delta", contextAfter: "omega psi chi phi" },
      v1,
    );
    expect(m.status).toBe("matched");
    const anchor: AnchorRecord = {
      kind: "point",
      quote: "",
      contextBefore: m.contextBefore!,
      contextAfter: m.contextAfter!,
      sourceStart: m.start!,
      sourceEnd: m.end!,
    };
    const v2 = `# List\n\n${itemA}\n${itemB}\n${itemA}\n${itemB}\n`;
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("ambiguous");
  });
});

describe("properties", () => {
  it("12. resolution is deterministic and unaffected by resolving other anchors", () => {
    const a = mkAnchor(DOC, "The migration script must be idempotent");
    const b = mkAnchor(DOC, "small cohort and expands weekly");
    const v2 = DOC.replace("must be idempotent", "must be fully idempotent");
    const first = resolveAnchor(a, v2, "hash-v2");
    resolveAnchor(b, v2, "hash-v2");
    resolveAnchor(b, DOC, HASH);
    const second = resolveAnchor(a, v2, "hash-v2");
    const third = resolveAnchor(a, v2, "hash-v2");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("13. under 20 sequential edits the anchor is never confidently elsewhere", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    // Scripted drift: edits 1-12 touch everything BUT the anchored sentence;
    // edits 13-20 progressively destroy it. Each step re-resolves from the
    // ORIGINAL record (purity invariant: no resolved range feeds back).
    const edits: Array<[string, string]> = [
      ["# Launch plan", "# Launch plan v2"],
      ["We ship the new onboarding flow", "We ship the revised onboarding flow"],
      ["small cohort and expands weekly", "tiny cohort and expands twice weekly"],
      ["## Timeline", "## Rollout timeline"],
      ["Kickoff happens after the platform review.", "Kickoff happens after the infra review."],
      ["The beta deadline is the last Friday of March.", "The beta deadline is mid-April."],
      ["https://example.com/handbook", "https://example.com/hb"],
      ["## Risks", "## Open risks"],
      ["Deadline: TBD", "Deadline: April 2"],
      ["const cohortSize = 25;", "const cohortSize = 50;"],
      ["Final note: ship it.", "Final note: ship it soon."],
      ["in **March**", "in **April**"],
      // Now degrade the anchored sentence itself.
      ["The migration script must be idempotent", "The migration job must be idempotent"],
      ["The migration job must be idempotent", "The migration job should be idempotent"],
      ["because retries are expected\nunder load", "because retries happen under load"],
      ["See **the deadline** section above.", "See above."],
      [
        "The migration job should be idempotent, because retries happen under load. See above.",
        "Retries happen; plan for them.",
      ],
      ["Retries happen; plan for them.", "Retries happen."],
      ["Retries happen.", ""],
      ["Final note: ship it soon.", "Final note."],
    ];
    let doc = DOC;
    let step = 0;
    for (const [find, replace] of edits) {
      step += 1;
      expect(doc).toContain(find); // the script itself must stay coherent
      doc = doc.replace(find, replace);
      const r = resolveAnchor(anchor, doc, `hash-step-${step}`);
      if (r.status === "anchored") {
        // If it claims a location, that location must still be about the
        // original text — never a confident match on unrelated content.
        expect(r.currentText).toContain("idempotent");
      }
      if (step >= 17) {
        // The sentence is gone entirely: anchoring anywhere would be silent
        // mis-anchoring, the stop-condition failure mode.
        expect(r.status).not.toBe("anchored");
      }
    }
  });

  it("13b. a merely similar decoy sentence with alien context is not anchored", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    // The real sentence is deleted; a similar-but-different one appears
    // elsewhere with completely different surroundings. Anchoring to it would
    // be silent mis-anchoring.
    const v2 = DOC.replace(
      "The migration script must be idempotent, because retries are expected\nunder load. ",
      "",
    ).replace("Final note: ship it.", "Final note: the aggregation script must be idempotent too.");
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("outdated");
  });

  it("13c. a near-identical quote is recovered by quote-only fuzzy when all context is gone", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    // Rewritten document: none of the stored context survives, but the quote
    // itself is present with a single-char typo.
    const v2 = "Completely new intro.\n\nThe migration script must be idempotant here.\n";
    const r = resolveAnchor(anchor, v2, "hash-v2");
    expect(r.status).toBe("anchored");
    expect(r.confidence).toBeLessThan(1);
    expect(r.currentText).toContain("migration script");
  });

  it("14. degenerate inputs never throw", () => {
    const anchor = mkAnchor(DOC, "The migration script must be idempotent");
    expect(resolveAnchor(anchor, "", "h").status).toBe("outdated");
    const emptyQuote: AnchorRecord = {
      kind: "range",
      quote: "",
      contextBefore: "x",
      contextAfter: "y",
      sourceStart: 0,
      sourceEnd: 0,
    };
    expect(resolveAnchor(emptyQuote, DOC, "h").status).toBe("outdated");
    const longQuote: AnchorRecord = {
      kind: "range",
      quote: DOC + DOC,
      contextBefore: "",
      contextAfter: "",
      sourceStart: 0,
      sourceEnd: (DOC + DOC).length,
    };
    expect(resolveAnchor(longQuote, "tiny", "h").status).toBe("outdated");
    expect(resolveNewAnchor({ quote: "", kind: "range" }, DOC).status).toBe("not_found");
    expect(resolveNewAnchor({ quote: "absent text", kind: "range" }, "").status).toBe("not_found");
    expect(resolveNewAnchor({ quote: DOC + DOC, kind: "range" }, "tiny").status).toBe("not_found");
  });
});

describe("projectMarkdown", () => {
  const fixtures: Record<string, string> = {
    doc: DOC,
    simple: "plain text\nwith two lines\n",
    syntax: "# H\n\n> quoted *emph* and `code` here\n\n1. first\n2. [x](y)\n",
  };

  it("15a. every projected char maps to the identical source char", () => {
    for (const [name, src] of Object.entries(fixtures)) {
      const { text, toSource } = projectMarkdown(src);
      expect(toSource.length, name).toBe(text.length);
      for (let i = 0; i < text.length; i++) {
        expect(src[toSource[i]], `${name}@${i}`).toBe(text[i]);
      }
      // Offsets must be strictly increasing: projection preserves order.
      for (let i = 1; i < toSource.length; i++) {
        expect(toSource[i], `${name} order @${i}`).toBeGreaterThan(toSource[i - 1]);
      }
    }
  });

  it("15b. front matter projects to nothing and syntax markers are stripped", () => {
    const { text } = projectMarkdown(DOC);
    expect(text).not.toContain("title: Launch plan");
    expect(text).not.toContain("owner: jozef");
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");
    expect(text).not.toContain("# Launch");
    expect(text).toContain("Launch plan");
    expect(text).toContain("the deadline");
    expect(text).toContain("handbook");
    expect(text).not.toContain("https://example.com");
    // Fenced code keeps its content but drops the fence lines.
    expect(text).toContain("const cohortSize = 25;");
    expect(text).not.toContain("```");
  });
});