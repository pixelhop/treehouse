// Comment decorations for the tiptap editor — the second display adapter over
// the one matcher (KTD3). CommentedMarkdownViewer paints the rendered DOM with
// the CSS Custom Highlight API; this paints the ProseMirror document with a
// DecorationSet. Both ask `locateQuote`/`locatePoint` the same question and get
// the same answer, because both hand it the same normalized text.
//
// The honesty rule this file exists to keep: a DIRTY BUFFER IS NOT A VERSION.
// Anchors are version-pinned (KD5) and the server only ever resolves them
// against saved bytes, so while the buffer is dirty we do NOT re-match — the
// decorations keep the positions ProseMirror mapped for them through each
// keystroke, and they say so (the stale class, plus the editor's note). Once the
// buffer is saved and the server has re-resolved, we match again from scratch.
//
// Imported by relative path, not `~/`: this module is exercised in a plain unit
// test, where the Nuxt alias does not exist.
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { parseWikilinkInner, wikilinkLabel } from "shared";
import { clusterEnd, locatePoint, locateQuote, type TextSpan } from "../../utils/commentHighlights";

// The whitespace rule `buildTextIndex` applies to the rendered DOM (clusters come from clusterEnd).
const WS = /\s/;

/** The document as normalized text, with a map back to ProseMirror positions. */
export interface DocTextIndex {
  /** Same shape as the server's projected text — that is what makes it match. */
  text: string;
  /** `starts[i]` is the position immediately before `text[i]`. */
  starts: number[];
  /** `ends[i]` is the position immediately after `text[i]`. */
  ends: number[];
}

export interface DocRange {
  from: number;
  to: number;
}

/**
 * Flatten a ProseMirror document into the text the anchors match against.
 * ProseMirror already gives us syntax-free text, so unlike the reading view
 * there is no markdown to strip — only whitespace to collapse and block
 * boundaries to turn into the single space the server's normalizer leaves.
 */
export function buildDocTextIndex(doc: PMNode): DocTextIndex {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace = false;

  const push = (ch: string, from: number, to: number) => {
    chars.push(ch);
    starts.push(from);
    ends.push(to);
  };

  // A block boundary or whitespace run reads as one space, owned by the gap:
  // it maps to the END of the previous char, which keeps the first char of a
  // block the first index position inside it.
  const flushSpace = () => {
    if (!pendingSpace) return;
    pendingSpace = false;
    if (chars.length === 0) return;
    const k = chars.length - 1;
    push(" ", ends[k]!, ends[k]!);
  };

  // Text read from the document at `pos`. A wikilink's label isn't text in the
  // document (the node is an atom), so each of its characters covers the whole
  // node instead: `[pos, atomEnd)`.
  const addText = (data: string, pos: number, atomEnd?: number) => {
    let i = 0;
    while (i < data.length) {
      if (WS.test(data[i]!)) {
        pendingSpace = true;
        i += 1;
        continue;
      }
      const j = clusterEnd(data, i);
      flushSpace();
      const [from, to] = atomEnd === undefined ? [pos + i, pos + j] : [pos, atomEnd];
      for (const c of data.slice(i, j).normalize("NFC")) push(c, from, to);
      i = j;
    }
  };

  doc.descendants((node, pos) => {
    if (node.isText) {
      addText(node.text ?? "", pos);
      return false;
    }
    // Reads as its label, the same text the reading view renders for it.
    if (node.type.name === "wikilink") {
      const inner = typeof node.attrs.inner === "string" ? node.attrs.inner : "";
      addText(wikilinkLabel(parseWikilinkInner(inner)), pos, pos + node.nodeSize);
      return false;
    }
    // Two blocks read as two runs of words, exactly like the newline between
    // them that the server's projection keeps and its normalizer collapses.
    if (node.isBlock || node.type.name === "hardBreak") pendingSpace = true;
    return true;
  });

  return { text: chars.join(""), starts, ends };
}

/** The document range an offset span covers, or null when the span is empty. */
export function docRangeForSpan(index: DocTextIndex, span: TextSpan): DocRange | null {
  if (span.start < 0 || span.end > index.starts.length || span.end <= span.start) return null;
  return { from: index.starts[span.start]!, to: index.ends[span.end - 1]! };
}

/** The position a caret offset names — end of the document when it runs past. */
export function docPosForOffset(index: DocTextIndex, at: number): number | null {
  const n = index.starts.length;
  if (n === 0) return null;
  return at >= n ? index.ends[n - 1]! : index.starts[Math.max(0, at)]!;
}

/**
 * The offset span a document range covers — the inverse, for capturing what the
 * user selected. Block-boundary spaces occupy no document position, so they
 * would otherwise attach themselves to either end of every selection.
 */
export function spanForDocRange(index: DocTextIndex, from: number, to: number): TextSpan {
  let start = -1;
  let end = -1;
  for (let i = 0; i < index.starts.length; i++) {
    if (index.starts[i]! === index.ends[i]!) continue;
    if (start === -1 && index.starts[i]! >= from) start = i;
    if (index.ends[i]! <= to) end = i + 1;
  }
  if (start === -1) start = index.starts.length;
  return { start, end: Math.max(start, end === -1 ? start : end) };
}

/** A server thread, reduced to what placement reads. CommentThreadView fits. */
export interface AnchorThread {
  id: string;
  status: "open" | "resolved";
  anchorStatus: "anchored" | "ambiguous" | "outdated";
  anchorKind: "range" | "point";
  quote: string;
  currentText: string | null;
  contextBefore: string;
  contextAfter: string;
}

export interface PlacedAnchor {
  id: string;
  kind: "range" | "point";
  from: number;
  /** Equal to `from` for a point — a caret has no width. */
  to: number;
}

/**
 * Where each paintable thread sits in this document. Only threads the SERVER
 * could confidently re-attach are considered, and a thread the matcher can't
 * place here is simply left out: the panel still lists every one of them, and an
 * unpainted thread is something you go and find, a mispainted one is a lie.
 */
export function placeThreads(index: DocTextIndex, threads: AnchorThread[]): PlacedAnchor[] {
  const out: PlacedAnchor[] = [];
  for (const t of threads) {
    if (t.status === "resolved" || t.anchorStatus !== "anchored") continue;

    if (t.anchorKind === "point") {
      const at = locatePoint(index, t);
      if (at === null) continue;
      const pos = docPosForOffset(index, at);
      if (pos === null) continue;
      out.push({ id: t.id, kind: "point", from: pos, to: pos });
      continue;
    }

    // `currentText` is this version's matching text; `quote` is the original.
    const span = locateQuote(index, {
      quote: t.currentText || t.quote,
      contextBefore: t.contextBefore,
      contextAfter: t.contextAfter,
    });
    if (!span) continue;
    const range = docRangeForSpan(index, span);
    if (!range) continue;
    out.push({ id: t.id, kind: "range", ...range });
  }
  return out;
}

/** What the editor hands back when the user asks to comment on a selection. */
export interface EditorCommentDraft {
  kind: "range" | "point";
  quote: string;
  contextBefore: string;
  contextAfter: string;
}

/**
 * Whether the editor may anchor a NEW comment right now. A comment is pinned to
 * the version its quote was read from, and an unsaved buffer is not a version —
 * so creation waits for the save rather than anchoring against bytes the server
 * has never seen.
 */
export function anchorAvailability(dirty: boolean): { canCreate: boolean; hint: string } {
  return dirty
    ? { canCreate: false, hint: "Save to comment on this text" }
    : { canCreate: true, hint: "Comment on the selection" };
}

// ---------------------------------------------------------------------------
// The tiptap extension.
// ---------------------------------------------------------------------------

/** What the editor component pushes in; everything else is derived. */
export interface CommentAnchorsConfig {
  threads: AnchorThread[];
  activeId: string | null;
  /** The buffer has unsaved edits — positions are tracked, not re-matched. */
  stale: boolean;
}

interface AnchorPluginState {
  config: CommentAnchorsConfig;
  decos: DecorationSet;
}

const EMPTY_CONFIG: CommentAnchorsConfig = { threads: [], activeId: null, stale: false };

export const commentAnchorsKey = new PluginKey<AnchorPluginState>("treehouseCommentAnchors");

export interface CommentAnchorsOptions {
  /** A painted thread was clicked — the workspace view opens it in the panel. */
  onOpen: (threadId: string) => void;
}

/** `th-comment-mark` for ranges, `th-comment-pin` for points, + state suffixes. */
function classesFor(base: string, id: string, config: CommentAnchorsConfig): string {
  const parts = [base];
  if (id === config.activeId) parts.push(`${base}--active`);
  if (config.stale) parts.push(`${base}--stale`);
  return parts.join(" ");
}

function pinWidget(
  id: string,
  config: CommentAnchorsConfig,
  onOpen: (threadId: string) => void,
): () => HTMLElement {
  return () => {
    const el = document.createElement("span");
    el.className = classesFor("th-comment-pin", id, config);
    el.setAttribute("contenteditable", "false");
    el.title = "Open this comment";
    el.setAttribute("aria-label", "Open this comment");
    // mousedown, not click: by the time a click lands ProseMirror has already
    // moved the selection into the widget's neighbourhood.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpen(id);
    });
    return el;
  };
}

function decorationFor(
  p: PlacedAnchor,
  config: CommentAnchorsConfig,
  onOpen: (threadId: string) => void,
): Decoration {
  const spec = { threadId: p.id, anchorKind: p.kind };
  if (p.kind === "point") {
    return Decoration.widget(p.from, pinWidget(p.id, config, onOpen), {
      ...spec,
      side: -1,
      // Re-keyed on the styling so a state change actually redraws the pin.
      key: `pin:${p.id}:${p.id === config.activeId}:${config.stale}`,
      ignoreSelection: true,
    });
  }
  return Decoration.inline(
    p.from,
    p.to,
    { class: classesFor("th-comment-mark", p.id, config) },
    spec,
  );
}

/** Match the threads against this document from scratch (clean buffer only). */
function locateAll(
  doc: PMNode,
  config: CommentAnchorsConfig,
  onOpen: (threadId: string) => void,
): DecorationSet {
  const index = buildDocTextIndex(doc);
  return DecorationSet.create(
    doc,
    placeThreads(index, config.threads).map((p) => decorationFor(p, config, onOpen)),
  );
}

/**
 * Re-render the decorations we already have, at the positions ProseMirror has
 * been mapping for them. Used while the buffer is dirty: the styling changes,
 * the anchoring does not — because there is nothing trustworthy to re-anchor to.
 */
function restyle(
  doc: PMNode,
  decos: DecorationSet,
  config: CommentAnchorsConfig,
  onOpen: (threadId: string) => void,
): DecorationSet {
  const live = new Set(config.threads.filter((t) => t.status === "open").map((t) => t.id));
  const next: Decoration[] = [];
  for (const d of decos.find()) {
    const spec = d.spec as { threadId?: string; anchorKind?: "range" | "point" };
    if (!spec.threadId || !live.has(spec.threadId)) continue;
    next.push(
      decorationFor(
        { id: spec.threadId, kind: spec.anchorKind ?? "range", from: d.from, to: d.to },
        config,
        onOpen,
      ),
    );
  }
  return DecorationSet.create(doc, next);
}

function commentAnchorsPlugin(onOpen: (threadId: string) => void): Plugin<AnchorPluginState> {
  return new Plugin<AnchorPluginState>({
    key: commentAnchorsKey,
    state: {
      init: () => ({ config: EMPTY_CONFIG, decos: DecorationSet.empty }),
      apply(tr, value, _old, newState) {
        const config = tr.getMeta(commentAnchorsKey) as CommentAnchorsConfig | undefined;
        if (config) {
          return {
            config,
            decos: config.stale
              ? restyle(newState.doc, value.decos, config, onOpen)
              : locateAll(newState.doc, config, onOpen),
          };
        }
        if (!tr.docChanged) return value;
        // The keystroke case: ProseMirror knows exactly how this edit moved
        // every position, which is the only honest answer while unsaved.
        return { config: value.config, decos: value.decos.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => commentAnchorsKey.getState(state)?.decos ?? DecorationSet.empty,
      handleClick(view, pos) {
        for (const d of commentAnchorDecorations(view.state).find(pos, pos)) {
          const spec = d.spec as { threadId?: string };
          // Ranges only: a pin is a widget and handles its own mousedown.
          if (spec.threadId && d.from <= pos && pos < d.to) {
            onOpen(spec.threadId);
            break;
          }
        }
        // Never claim the click — the caret still belongs in the document.
        return false;
      },
    },
  });
}

export const CommentAnchors = Extension.create<CommentAnchorsOptions>({
  name: "commentAnchors",
  addOptions() {
    return { onOpen: () => {} };
  },
  addProseMirrorPlugins() {
    return [commentAnchorsPlugin((id) => this.options.onOpen(id))];
  },
});

/** Push a new thread list / styling state in, as a meta-only transaction. */
export function syncCommentAnchors(view: EditorView, config: CommentAnchorsConfig): void {
  view.dispatch(view.state.tr.setMeta(commentAnchorsKey, config));
}

/** The decorations currently painted. */
export function commentAnchorDecorations(state: EditorState): DecorationSet {
  return commentAnchorsKey.getState(state)?.decos ?? DecorationSet.empty;
}