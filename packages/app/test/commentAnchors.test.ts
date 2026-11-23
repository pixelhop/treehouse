// @vitest-environment happy-dom
// The editor-side twin of commentHighlights.test.ts: the same anchors, resolved
// against a ProseMirror document instead of the rendered DOM. What is worth
// pinning down here is the offset -> position mapping (block boundaries and
// inline marks are where a naive `indexOf` on `doc.textContent` goes wrong) and
// the promise that a decoration tracks keystrokes rather than being re-matched
// against a buffer nobody has saved.
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";
import {
  type AnchorThread,
  anchorAvailability,
  buildDocTextIndex,
  CommentAnchors,
  commentAnchorDecorations,
  docRangeForSpan,
  placeThreads,
  spanForDocRange,
  syncCommentAnchors,
} from "../app/components/editors/commentAnchors";
import { locateQuote } from "../app/utils/commentHighlights";
import { wikilinkNode } from "../app/utils/editorWikilink";

function makeEditor(markdown: string, onOpen: (id: string) => void = () => {}) {
  return new Editor({
    element: document.createElement("div"),
    content: markdown,
    contentType: "markdown",
    extensions: [
      StarterKit,
      Markdown,
      wikilinkNode(() => null),
      CommentAnchors.configure({ onOpen }),
    ],
  });
}

/** A server thread payload reduced to the fields the placer reads. */
function thread(over: Partial<AnchorThread> & { id: string }): AnchorThread {
  return {
    status: "open",
    anchorStatus: "anchored",
    anchorKind: "range",
    quote: "",
    currentText: null,
    contextBefore: "",
    contextAfter: "",
    ...over,
  };
}

describe("buildDocTextIndex", () => {
  it("separates block nodes the way the server's projection does", () => {
    const ed = makeEditor("# Ship it\n\nThe deadline is Friday.\n\n- first\n- second");
    expect(buildDocTextIndex(ed.state.doc).text).toBe(
      "Ship it The deadline is Friday. first second",
    );
    ed.destroy();
  });

  it("reads a wikilink as its label, covering the whole link", () => {
    const ed = makeEditor("See [[Plan|the plan]] today.");
    const index = buildDocTextIndex(ed.state.doc);
    expect(index.text).toBe("See the plan today.");
    const range = docRangeForSpan(index, locateQuote(index, { quote: "the plan" })!)!;
    const slice = ed.state.doc.slice(range.from, range.to).content;
    expect(slice.childCount).toBe(1);
    expect(slice.firstChild?.type.name).toBe("wikilink");
    ed.destroy();
  });

  it("maps an offset span back to the document positions it covers", () => {
    const ed = makeEditor("The **deadline** is Friday.");
    const index = buildDocTextIndex(ed.state.doc);
    const span = locateQuote(index, { quote: "deadline is" });
    expect(span).not.toBeNull();
    const range = docRangeForSpan(index, span!)!;
    expect(ed.state.doc.textBetween(range.from, range.to)).toBe("deadline is");
    ed.destroy();
  });

  it("maps a span that crosses a block boundary", () => {
    const ed = makeEditor("Ends here.\n\nStarts there.");
    const index = buildDocTextIndex(ed.state.doc);
    const span = locateQuote(index, { quote: "here. Starts" });
    const range = docRangeForSpan(index, span!)!;
    // textBetween without a block separator concatenates the two blocks.
    expect(ed.state.doc.textBetween(range.from, range.to, " ")).toBe("here. Starts");
    ed.destroy();
  });

  it("round-trips a document selection back to an offset span", () => {
    const ed = makeEditor("The **deadline** is Friday.");
    const index = buildDocTextIndex(ed.state.doc);
    const span = docRangeForSpan(index, locateQuote(index, { quote: "deadline" })!)!;
    expect(spanForDocRange(index, span.from, span.to)).toEqual(
      locateQuote(index, { quote: "deadline" }),
    );
    ed.destroy();
  });
});

describe("placeThreads", () => {
  it("places an anchored range on the text it matches now", () => {
    const ed = makeEditor("Alpha.\n\nThe deadline is Friday.");
    const index = buildDocTextIndex(ed.state.doc);
    const placed = placeThreads(index, [
      thread({ id: "t1", quote: "the deadline", currentText: "deadline is Friday" }),
    ]);
    expect(placed).toHaveLength(1);
    expect(ed.state.doc.textBetween(placed[0]!.from, placed[0]!.to)).toBe("deadline is Friday");
    ed.destroy();
  });

  it("places a point anchor at the caret its context names", () => {
    const ed = makeEditor("Alpha beta gamma.");
    const index = buildDocTextIndex(ed.state.doc);
    const placed = placeThreads(index, [
      thread({ id: "p1", anchorKind: "point", contextBefore: "Alpha ", contextAfter: "beta" }),
    ]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.kind).toBe("point");
    expect(placed[0]!.from).toBe(placed[0]!.to);
    expect(ed.state.doc.textBetween(placed[0]!.from, placed[0]!.from + 4)).toBe("beta");
    ed.destroy();
  });

  it("skips resolved threads and anything the server could not re-attach", () => {
    const ed = makeEditor("The deadline is Friday.");
    const index = buildDocTextIndex(ed.state.doc);
    expect(
      placeThreads(index, [
        thread({ id: "r", status: "resolved", currentText: "deadline" }),
        thread({ id: "o", anchorStatus: "outdated", quote: "deadline" }),
        thread({ id: "a", anchorStatus: "ambiguous", quote: "deadline" }),
      ]),
    ).toEqual([]);
    ed.destroy();
  });

  it("leaves a thread unplaced when its text is not in this buffer", () => {
    const ed = makeEditor("The deadline is Friday.");
    const index = buildDocTextIndex(ed.state.doc);
    expect(placeThreads(index, [thread({ id: "x", currentText: "no such words" })])).toEqual([]);
    ed.destroy();
  });
});

describe("decorations across edits", () => {
  const threads = [
    thread({ id: "t1", quote: "deadline is Friday", currentText: "deadline is Friday" }),
  ];

  function paint(markdown: string) {
    const ed = makeEditor(markdown);
    syncCommentAnchors(ed.view, { threads, activeId: null, stale: false });
    return ed;
  }

  function only(ed: Editor) {
    const found = commentAnchorDecorations(ed.state).find();
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it("paints the anchored range", () => {
    const ed = paint("The deadline is Friday.");
    const d = only(ed);
    expect(ed.state.doc.textBetween(d.from, d.to)).toBe("deadline is Friday");
    ed.destroy();
  });

  it("survives typing before the highlighted range", () => {
    const ed = paint("The deadline is Friday.");
    const before = only(ed);
    ed.view.dispatch(ed.state.tr.insertText("Note: ", 1));
    const after = only(ed);
    expect(after.from).toBe(before.from + 6);
    expect(ed.state.doc.textBetween(after.from, after.to)).toBe("deadline is Friday");
    ed.destroy();
  });

  it("grows with typing inside the highlighted range, but not at its edges", () => {
    const ed = paint("The deadline is Friday.");
    const before = only(ed);
    ed.view.dispatch(ed.state.tr.insertText("real ", before.from + 9));
    expect(ed.state.doc.textBetween(only(ed).from, only(ed).to)).toBe("deadline real is Friday");
    // A word typed against the leading edge is NOT swallowed by the quote: the
    // highlight says what the comment was about, not wherever the caret was.
    ed.view.dispatch(ed.state.tr.insertText("new ", only(ed).from));
    expect(ed.state.doc.textBetween(only(ed).from, only(ed).to)).toBe("deadline real is Friday");
    ed.destroy();
  });

  it("keeps the tracked position when the buffer goes dirty, and only restyles", () => {
    const ed = paint("The deadline is Friday.");
    ed.view.dispatch(ed.state.tr.insertText("very ", only(ed).from + 9));
    const dirtyAt = only(ed);
    // The dirty buffer's text no longer matches the anchor; a re-match would
    // drop the highlight. It must survive on its mapped position instead.
    syncCommentAnchors(ed.view, { threads, activeId: null, stale: true });
    const restyled = only(ed);
    expect(restyled.from).toBe(dirtyAt.from);
    expect(restyled.to).toBe(dirtyAt.to);
    expect(
      (restyled as unknown as { type: { attrs: { class: string } } }).type.attrs.class,
    ).toMatch(/stale/);
    ed.destroy();
  });

  it("re-resolves against the document once the buffer is saved again", () => {
    const ed = paint("The deadline is Friday.");
    syncCommentAnchors(ed.view, { threads, activeId: null, stale: true });
    expect(
      (only(ed) as unknown as { type: { attrs: { class: string } } }).type.attrs.class,
    ).toMatch(/stale/);
    syncCommentAnchors(ed.view, { threads, activeId: null, stale: false });
    const d = only(ed);
    expect((d as unknown as { type: { attrs: { class: string } } }).type.attrs.class).not.toMatch(
      /stale/,
    );
    expect(ed.state.doc.textBetween(d.from, d.to)).toBe("deadline is Friday");
    ed.destroy();
  });

  it("opens the thread a click lands in", () => {
    const opened: string[] = [];
    const ed = makeEditor("The deadline is Friday.", (id) => opened.push(id));
    syncCommentAnchors(ed.view, { threads, activeId: null, stale: false });
    const d = only(ed);
    ed.view.someProp("handleClick", (f) => f(ed.view, d.from + 1, new MouseEvent("click")));
    expect(opened).toEqual(["t1"]);
    // A click outside the range belongs to the editor, not the panel.
    ed.view.someProp("handleClick", (f) => f(ed.view, 1, new MouseEvent("click")));
    expect(opened).toEqual(["t1"]);
    ed.destroy();
  });
});

describe("anchorAvailability", () => {
  it("refuses to anchor against an unsaved buffer, and says why", () => {
    expect(anchorAvailability(true)).toEqual({
      canCreate: false,
      hint: "Save to comment on this text",
    });
    expect(anchorAvailability(false)).toEqual({
      canCreate: true,
      hint: "Comment on the selection",
    });
  });
});