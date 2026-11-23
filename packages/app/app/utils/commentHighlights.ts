// Bridges the reading view's rendered DOM to the server's text-first comment
// anchors. The server anchors against RAW markdown and hands back text only —
// `quote`, `contextBefore`, `contextAfter`, `currentText` — never offsets, so
// there is deliberately no offset protocol to keep in sync here: we locate a
// thread by searching the rendered text for what the server said, disambiguated
// by its context.
//
// The two sides have to agree on what "the text" is. The server projects
// markdown to plain text (syntax stripped) and then normalizes (NFC, whitespace
// runs collapsed); this module does the same two steps to the rendered DOM and
// to every fragment it compares, so a quote captured from the rendered view
// ("the deadline is") matches source that carries syntax ("the **deadline**
// is"). `plainFromMarkdown` is a deliberate lightweight twin of the server's
// `projectMarkdown` — the app bundle runs on the Workers runtime and can't
// import from packages/api, and this side needs no offset map.
//
// Constructs the projection keeps but the rendered DOM drops (table pipes,
// thematic-break dashes) can stop a thread from painting; it stays listed in
// the panel rather than being painted somewhere wrong.

import { wikilinkAt, wikilinkLabel } from "shared";

/** Context captured each side of a selection. Mirrors the server's capture. */
export const RANGE_CONTEXT_CHARS = 64;
/** Points have only context, so they get more of it. Mirrors the server. */
export const POINT_CONTEXT_CHARS = 96;

// The chars adjacent to a match are the discriminating ones; the far edge of a
// stored context can be truncated mid-word. Same window the server compares.
const CTX_CMP = 24;
// Two candidates whose context scores differ by less than this are a tie, and a
// tie is never broken by guessing.
const AMBIGUITY_MARGIN = 0.05;

const WS = /\s/;
const COMBINING = /\p{M}/u;

/**
 * End of the character cluster starting at `i`: a base code point and its
 * combining marks, so a decomposed sequence composes to the same char an
 * NFC-normalized anchor carries. Shared with the editor's index.
 */
export function clusterEnd(data: string, i: number): number {
  let j = i + (data.codePointAt(i)! > 0xffff ? 2 : 1);
  while (j < data.length) {
    const cp = data.codePointAt(j)!;
    if (!COMBINING.test(String.fromCodePoint(cp))) break;
    j += cp > 0xffff ? 2 : 1;
  }
  return j;
}

// ---------------------------------------------------------------------------
// Markdown -> plain text (no offset map; see the header note).
// ---------------------------------------------------------------------------

function isWordChar(s: string | undefined): boolean {
  return s !== undefined && /[\p{L}\p{N}]/u.test(s);
}

/** The text a reader sees for a wikilink, image or link starting at `j`, and where it ends. */
function linkPlainAt(src: string, j: number): { text: string; end: number } | null {
  // A wikilink reads as its label, exactly as the viewer renders it.
  const wiki = wikilinkAt(src, j);
  if (wiki) return { text: wikilinkLabel(wiki.parts), end: wiki.end };
  const label = src[j] === "!" ? j + 1 : j;
  const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(src.slice(label));
  return m ? { text: inlinePlain(m[1]!), end: label + m[0].length } : null;
}

function inlinePlain(src: string): string {
  let out = "";
  let j = 0;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\" && j + 1 < src.length) {
      out += src[j + 1];
      j += 2;
      continue;
    }
    if (c === "`") {
      j += 1;
      continue;
    }
    const link = c === "[" || c === "!" ? linkPlainAt(src, j) : null;
    if (link) {
      out += link.text;
      j = link.end;
      continue;
    }
    if (c === "*") {
      j += 1;
      continue;
    }
    if (c === "_") {
      // Intra-word underscores are real text (snake_case); delimiters are not.
      if (isWordChar(src[j - 1]) && isWordChar(src[j + 1])) out += c;
      j += 1;
      continue;
    }
    out += c;
    j += 1;
  }
  return out;
}

/** The text a reader actually sees for a markdown fragment or document. */
export function plainFromMarkdown(markdown: string): string {
  let out = "";
  let pos = 0;
  let inFence = false;
  const len = markdown.length;

  // Front matter projects to nothing — the same words in a `title:` would
  // otherwise collide with the body text.
  if (markdown.startsWith("---\n")) {
    let scan = markdown.indexOf("\n") + 1;
    while (scan > 0 && scan < len) {
      let le = markdown.indexOf("\n", scan);
      if (le === -1) le = len;
      const line = markdown.slice(scan, le).trim();
      if (line === "---" || line === "...") {
        pos = le === len ? len : le + 1;
        break;
      }
      scan = le === len ? len : le + 1;
    }
  }

  while (pos < len) {
    let lineEnd = markdown.indexOf("\n", pos);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = len;
    const line = markdown.slice(pos, lineEnd);

    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      pos = hasNewline ? lineEnd + 1 : len;
      continue;
    }
    if (inFence) {
      out += line + (hasNewline ? "\n" : "");
      pos = hasNewline ? lineEnd + 1 : len;
      continue;
    }

    let body = line;
    const indent = /^[ \t]*/.exec(body)![0];
    body = body.slice(indent.length);
    for (;;) {
      const m = /^> ?/.exec(body);
      if (!m) break;
      body = body.slice(m[0].length);
    }
    const marker = /^(?:#{1,6} |(?:[-*+]|\d{1,9}\.) )/.exec(body);
    if (marker) body = body.slice(marker[0].length);

    out += indent + inlinePlain(body) + (hasNewline ? "\n" : "");
    pos = hasNewline ? lineEnd + 1 : len;
  }
  return out;
}

/** NFC + whitespace runs collapsed to single spaces + trimmed. */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** A stored/submitted fragment reduced to the form the DOM index is in. */
function matchKey(fragment: string | undefined): string {
  return fragment ? normalizeForMatch(plainFromMarkdown(fragment)) : "";
}

// ---------------------------------------------------------------------------
// The rendered DOM as one normalized string, with a map back to text nodes.
// ---------------------------------------------------------------------------

/**
 * All the matcher below actually needs: the document as normalized text. The
 * reading view supplies a DOM index, the editor a ProseMirror one — they share
 * no position protocol, and matching never asked them to.
 */
export interface MatchableText {
  text: string;
}

export interface DomTextIndex extends MatchableText {
  /** Normalized text of the container (same shape as the server's doc text). */
  text: string;
  /** `nodes[i]` is the text node holding `text[i]`. */
  nodes: Text[];
  /** Offset of `text[i]` within its node. */
  offsets: number[];
  /** Offset just past `text[i]` within its node. */
  ends: number[];
}

export interface TextSpan {
  start: number;
  end: number;
}

export interface DomPoint {
  node: Text;
  offset: number;
}

export interface DomSpan {
  start: DomPoint;
  end: DomPoint;
}

// Elements that end a run of text. Two adjacent blocks read as separate words,
// so a boundary between them contributes a space — matching the newline the
// server's projection keeps and its normalizer collapses.
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

function blockAncestor(node: Node, root: Node): Node {
  let n: Node | null = node.parentNode;
  while (n && n !== root) {
    if (n.nodeType === 1 && BLOCK_TAGS.has((n as Element).tagName)) return n;
    n = n.parentNode;
  }
  return root;
}

/**
 * Flatten a rendered container into the normalized text the anchors match
 * against. Elements marked `data-comment-ignore` (the overlay's own chrome) are
 * skipped so the index only ever describes document content.
 */
export function buildTextIndex(root: Node): DomTextIndex {
  const chars: string[] = [];
  const nodes: Text[] = [];
  const offsets: number[] = [];
  const ends: number[] = [];
  let pendingSpace = false;
  let prevBlock: Node | null = null;

  const push = (ch: string, node: Text, start: number, end: number) => {
    chars.push(ch);
    nodes.push(node);
    offsets.push(start);
    ends.push(end);
  };

  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      const t = n as Text;
      const block = blockAncestor(t, root);
      if (prevBlock !== null && block !== prevBlock) pendingSpace = true;
      prevBlock = block;
      const data = t.data;
      let i = 0;
      while (i < data.length) {
        if (WS.test(data[i]!)) {
          pendingSpace = true;
          i += 1;
          continue;
        }
        const j = clusterEnd(data, i);
        if (pendingSpace) {
          pendingSpace = false;
          // The boundary space belongs to the gap, so it maps to the END of the
          // previous char — that keeps the first char of a block the first
          // index position inside it (the gutter affordance relies on this).
          if (chars.length > 0) {
            const k = chars.length - 1;
            push(" ", nodes[k]!, ends[k]!, ends[k]!);
          }
        }
        const nfc = data.slice(i, j).normalize("NFC");
        for (const c of nfc) push(c, t, i, j);
        i = j;
      }
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.hasAttribute("data-comment-ignore")) return;
    for (const child of Array.from(el.childNodes)) walk(child);
  };

  walk(root);
  return { text: chars.join(""), nodes, offsets, ends };
}

function firstIndexIn(index: DomTextIndex, node: Node): number {
  for (let i = 0; i < index.nodes.length; i++) {
    const t = index.nodes[i]!;
    if (node === t || node.contains(t)) return i;
  }
  return -1;
}

function lastIndexIn(index: DomTextIndex, node: Node): number {
  for (let i = index.nodes.length - 1; i >= 0; i--) {
    const t = index.nodes[i]!;
    if (node === t || node.contains(t)) return i;
  }
  return -1;
}

/** Index offset where a block element's own text begins (gutter placement). */
export function blockStartOffset(index: DomTextIndex, block: Element): number | null {
  const i = firstIndexIn(index, block);
  return i === -1 ? null : i;
}

function edgeOffset(
  index: DomTextIndex,
  container: Node,
  offset: number,
  side: "start" | "end",
): number | null {
  if (container.nodeType === 3) {
    const node = container as Text;
    if (side === "start") {
      for (let i = 0; i < index.nodes.length; i++) {
        if (index.nodes[i] === node && index.offsets[i]! >= offset) return i;
      }
      const last = lastIndexIn(index, node);
      return last === -1 ? null : last + 1;
    }
    for (let i = index.nodes.length - 1; i >= 0; i--) {
      if (index.nodes[i] === node && index.ends[i]! <= offset) return i + 1;
    }
    const first = firstIndexIn(index, node);
    return first === -1 ? null : first;
  }
  if (container.nodeType !== 1) return null;
  // An element container's offset counts child nodes, not characters.
  const children = Array.from(container.childNodes);
  if (side === "start") {
    for (let k = offset; k < children.length; k++) {
      const i = firstIndexIn(index, children[k]!);
      if (i !== -1) return i;
    }
    const last = lastIndexIn(index, container);
    return last === -1 ? null : last + 1;
  }
  for (let k = offset - 1; k >= 0; k--) {
    const i = lastIndexIn(index, children[k]!);
    if (i !== -1) return i + 1;
  }
  const first = firstIndexIn(index, container);
  return first === -1 ? null : first;
}

/** Index offset for one DOM position (click hit-testing), or null if outside. */
export function indexOffsetAt(index: DomTextIndex, container: Node, offset: number): number | null {
  return edgeOffset(index, container, offset, "start");
}

/** The index span a DOM selection covers, or null when it selects no text. */
export function spanForSelection(
  index: DomTextIndex,
  sel: {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
  },
): TextSpan | null {
  const start = edgeOffset(index, sel.startContainer, sel.startOffset, "start");
  const end = edgeOffset(index, sel.endContainer, sel.endOffset, "end");
  if (start === null || end === null) return null;
  const span = trimSpan(index.text, start, end);
  return span.end > span.start ? span : null;
}

/** Concrete DOM positions for an index span (what a DOM Range is built from). */
export function resolveSpan(index: DomTextIndex, span: TextSpan): DomSpan | null {
  const { start, end } = trimSpan(index.text, span.start, span.end);
  if (end <= start || start < 0 || end > index.nodes.length) return null;
  return {
    start: { node: index.nodes[start]!, offset: index.offsets[start]! },
    end: { node: index.nodes[end - 1]!, offset: index.ends[end - 1]! },
  };
}

// ---------------------------------------------------------------------------
// Locating a thread's text in the rendered view.
// ---------------------------------------------------------------------------

function trimSpan(text: string, start: number, end: number): TextSpan {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  while (s < e && text[s] === " ") s += 1;
  while (e > s && text[e - 1] === " ") e -= 1;
  return { start: s, end: e };
}

function findOccurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = hay.indexOf(needle, idx + 1);
  }
  return out;
}

/**
 * How well the text either side of `pos` matches a stored context: the fraction
 * of characters that agree walking outward from the boundary. One collapsed
 * space of slack at the boundary, because a context stored from raw markdown
 * and the rendered text can disagree by exactly that.
 */
function sideScore(text: string, pos: number, needle: string, before: boolean): number | null {
  if (!needle) return null;
  const cmp = before ? needle.slice(-CTX_CMP) : needle.slice(0, CTX_CMP);
  let edge = pos;
  if (before && edge > 0 && text[edge - 1] === " ") edge -= 1;
  if (!before && edge < text.length && text[edge] === " ") edge += 1;
  const slice = before
    ? text.slice(Math.max(0, edge - cmp.length), edge)
    : text.slice(edge, edge + cmp.length);
  let n = 0;
  const limit = Math.min(slice.length, cmp.length);
  while (n < limit) {
    const a = before ? slice[slice.length - 1 - n] : slice[n];
    const b = before ? cmp[cmp.length - 1 - n] : cmp[n];
    if (a !== b) break;
    n += 1;
  }
  return n / cmp.length;
}

/** Weakest provided side — a context only corroborates when both ends do. */
function contextScore(
  text: string,
  start: number,
  end: number,
  cb: string,
  ca: string,
): number | null {
  const before = sideScore(text, start, cb, true);
  const after = sideScore(text, end, ca, false);
  const provided = [before, after].filter((v): v is number => v !== null);
  return provided.length === 0 ? null : Math.min(...provided);
}

export interface AnchorText {
  quote?: string;
  contextBefore?: string;
  contextAfter?: string;
}

/**
 * Where a thread's text sits in the rendered view, or null when it can't be
 * placed confidently. Several equally good candidates return null: an unpainted
 * thread is a thread you go find in the panel, a wrongly painted one is a lie.
 */
export function locateQuote(index: MatchableText, anchor: AnchorText): TextSpan | null {
  const q = matchKey(anchor.quote);
  if (!q) return null;
  const occ = findOccurrences(index.text, q);
  if (occ.length === 0) return null;
  if (occ.length === 1) return trimSpan(index.text, occ[0]!, occ[0]! + q.length);

  const cb = matchKey(anchor.contextBefore);
  const ca = matchKey(anchor.contextAfter);
  if (!cb && !ca) return null;

  const scored = occ
    .map((p) => ({ p, score: contextScore(index.text, p, p + q.length, cb, ca) ?? 0 }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]!.score === 0) return null;
  if (scored.length > 1 && scored[0]!.score - scored[1]!.score < AMBIGUITY_MARGIN) return null;
  return trimSpan(index.text, scored[0]!.p, scored[0]!.p + q.length);
}

/**
 * The caret a point anchor names, or null when its context repeats. Carets are
 * canonicalized past a collapsed space so "before the gap" and "after the gap"
 * are the same place rather than two rival candidates.
 */
export function locatePoint(index: MatchableText, anchor: AnchorText): number | null {
  const cb = matchKey(anchor.contextBefore);
  const ca = matchKey(anchor.contextAfter);
  if (!cb && !ca) return null;
  const text = index.text;
  const carets = new Set<number>();
  for (let c = 0; c <= text.length; c++) {
    if (cb && sideScore(text, c, cb, true) !== 1) continue;
    if (ca && sideScore(text, c, ca, false) !== 1) continue;
    carets.add(text[c] === " " ? c + 1 : c);
    if (carets.size > 1) return null;
  }
  return carets.size === 1 ? [...carets][0]! : null;
}

/** Quote + surrounding context for a selection, in rendered-text terms. */
export function captureRange(
  index: MatchableText,
  span: TextSpan,
): { quote: string; contextBefore: string; contextAfter: string } {
  const { start, end } = trimSpan(index.text, span.start, span.end);
  return {
    quote: index.text.slice(start, end),
    contextBefore: index.text.slice(Math.max(0, start - RANGE_CONTEXT_CHARS), start),
    contextAfter: index.text.slice(end, end + RANGE_CONTEXT_CHARS),
  };
}

/** Context either side of a point — all a point anchor has to go on. */
export function capturePoint(
  index: MatchableText,
  at: number,
): { contextBefore: string; contextAfter: string } {
  const c = Math.max(0, Math.min(at, index.text.length));
  return {
    contextBefore: index.text.slice(Math.max(0, c - POINT_CONTEXT_CHARS), c),
    contextAfter: index.text.slice(c, c + POINT_CONTEXT_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Panel bucketing. Structural types: any CommentThreadView satisfies them.
// ---------------------------------------------------------------------------

export interface BucketableThread {
  status: "open" | "resolved";
  anchorStatus: "anchored" | "ambiguous" | "outdated";
  pinnedVersion: number;
  resolvedAtVersion: number | null;
}

/**
 * Open threads split into the ones the document can show and the ones it can't.
 * Ambiguous joins outdated in the tray (R17): several equally good locations is
 * not a location. Resolved threads leave both — they're history, and history
 * that no longer anchors is still history.
 */
export function bucketThreads<T extends BucketableThread>(
  threads: T[],
): { open: T[]; tray: T[]; resolved: T[] } {
  const open: T[] = [];
  const tray: T[] = [];
  const resolved: T[] = [];
  for (const t of threads) {
    if (t.status === "resolved") resolved.push(t);
    else if (t.anchorStatus === "anchored") open.push(t);
    else tray.push(t);
  }
  return { open, tray, resolved };
}

/**
 * A thread resolved at the very version it was created against: nobody changed
 * the document in response. Worth saying out loud — "resolved" otherwise reads
 * as "fixed", and the reviewer deserves to know it wasn't.
 */
export function resolvedWithoutChanges(t: BucketableThread): boolean {
  return (
    t.status === "resolved" &&
    t.resolvedAtVersion !== null &&
    t.resolvedAtVersion === t.pinnedVersion
  );
}

// ---------------------------------------------------------------------------
// Paging. Both lists the server hands back are windows — threads on a file, and
// replies within a thread — so the reading view stitches pages together here,
// away from the component, where the stitching can be tested.
// ---------------------------------------------------------------------------

/**
 * Every loaded thread page as one list. Pages are offset windows over a
 * createdAt ordering, so a thread created between two reads slides down and can
 * appear in both — dedupe by id, keeping the earlier position, or the panel
 * renders it twice while the overlay paints it once.
 */
export function mergeThreadPages<T extends { id: string }>(
  pages: readonly { threads: T[] }[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const t of page.threads) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

export interface PagedEntry {
  id: string;
  createdAt: string;
}

/**
 * The replies to render for one thread: its first page (which every list
 * response carries) plus any tail pages the reader has pulled in, in the
 * server's own order. `remaining` is what is still on the server — taken from
 * `entryCount`, which the poll keeps current, so a reply posted elsewhere shows
 * up in the count without disturbing what is already on screen.
 */
export function threadReplies<E extends PagedEntry>(
  thread: { entries: E[]; entryCount: number },
  extra: readonly E[],
): { shown: E[]; remaining: number } {
  const shown: E[] = [];
  const seen = new Set<string>();
  for (const e of [...thread.entries, ...extra]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    shown.push(e);
  }
  shown.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { shown, remaining: Math.max(0, thread.entryCount - shown.length) };
}