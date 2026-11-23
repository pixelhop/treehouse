import { makeDiff, match } from "@sanity/diff-match-patch";
import { type WikilinkMatch, wikilinkAt, wikilinkLabel } from "shared";

// ---------------------------------------------------------------------------
// Anchor resolution. Pure functions over strings: no database, no file
// service, no HTTP. `resolveAnchor(anchor, content)` is deterministic from the
// anchor's ORIGINAL recorded fields plus the content alone — previously
// resolved ranges never feed back as hints or bias scoring, because silent
// anchor drift by accumulation is exactly the mis-anchoring failure the
// cascade exists to prevent. Below the confidence floor a thread is
// "outdated"; several equally good matches are "ambiguous" — never a guess.
//
// Coordinate bridge: humans select in a rendered view, agents quote raw
// markdown, anchors store raw-source offsets. All matching happens in a
// plain-text PROJECTION of the markdown (syntax stripped, offsets mapped),
// further normalized (NFC, whitespace collapsed); results map back to raw
// source offsets. Input quotes are pushed through the same projection, so a
// raw quote like "See **the deadline**" and its rendered form match alike.
// ---------------------------------------------------------------------------

export interface AnchorRecord {
  kind: "range" | "point";
  quote: string;
  contextBefore: string;
  contextAfter: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface ResolveResult {
  status: "anchored" | "ambiguous" | "outdated";
  start?: number;
  end?: number;
  currentText?: string;
  confidence: number;
  resolvedForHash: string;
}

export interface CreateMatch {
  status: "matched" | "ambiguous" | "not_found";
  start?: number;
  end?: number;
  quote?: string;
  contextBefore?: string;
  contextAfter?: string;
  occurrences?: number;
}

// Quotes shorter than this (normalized chars) carry no evidence on their own:
// they skip the fuzzy stages entirely — either their context carries them or
// they go outdated. (Hypothesis shipped the counter-example: short generic
// quotes fuzzy-scanned whole pages and anchored to noise.)
const MIN_QUOTE_LEN = 8;
// Raw context captured each side at creation. Points get more because the
// context is all they have.
const RANGE_CONTEXT_CHARS = 64;
const POINT_CONTEXT_CHARS = 96;
// diff-match-patch bitap: stricter than the 0.5 default, and never an
// unbounded scan — the search text is sliced to a window around the hint.
const MATCH_THRESHOLD = 0.3;
const POINT_MATCH_THRESHOLD = 0.25;
const MATCH_WINDOW = 1000;
const POINT_MATCH_WINDOW = 2000;
// Bitap's hard pattern limit; longer patterns are matched by head/tail probes
// and then verified against the full span by diff similarity.
const MAX_PATTERN = 32;
// Context comparison looks at the nearest slice of context, not the whole
// stored window: the chars adjacent to the quote are the discriminating ones,
// and the far edge of a stored context can be truncated mid-construct.
const CTX_CMP = 24;
// Two candidates whose context scores differ by less than this are a tie.
const AMBIGUITY_MARGIN = 0.05;

// ---------------------------------------------------------------------------
// Projection: markdown -> plain text with an exact offset map.
// ---------------------------------------------------------------------------

/**
 * Plain-text projection of markdown. `toSource[i]` is the source offset of
 * projected char i — every projected char IS the identical source char, so
 * matching in projection space maps losslessly back to raw offsets. This is a
 * pragmatic line/regex tokenizer, not a CommonMark parser: front matter and
 * fence lines vanish, heading/list/blockquote markers and emphasis/backtick
 * characters are dropped, links/images collapse to their label/alt text, and
 * a wikilink to the label the viewer shows for it (its alias, else its target).
 * The one exception to "identical source char" is the ` > ` the viewer puts
 * between a wikilink's target and heading, which maps to the `#` it replaces.
 */
export function projectMarkdown(markdown: string): {
  text: string;
  toSource: number[];
  /** Source spans of the wikilinks projected: an anchor can't end inside one. */
  wikilinks: [number, number][];
} {
  const chars: string[] = [];
  const toSource: number[] = [];
  const wikilinks: [number, number][] = [];
  const emit = (i: number) => {
    chars.push(markdown[i]!);
    toSource.push(i);
  };

  const isWordChar = (s: string | undefined) => s !== undefined && /[\p{L}\p{N}]/u.test(s);

  // The label's characters where the source has them (an alias, a target);
  // `Target > Heading` is assembled from both, around the `#`.
  const emitWikilink = (link: WikilinkMatch): void => {
    wikilinks.push([link.start, link.end]);
    const inner = markdown.slice(link.innerStart, link.end - 2);
    const label = wikilinkLabel(link.parts);
    const at = inner.lastIndexOf(label);
    if (at !== -1) {
      for (let k = 0; k < label.length; k++) emit(link.innerStart + at + k);
      return;
    }
    const { target, fragment } = link.parts;
    const hash = inner.indexOf("#");
    const targetStart = link.innerStart + link.parts.targetStart;
    for (let k = 0; k < target.length; k++) emit(targetStart + k);
    for (const ch of " > ") {
      chars.push(ch);
      toSource.push(link.innerStart + hash);
    }
    const fragmentStart = link.innerStart + inner.indexOf(fragment ?? "", hash + 1);
    for (let k = 0; k < (fragment ?? "").length; k++) emit(fragmentStart + k);
  };

  // A wikilink, image or link starting at `j`, as the text a reader sees for
  // it. The index just past it, or null when none starts there.
  const emitLinkAt = (j: number, end: number): number | null => {
    const wiki = wikilinkAt(markdown, j);
    if (wiki && wiki.end <= end) {
      emitWikilink(wiki);
      return wiki.end;
    }
    const label = markdown[j] === "!" ? j + 2 : j + 1;
    const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(markdown.slice(label - 1, end));
    if (!m) return null;
    emitInline(label, label + m[1]!.length);
    return label - 1 + m[0].length;
  };

  const emitInline = (start: number, end: number): void => {
    let j = start;
    while (j < end) {
      const c = markdown[j]!;
      if (c === "\\" && j + 1 < end) {
        // Escape: drop the backslash, keep the escaped char.
        emit(j + 1);
        j += 2;
        continue;
      }
      if (c === "`") {
        j += 1;
        continue;
      }
      if (c === "[" || (c === "!" && markdown[j + 1] === "[")) {
        const after = emitLinkAt(j, end);
        if (after === null) emit(j);
        j = after ?? j + 1;
        continue;
      }
      if (c === "*") {
        j += 1;
        continue;
      }
      if (c === "_") {
        // Keep intra-word underscores (snake_case); drop emphasis delimiters.
        if (isWordChar(markdown[j - 1]) && isWordChar(markdown[j + 1])) emit(j);
        j += 1;
        continue;
      }
      emit(j);
      j += 1;
    }
  };

  const len = markdown.length;
  let pos = 0;
  let inFence = false;

  // YAML front matter projects to nothing (title text there would otherwise
  // collide with the same words in the body).
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
      // Fence lines vanish entirely (including their newline); the code
      // between them is kept verbatim.
      inFence = !inFence;
      pos = hasNewline ? lineEnd + 1 : len;
      continue;
    }
    if (inFence) {
      for (let j = pos; j < lineEnd; j++) emit(j);
      if (hasNewline) emit(lineEnd);
      pos = hasNewline ? lineEnd + 1 : len;
      continue;
    }

    let j = pos;
    while (j < lineEnd && (markdown[j] === " " || markdown[j] === "\t")) {
      emit(j); // indentation is real text; normalization collapses it anyway
      j += 1;
    }
    for (;;) {
      const m = /^> ?/.exec(markdown.slice(j, lineEnd));
      if (!m) break;
      j += m[0].length;
    }
    const heading = /^#{1,6} /.exec(markdown.slice(j, lineEnd));
    if (heading) {
      j += heading[0].length;
    } else {
      const marker = /^(?:[-*+]|\d{1,9}\.) /.exec(markdown.slice(j, lineEnd));
      if (marker) j += marker[0].length;
    }
    emitInline(j, lineEnd);
    if (hasNewline) emit(lineEnd);
    pos = hasNewline ? lineEnd + 1 : len;
  }

  return { text: chars.join(""), toSource, wikilinks };
}

// ---------------------------------------------------------------------------
// Normalization: NFC + whitespace runs collapsed, with an offset-preserving
// map back into projection space (and from there back to source).
// ---------------------------------------------------------------------------

interface NormDoc {
  text: string;
  /** Projected index of the first source unit behind normalized char i. */
  first: number[];
  /** Projected index of the last source unit behind normalized char i. */
  last: number[];
}

const COMBINING = /\p{M}/u;
const WS = /\s/;

function normalizeProjected(proj: string): NormDoc {
  const parts: string[] = [];
  const first: number[] = [];
  const last: number[] = [];
  let i = 0;
  while (i < proj.length) {
    if (WS.test(proj[i]!)) {
      let j = i + 1;
      while (j < proj.length && WS.test(proj[j]!)) j += 1;
      parts.push(" ");
      first.push(i);
      last.push(i); // a collapsed run maps to its first char only
      i = j;
      continue;
    }
    // Cluster a base code point with its trailing combining marks so that
    // decomposed sequences compose to the same normalized char as NFC input.
    const baseCp = proj.codePointAt(i)!;
    let j = i + (baseCp > 0xffff ? 2 : 1);
    while (j < proj.length) {
      const cp = proj.codePointAt(j)!;
      if (!COMBINING.test(String.fromCodePoint(cp))) break;
      j += cp > 0xffff ? 2 : 1;
    }
    const nfc = proj.slice(i, j).normalize("NFC");
    for (let k = 0; k < nfc.length; k++) {
      parts.push(nfc[k]!);
      first.push(i);
      last.push(j - 1);
    }
    i = j;
  }
  return { text: parts.join(""), first, last };
}

/** Normalized matching key for a stored/submitted fragment (quote/context). */
function normKey(fragment: string): string {
  if (!fragment) return "";
  const projected = projectMarkdown(fragment).text;
  return normalizeProjected(projected).text.replace(/^ +| +$/g, "");
}

interface DocIndex {
  markdown: string;
  toSource: number[];
  wikilinks: [number, number][];
  norm: NormDoc;
}

function indexDocument(markdown: string): DocIndex {
  const proj = projectMarkdown(markdown);
  return {
    markdown,
    toSource: proj.toSource,
    wikilinks: proj.wikilinks,
    norm: normalizeProjected(proj.text),
  };
}

/**
 * `[start, end)` grown to take in any wikilink it cuts through. Selecting up to
 * the end of a link's label stops short of its `]]`, and a slice of half a link
 * is no longer a link: it wouldn't project to what the reader selected.
 */
function wholeWikilinks(doc: DocIndex, start: number, end: number): [number, number] {
  let from = start;
  let to = end;
  for (const [s, e] of doc.wikilinks) {
    if (s < to && from < e) {
      from = Math.min(from, s);
      to = Math.max(to, e);
    }
  }
  return [from, to];
}

/** Map a normalized span [ns, ne) back to raw source offsets [start, end). */
function normSpanToSource(doc: DocIndex, ns: number, ne: number): [number, number] {
  const start = doc.toSource[doc.norm.first[ns]!]!;
  if (ne <= ns) return [start, start];
  return wholeWikilinks(doc, start, doc.toSource[doc.norm.last[ne - 1]!]! + 1);
}

/** Source offset of the caret sitting BEFORE normalized index c. */
function caretToSource(doc: DocIndex, c: number): number {
  if (c >= doc.norm.text.length) return doc.markdown.length;
  return doc.toSource[doc.norm.first[c]!]!;
}

/** Normalized index nearest a source offset — the fuzzy stages' location hint. */
function normIndexNear(doc: DocIndex, sourceOffset: number): number {
  const n = doc.norm.text.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.toSource[doc.norm.first[mid]!]! < sourceOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Scoring primitives.
// ---------------------------------------------------------------------------

/** 1 − levenshtein/maxLen over a character diff; 1 for identical strings. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let lev = 0;
  let ins = 0;
  let del = 0;
  for (const [op, text] of makeDiff(a, b)) {
    if (op === 1) ins += text.length;
    else if (op === -1) del += text.length;
    else {
      lev += Math.max(ins, del);
      ins = 0;
      del = 0;
    }
  }
  lev += Math.max(ins, del);
  return Math.max(0, 1 - lev / max);
}

/**
 * Location-bounded fuzzy locate. The text is sliced to a window around the
 * expected location before calling bitap, so a match can never come from the
 * far side of the document; patterns are truncated to bitap's 32-char limit
 * (callers verify the full span by similarity afterwards).
 */
function fuzzyIndexOf(
  text: string,
  pattern: string,
  expected: number,
  threshold: number,
  windowRadius: number,
): number {
  if (!pattern) return -1;
  const pat = pattern.slice(0, MAX_PATTERN);
  const anchor = Math.min(Math.max(0, Math.round(expected)), text.length);
  const winStart = Math.max(0, anchor - windowRadius - pat.length);
  const winEnd = Math.min(text.length, anchor + windowRadius + pattern.length);
  if (winStart >= winEnd) return -1;
  let found: number;
  try {
    found = match(text.slice(winStart, winEnd), pat, anchor - winStart, {
      threshold,
      distance: windowRadius,
    });
  } catch {
    return -1; // bitap limits are pre-enforced; a resolver must never throw
  }
  return found === -1 ? -1 : winStart + found;
}

/**
 * Similarity of `needle` against the text ending at `pos` (before=true) or
 * starting at `pos` (before=false), with a one-collapsed-space slack at the
 * boundary and ±2 length slack — stored contexts and live text can disagree by
 * a couple of units at their truncated far edge without meaning a mismatch.
 */
function sideSim(normText: string, pos: number, needle: string, before: boolean): number | null {
  if (!needle) return null;
  const cmp = before ? needle.slice(-CTX_CMP) : needle.slice(0, CTX_CMP);
  let edge = pos;
  if (before && edge > 0 && normText[edge - 1] === " ") edge -= 1;
  if (!before && edge < normText.length && normText[edge] === " ") edge += 1;
  let best = 0;
  for (const delta of [-2, -1, 0, 1, 2]) {
    const len = cmp.length + delta;
    if (len <= 0) continue;
    const slice = before
      ? normText.slice(Math.max(0, edge - len), edge)
      : normText.slice(edge, edge + len);
    best = Math.max(best, similarity(slice, cmp));
  }
  return best;
}

interface CtxScore {
  before: number | null;
  after: number | null;
  /** Mean of the provided sides; null when no context is stored at all. */
  avg: number | null;
  /** Weakest provided side; null when no context is stored at all. */
  min: number | null;
}

function ctxScore(normText: string, ns: number, ne: number, cb: string, ca: string): CtxScore {
  const before = sideSim(normText, ns, cb, true);
  const after = sideSim(normText, ne, ca, false);
  const provided = [before, after].filter((v): v is number => v !== null);
  if (provided.length === 0) return { before, after, avg: null, min: null };
  return {
    before,
    after,
    avg: provided.reduce((a, b) => a + b, 0) / provided.length,
    min: Math.min(...provided),
  };
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

/** Trim collapsed spaces off a normalized span's edges before mapping back. */
function trimSpan(normText: string, ns: number, ne: number): [number, number] {
  let s = Math.max(0, Math.min(ns, normText.length));
  let e = Math.max(s, Math.min(ne, normText.length));
  while (s < e && normText[s] === " ") s += 1;
  while (e > s && normText[e - 1] === " ") e -= 1;
  return [s, e];
}

// ---------------------------------------------------------------------------
// resolveAnchor — the cascade.
// ---------------------------------------------------------------------------

export function resolveAnchor(
  anchor: AnchorRecord,
  markdown: string,
  contentHash: string,
): ResolveResult {
  const outdated = (confidence = 0): ResolveResult => ({
    status: "outdated",
    confidence,
    resolvedForHash: contentHash,
  });
  const ambiguous = (confidence: number): ResolveResult => ({
    status: "ambiguous",
    confidence,
    resolvedForHash: contentHash,
  });

  const doc = indexDocument(markdown);
  const cb = normKey(anchor.contextBefore);
  const ca = normKey(anchor.contextAfter);

  const anchored = (ns: number, ne: number, confidence: number): ResolveResult => {
    const [ts, te] = trimSpan(doc.norm.text, ns, ne);
    if (te <= ts && anchor.kind === "range") return outdated();
    const [start, end] =
      anchor.kind === "point"
        ? [caretToSource(doc, ts), caretToSource(doc, ts)]
        : normSpanToSource(doc, ts, te);
    return {
      status: "anchored",
      start,
      end,
      currentText: markdown.slice(start, end),
      confidence,
      resolvedForHash: contentHash,
    };
  };

  if (anchor.kind === "point") {
    return resolvePointAnchor(anchor, doc, cb, ca, outdated, ambiguous, anchored);
  }

  const q = normKey(anchor.quote);
  if (!q || !markdown || q.length > doc.norm.text.length) return outdated();
  const shortQuote = q.length < MIN_QUOTE_LEN;

  const occs = findOccurrences(doc.norm.text, q);

  // Stage 1 — offset verify. Bare byte-equality at the stored offset is NOT
  // enough (a short quote like "TBD" can sit at the same offset in a rewritten
  // line): the context must corroborate at that position, or the quote must be
  // unique in the document and above the minimum length.
  if (markdown.slice(anchor.sourceStart, anchor.sourceEnd) === anchor.quote) {
    for (const p of occs) {
      const pe = p + q.length;
      const [srcStart] = normSpanToSource(doc, p, pe);
      if (srcStart !== anchor.sourceStart) continue;
      const ctx = ctxScore(doc.norm.text, p, pe, cb, ca);
      const corroborated =
        (ctx.min !== null && ctx.min >= 0.85) || (occs.length === 1 && !shortQuote);
      if (corroborated) return anchored(p, pe, 1);
      break; // offsets are unique; no other occurrence can pass this stage
    }
  }

  // Stage 2 — context-assisted exact search over all occurrences of the
  // normalized quote.
  if (occs.length > 0) {
    const scored = occs.map((p) => ({
      p,
      pe: p + q.length,
      ctx: ctxScore(doc.norm.text, p, p + q.length, cb, ca),
    }));

    if (shortQuote) {
      // A short quote is pure noise without its surroundings: EVERY stored
      // side must match near-exactly, and the winner must be unique.
      const good = scored
        .filter((s) => s.ctx.min !== null && s.ctx.min >= 0.8)
        .sort((a, b) => b.ctx.min! - a.ctx.min!);
      if (good.length === 1)
        return anchored(good[0]!.p, good[0]!.pe, 0.75 + 0.25 * good[0]!.ctx.min!);
      if (good.length > 1) {
        if (good[0]!.ctx.min! - good[1]!.ctx.min! >= AMBIGUITY_MARGIN) {
          return anchored(good[0]!.p, good[0]!.pe, 0.75 + 0.25 * good[0]!.ctx.min!);
        }
        return ambiguous(0.5);
      }
      return outdated(); // fuzzy stages are skipped entirely below MIN_QUOTE_LEN
    }

    if (scored.length === 1) {
      const s = scored[0]!;
      const conf = s.ctx.avg === null ? 0.85 : 0.7 + 0.3 * s.ctx.avg;
      return anchored(s.p, s.pe, conf);
    }

    // Multiple exact occurrences: only context can pick one. Equal scores are
    // a tie and a tie is ambiguous — never first-match.
    const withCtx = scored
      .filter((s) => s.ctx.avg !== null)
      .sort((a, b) => b.ctx.avg! - a.ctx.avg!);
    if (withCtx.length === 0) return ambiguous(0.5);
    const best = withCtx[0]!;
    const second = withCtx[1];
    if (
      best.ctx.avg! >= 0.6 &&
      (second === undefined || best.ctx.avg! - second.ctx.avg! >= AMBIGUITY_MARGIN)
    ) {
      return anchored(best.p, best.pe, 0.6 + 0.35 * best.ctx.avg!);
    }
    return ambiguous(Math.min(0.59, best.ctx.avg ?? 0.5));
  }

  // Stages 3–4 need a location hint: where the anchor USED to live, from the
  // original recorded offset only (never a previously resolved range).
  const hint = normIndexNear(doc, anchor.sourceStart);

  // Stage 3 — context-first fuzzy: locate the context edges independently
  // near the hint and score the span between them against the quote.
  const cbTail = cb.slice(-MAX_PATTERN);
  const caHead = ca.slice(0, MAX_PATTERN);
  let prefixEnd = -1;
  let suffixStart = -1;
  if (cbTail) {
    const p = fuzzyIndexOf(
      doc.norm.text,
      cbTail,
      hint - cbTail.length,
      MATCH_THRESHOLD,
      MATCH_WINDOW,
    );
    if (p !== -1) prefixEnd = p + cbTail.length;
  }
  if (caHead) {
    const s = fuzzyIndexOf(doc.norm.text, caHead, hint + q.length, MATCH_THRESHOLD, MATCH_WINDOW);
    if (s !== -1) suffixStart = s;
  }
  if (prefixEnd !== -1 && suffixStart !== -1 && suffixStart >= prefixEnd - 2) {
    if (suffixStart - prefixEnd <= q.length * 2 + 16) {
      const ns = prefixEnd;
      const ne = Math.max(suffixStart, prefixEnd);
      const sim = similarity(doc.norm.text.slice(ns, ne), q);
      if (sim >= 0.6) return anchored(ns, ne, 0.55 + 0.4 * sim);
    }
  } else if (prefixEnd !== -1) {
    const sim = similarity(doc.norm.text.slice(prefixEnd, prefixEnd + q.length), q);
    if (sim >= 0.8) return anchored(prefixEnd, prefixEnd + q.length, 0.5 + 0.4 * sim);
  } else if (suffixStart !== -1) {
    const ns = Math.max(0, suffixStart - q.length);
    const sim = similarity(doc.norm.text.slice(ns, suffixStart), q);
    if (sim >= 0.8) return anchored(ns, suffixStart, 0.5 + 0.4 * sim);
  }

  // Stage 4 — quote-only fuzzy, window-bounded, verified against the full
  // span (the 32-char probe alone would accept far too much).
  const head = fuzzyIndexOf(doc.norm.text, q, hint, MATCH_THRESHOLD, MATCH_WINDOW);
  if (head !== -1) {
    let ne = head + q.length;
    if (q.length > MAX_PATTERN) {
      const tail = fuzzyIndexOf(
        doc.norm.text,
        q.slice(-MAX_PATTERN),
        head + q.length - MAX_PATTERN,
        MATCH_THRESHOLD,
        MATCH_WINDOW,
      );
      if (tail !== -1 && tail + MAX_PATTERN > head && tail + MAX_PATTERN - head <= q.length * 2) {
        ne = tail + MAX_PATTERN;
      }
    }
    const sim = similarity(doc.norm.text.slice(head, ne), q);
    if (sim >= 0.75) {
      // Context veto: with no context corroboration at the candidate, a
      // merely-similar sentence elsewhere could pass the 0.75 bar (e.g. "the
      // aggregation script..." for "the migration script..."). When stored
      // context exists but disagrees here, only a near-identical quote is
      // trusted.
      const ctx = ctxScore(doc.norm.text, head, ne, cb, ca);
      if (ctx.avg === null || ctx.avg >= 0.5 || sim >= 0.9) {
        return anchored(head, ne, 0.45 + 0.35 * sim);
      }
    }
  }

  return outdated();
}

// ---------------------------------------------------------------------------
// Point anchors: context-only, wider window, stricter acceptance.
// ---------------------------------------------------------------------------

/** All caret positions where the stored contexts meet, by exact search. */
function exactCarets(normText: string, cb: string, ca: string): number[] {
  const carets = new Set<number>();
  const afterMatches = (pos: number): boolean => {
    if (!ca) return true;
    let p = pos;
    if (p < normText.length && normText[p] === " ") p += 1;
    return normText.startsWith(ca, p);
  };
  if (cb) {
    for (const p of findOccurrences(normText, cb)) {
      const caret = p + cb.length;
      if (afterMatches(caret)) carets.add(caret);
    }
  } else {
    for (const p of findOccurrences(normText, ca)) carets.add(p);
  }
  return [...carets].sort((a, b) => a - b);
}

function resolvePointAnchor(
  anchor: AnchorRecord,
  doc: DocIndex,
  cb: string,
  ca: string,
  outdated: (confidence?: number) => ResolveResult,
  ambiguous: (confidence: number) => ResolveResult,
  anchored: (ns: number, ne: number, confidence: number) => ResolveResult,
): ResolveResult {
  if (!cb && !ca) return outdated();
  if (!doc.markdown) return outdated();

  const carets = exactCarets(doc.norm.text, cb, ca);
  if (carets.length === 1) {
    const caret = carets[0]!;
    const conf = caretToSource(doc, caret) === anchor.sourceStart ? 1 : 0.9;
    return anchored(caret, caret, conf);
  }
  if (carets.length > 1) return ambiguous(0.5);

  // Fuzzy recovery only when BOTH sides are stored: one drifted context alone
  // is not enough evidence to place a caret.
  if (!cb || !ca) return outdated();
  const hint = normIndexNear(doc, anchor.sourceStart);
  const cbTail = cb.slice(-MAX_PATTERN);
  const p = fuzzyIndexOf(
    doc.norm.text,
    cbTail,
    hint - cbTail.length,
    POINT_MATCH_THRESHOLD,
    POINT_MATCH_WINDOW,
  );
  if (p === -1) return outdated();
  const caret = p + cbTail.length;
  const beforeSim = sideSim(doc.norm.text, caret, cb, true);
  const afterSim = sideSim(doc.norm.text, caret, ca, false);
  if (beforeSim !== null && afterSim !== null && beforeSim >= 0.85 && afterSim >= 0.85) {
    return anchored(caret, caret, 0.6 + 0.3 * ((beforeSim + afterSim) / 2));
  }
  return outdated();
}

// ---------------------------------------------------------------------------
// resolveNewAnchor — creation-time matching (exact only; a creator quotes
// text that exists, so fuzz here would only manufacture wrong anchors).
// ---------------------------------------------------------------------------

export function resolveNewAnchor(
  input: {
    quote: string;
    contextBefore?: string;
    contextAfter?: string;
    occurrence?: number;
    kind: "range" | "point";
  },
  markdown: string,
): CreateMatch {
  const doc = indexDocument(markdown);
  const cb = normKey(input.contextBefore ?? "");
  const ca = normKey(input.contextAfter ?? "");

  if (input.kind === "point") {
    if ((!cb && !ca) || !markdown) return { status: "not_found" };
    const carets = exactCarets(doc.norm.text, cb, ca);
    if (carets.length === 0) return { status: "not_found" };
    if (carets.length > 1) return { status: "ambiguous", occurrences: carets.length };
    const src = caretToSource(doc, carets[0]!);
    return {
      status: "matched",
      start: src,
      end: src,
      quote: "",
      contextBefore: markdown.slice(Math.max(0, src - POINT_CONTEXT_CHARS), src),
      contextAfter: markdown.slice(src, src + POINT_CONTEXT_CHARS),
    };
  }

  const q = normKey(input.quote);
  if (!q || !markdown || q.length > doc.norm.text.length) return { status: "not_found" };

  const occs = findOccurrences(doc.norm.text, q);
  if (occs.length === 0) return { status: "not_found" };

  let chosen: number | undefined;
  if (occs.length === 1) {
    chosen = occs[0];
  } else {
    // Context first: keep occurrences where every PROVIDED side matches
    // near-exactly. If that leaves exactly one, it wins; otherwise the
    // explicit occurrence index (1-based) selects among what remains.
    let candidates = occs;
    if (cb || ca) {
      const corroborated = occs.filter((p) => {
        const ctx = ctxScore(doc.norm.text, p, p + q.length, cb, ca);
        return ctx.min !== null && ctx.min >= 0.8;
      });
      if (corroborated.length === 1) chosen = corroborated[0];
      else if (corroborated.length > 1) candidates = corroborated;
    }
    if (chosen === undefined && input.occurrence !== undefined) {
      const idx = input.occurrence - 1;
      if (idx >= 0 && idx < candidates.length) chosen = candidates[idx];
    }
    if (chosen === undefined) return { status: "ambiguous", occurrences: occs.length };
  }

  const ns = chosen!;
  const [start, end] = normSpanToSource(doc, ns, ns + q.length);
  return {
    status: "matched",
    start,
    end,
    quote: markdown.slice(start, end),
    contextBefore: markdown.slice(Math.max(0, start - RANGE_CONTEXT_CHARS), start),
    contextAfter: markdown.slice(end, end + RANGE_CONTEXT_CHARS),
  };
}