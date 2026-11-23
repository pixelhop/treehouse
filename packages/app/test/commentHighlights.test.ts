// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createCommentUiState } from "../app/composables/useComments";
import {
  blockStartOffset,
  bucketThreads,
  buildTextIndex,
  capturePoint,
  captureRange,
  locatePoint,
  locateQuote,
  mergeThreadPages,
  normalizeForMatch,
  plainFromMarkdown,
  resolveSpan,
  resolvedWithoutChanges,
  spanForSelection,
  threadReplies,
} from "../app/utils/commentHighlights";
import { VIEWERS } from "../app/utils/viewers";
import { viewerContext } from "./viewerContext";

/** Render a fragment of HTML the way the reading view would hand it to us. */
function article(html: string): HTMLElement {
  const el = document.createElement("article");
  el.innerHTML = html;
  return el;
}

describe("plainFromMarkdown", () => {
  it("drops inline emphasis, code ticks, and link syntax", () => {
    expect(plainFromMarkdown("See **the deadline** in `config`")).toBe(
      "See the deadline in config",
    );
    expect(plainFromMarkdown("Read [the brief](/docs/brief.md) first")).toBe(
      "Read the brief first",
    );
    expect(plainFromMarkdown("![a chart](chart.png) follows")).toBe("a chart follows");
  });

  it("keeps intra-word underscores but drops emphasis ones", () => {
    expect(plainFromMarkdown("use snake_case not _that_")).toBe("use snake_case not that");
  });

  it("strips heading, list, and blockquote markers", () => {
    expect(
      normalizeForMatch(plainFromMarkdown("## Ship it\n\n- first\n- second\n\n> quoted")),
    ).toBe("Ship it first second quoted");
  });

  it("keeps escaped characters without their backslash", () => {
    expect(plainFromMarkdown("a \\*literal\\* star")).toBe("a *literal* star");
    expect(plainFromMarkdown("See [[Plan|the plan]] and [[Budget#Q3]], ![[x.png]]")).toBe(
      "See the plan and Budget > Q3, x.png",
    );
  });
});

describe("buildTextIndex", () => {
  it("flattens the rendered DOM and separates block elements", () => {
    const index = buildTextIndex(article("<p>The deadline is Friday.</p><p>Second block.</p>"));
    expect(index.text).toBe("The deadline is Friday. Second block.");
  });

  it("collapses whitespace runs the way the server's normalizer does", () => {
    const index = buildTextIndex(article("<p>one   two\n\tthree</p>"));
    expect(index.text).toBe("one two three");
  });

  it("maps every character back to its own text node and offset", () => {
    const index = buildTextIndex(article("<p>The <strong>deadline</strong> is Friday.</p>"));
    const at = index.text.indexOf("deadline");
    expect(index.nodes[at]?.data).toBe("deadline");
    expect(index.offsets[at]).toBe(0);
  });
});

describe("locateQuote", () => {
  const html = "<p>The <strong>deadline</strong> is Friday.</p><p>Ship the deadline early.</p>";

  it("finds a quote that spans inline formatting in the rendered DOM", () => {
    const index = buildTextIndex(article(html));
    // The stored quote is RAW markdown — the syntax characters are not in the DOM.
    const span = locateQuote(index, { quote: "The **deadline** is Friday" });
    expect(span).not.toBeNull();
    expect(index.text.slice(span!.start, span!.end)).toBe("The deadline is Friday");
  });

  it("resolves a located span to concrete DOM text nodes", () => {
    const index = buildTextIndex(article(html));
    const span = locateQuote(index, { quote: "The **deadline** is" })!;
    const dom = resolveSpan(index, span)!;
    expect(dom.start.node.data).toBe("The ");
    expect(dom.start.offset).toBe(0);
    expect(dom.end.node.data).toBe(" is Friday.");
    expect(dom.end.offset).toBe(3);
  });

  it("returns null for a quote that appears several times with no distinguishing context", () => {
    const index = buildTextIndex(article("<p>TBD here</p><p>TBD there</p><p>TBD everywhere</p>"));
    expect(locateQuote(index, { quote: "TBD" })).toBeNull();
  });

  it("picks the occurrence its context corroborates", () => {
    const index = buildTextIndex(article("<p>TBD here</p><p>TBD there</p><p>TBD everywhere</p>"));
    const span = locateQuote(index, { quote: "TBD", contextAfter: " there" })!;
    expect(span).not.toBeNull();
    expect(index.text.slice(span.start, span.end + 6)).toBe("TBD there");
  });

  it("returns null when the quote is gone from the current version", () => {
    const index = buildTextIndex(article("<p>Something else entirely.</p>"));
    expect(locateQuote(index, { quote: "The deadline is Friday" })).toBeNull();
  });
});

describe("captureRange / capturePoint", () => {
  it("captures the selected text plus context on both sides", () => {
    const index = buildTextIndex(article("<p>Alpha bravo charlie delta echo foxtrot.</p>"));
    const start = index.text.indexOf("charlie");
    const capture = captureRange(index, { start, end: start + "charlie".length });
    expect(capture.quote).toBe("charlie");
    expect(capture.contextBefore).toBe("Alpha bravo ");
    expect(capture.contextAfter).toBe(" delta echo foxtrot.");
  });

  it("derives a span from a DOM selection across inline formatting", () => {
    const el = article("<p>The <strong>deadline</strong> is Friday.</p>");
    const index = buildTextIndex(el);
    const strong = el.querySelector("strong")!.firstChild as Text;
    const tail = el.querySelector("p")!.lastChild as Text;
    const span = spanForSelection(index, {
      startContainer: strong,
      startOffset: 0,
      endContainer: tail,
      endOffset: 3,
    })!;
    expect(index.text.slice(span.start, span.end)).toBe("deadline is");
  });

  it("captures context on both sides of a point", () => {
    const index = buildTextIndex(article("<p>Alpha bravo.</p><p>Charlie delta.</p>"));
    const at = index.text.indexOf("Charlie");
    const capture = capturePoint(index, at);
    expect(capture.contextBefore).toBe("Alpha bravo. ");
    expect(capture.contextAfter).toBe("Charlie delta.");
  });

  it("places a point marker at the start of a block's text", () => {
    const el = article("<p>Alpha bravo.</p><p>Charlie delta.</p>");
    const index = buildTextIndex(el);
    const second = el.querySelectorAll("p")[1]!;
    expect(blockStartOffset(index, second)).toBe(index.text.indexOf("Charlie"));
  });
});

describe("locatePoint", () => {
  it("finds the caret between two unique contexts", () => {
    const index = buildTextIndex(article("<p>Alpha bravo.</p><p>Charlie delta.</p>"));
    expect(locatePoint(index, { contextBefore: "Alpha bravo.", contextAfter: "Charlie" })).toBe(
      index.text.indexOf("Charlie"),
    );
  });

  it("refuses to guess when the same context repeats", () => {
    const index = buildTextIndex(article("<li>same thing</li><li>same thing</li>"));
    expect(locatePoint(index, { contextBefore: "same ", contextAfter: "thing" })).toBeNull();
  });
});

describe("panel bucketing", () => {
  const thread = (over: Record<string, unknown> = {}) => ({
    status: "open" as const,
    anchorStatus: "anchored" as const,
    pinnedVersion: 3,
    resolvedAtVersion: null,
    ...over,
  });

  it("splits open, resolved, and the outdated tray", () => {
    const threads = [
      thread(),
      thread({ anchorStatus: "outdated" }),
      thread({ anchorStatus: "ambiguous" }),
      thread({ status: "resolved", resolvedAtVersion: 4 }),
      thread({ status: "resolved", anchorStatus: "outdated", resolvedAtVersion: 4 }),
    ];
    const buckets = bucketThreads(threads);
    expect(buckets.open).toHaveLength(1);
    // Ambiguous joins outdated in the tray — presented, never guessed into place.
    expect(buckets.tray).toHaveLength(2);
    expect(buckets.resolved).toHaveLength(2);
  });

  it("flags a resolution stamped at the thread's own creation version", () => {
    expect(
      resolvedWithoutChanges(
        thread({ status: "resolved", pinnedVersion: 3, resolvedAtVersion: 3 }),
      ),
    ).toBe(true);
    expect(
      resolvedWithoutChanges(
        thread({ status: "resolved", pinnedVersion: 3, resolvedAtVersion: 4 }),
      ),
    ).toBe(false);
    expect(resolvedWithoutChanges(thread())).toBe(false);
  });
});

describe("lifted interaction state", () => {
  it("keeps the focused thread across an edit-mode toggle (same path)", () => {
    const ui = createCommentUiState();
    ui.resetForPath("notes.md");
    ui.focusThread("t1");
    // Toggling edit destroys the viewer but not the workspace-level state; the
    // path is unchanged, so nothing resets.
    ui.resetForPath("notes.md");
    expect(ui.activeThreadId.value).toBe("t1");
    ui.resetForPath("other.md");
    expect(ui.activeThreadId.value).toBeNull();
  });

  it("keeps a reply draft while the thread changes state underneath it", () => {
    const ui = createCommentUiState();
    ui.setComposer("t1", "half a reply");
    ui.focusThread("t2");
    ui.focusThread("t1");
    expect(ui.composerFor("t1")).toBe("half a reply");
    ui.clearComposer("t1");
    expect(ui.composerFor("t1")).toBe("");
  });

  it("never discards a create draft on anchor failure", () => {
    const ui = createCommentUiState();
    ui.startDraft({
      path: "notes.md",
      kind: "range",
      quote: "TBD",
      contextBefore: "",
      contextAfter: "",
      baseVersion: 3,
    });
    ui.draft.value!.body = "this needs a date";
    ui.failDraft("anchor_ambiguous", 3);
    expect(ui.draft.value?.body).toBe("this needs a date");
    expect(ui.draft.value?.error).toBe("anchor_ambiguous");
    expect(ui.draft.value?.occurrences).toBe(3);
  });
});

describe("paged threads and replies", () => {
  const t = (id: string) => ({ id });
  const e = (id: string, createdAt: string) => ({ id, createdAt });

  it("concatenates thread pages in order", () => {
    const merged = mergeThreadPages([{ threads: [t("a"), t("b")] }, { threads: [t("c")] }]);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("shows a thread once when a concurrent insert shifts it across two pages", () => {
    // Pages are offset windows over a createdAt ordering, so a thread created
    // between the two reads slides `b` down into the second page as well.
    const merged = mergeThreadPages([{ threads: [t("a"), t("b")] }, { threads: [t("b"), t("c")] }]);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("appends a pulled reply page and counts the rest down", () => {
    const thread = { entries: [e("r1", "2026-01-01T00:00:00Z")], entryCount: 3 };
    expect(threadReplies(thread, []).shown).toHaveLength(1);
    expect(threadReplies(thread, []).remaining).toBe(2);

    const next = threadReplies(thread, [
      e("r2", "2026-01-01T00:01:00Z"),
      e("r3", "2026-01-01T00:02:00Z"),
    ]);
    expect(next.shown.map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
    expect(next.remaining).toBe(0);
  });

  it("keeps replies in server order and never doubles one already on screen", () => {
    // A reply that lands between the list refresh and a tail read is in both.
    const thread = { entries: [e("r1", "2026-01-01T00:00:00Z")], entryCount: 2 };
    const merged = threadReplies(thread, [
      e("r2", "2026-01-01T00:01:00Z"),
      e("r1", "2026-01-01T00:00:00Z"),
    ]);
    expect(merged.shown.map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(merged.remaining).toBe(0);
  });

  it("keeps a thread's pulled replies while the poll refreshes underneath", () => {
    const ui = createCommentUiState();
    ui.resetForPath("notes.md");
    ui.appendEntries("t1", [e("r21", "2026-01-01T00:21:00Z")]);
    expect(ui.entriesFor("t1")).toHaveLength(1);
    // Same file (a poll landed, edit mode toggled): the reader stays put.
    ui.resetForPath("notes.md");
    expect(ui.entriesFor("t1")).toHaveLength(1);
    ui.resetForPath("other.md");
    expect(ui.entriesFor("t1")).toHaveLength(0);
  });
});

describe("portal safety (AE7)", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the shared markdown viewer imports nothing from the comments module", () => {
    const src = read("../app/components/viewers/MarkdownViewer.vue");
    expect(src).not.toMatch(/commentHighlights|useComments|CommentsPanel|CommentedMarkdownViewer/);
  });

  // FileViewer is shared with the public share surface, so the overlay is
  // opt-in by workspace id rather than implied by the component. The share view
  // must never pass one: `fileSource.key` is a share TOKEN there, so inferring
  // a workspace from it would put member review threads on a client-facing page.
  it("the public share view never opts into the comment overlay", () => {
    const src = read("../app/components/ShareView.vue");
    expect(src).toContain("<FileViewer");
    expect(src).not.toMatch(/comments-workspace-id|commentsWorkspaceId/);
    expect(src).not.toMatch(/Comment/);
  });

  it("the comment overlay is reached only through an explicit workspace id", () => {
    // The wrapper is gated on the opt-in prop, and the bare viewer is the
    // fallback — so a caller that passes nothing cannot render comment UI.
    // FileViewer renders whatever the markdown entry picks (utils/viewers.ts).
    const bare = VIEWERS.markdown.render(viewerContext({ commentsWorkspaceId: null }));
    const commented = VIEWERS.markdown.render(viewerContext({ commentsWorkspaceId: "w1" }));
    expect(bare.props).not.toHaveProperty("workspaceId");
    expect(commented.props).toMatchObject({ workspaceId: "w1", path: "notes.md", version: 3 });
    expect(commented.component).not.toBe(bare.component);
  });
});