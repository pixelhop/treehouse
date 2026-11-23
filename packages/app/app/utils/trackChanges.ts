// Track changes between two versions of a markdown file, as markdown.
//
// KD6: change review is presented as TRACK CHANGES, never as a source diff —
// "developers are used to diffs, most people aren't". A naive word diff of raw
// markdown fails that on contact: `##`, `**`, `[](…)` and list markers all turn
// into diff tokens, which IS a source diff. So this module diffs the PROSE and
// keeps the markdown:
//
//   1. Front matter is split off and never diffed (a front-matter-only change
//      is "no visible changes"); the target's block is passed through so the
//      document still renders with its header card.
//   2. The body splits into blocks, then lines. Each line is projected to the
//      prose a reader actually sees (`**bold**` → `bold`), and lines pair up by
//      that prose — so `*x*` → `_x_` is not a change at all.
//   3. Paired lines are word-diffed on the projection; each run is mapped back
//      to the markdown that produced it, so insertions and deletions come out
//      as `<ins>`/`<del>` INSIDE normally-rendered markdown. A heading still
//      looks like a heading, a list item like a list item, and untouched bold
//      is still bold.
//   4. A slice whose markdown got cut mid-delimiter is flattened to its prose
//      rather than emitted (see `safeInline`) — a stray `**` on screen is the
//      exact failure this module exists to prevent.
//
// The result is markdown, so it renders through the same MarkdownViewer (and
// the same sanitizer) as the clean view; `ins`/`del`/`class` all survive
// DOMPurify's defaults.
import { diffArrays, diffWordsWithSpace } from "diff";
import { normalizeForMatch } from "./commentHighlights";
import { splitFrontMatter } from "./frontmatter";

export interface TrackChangesResult {
  /** "no_visible_changes" when nothing a reader would see actually moved. */
  status: "changed" | "no_visible_changes";
  /** The merged document. Empty when there is nothing visible to show. */
  markdown: string;
  insertions: number;
  deletions: number;
}

// Beyond this, a line is not word-diffed — it is replaced wholesale. Bounds the
// quadratic worst case on a pathological single-line document.
const MAX_WORD_DIFF_CHARS = 20_000;
// Two lines only pair up (and get a word diff) when they still share this much
// of their words. Below it they read as a replacement, not an edit.
const PAIR_SIMILARITY = 0.34;
// Blocks are held to a stricter bar. A word diff of two paragraphs that merely
// share some vocabulary comes out as word salad — "Support has ~~not~~ now
// ~~seen~~ walked ~~through~~ the tool" — which is unreadable and reads as a
// machine's output, not a marked-up document. Past this much churn the old
// paragraph is struck through whole and the new one follows it.
const BLOCK_PAIR_SIMILARITY = 0.6;

const INS_OPEN = '<ins class="th-ins">';
const DEL_OPEN = '<del class="th-del">';

// ---------------------------------------------------------------------------
// Markdown -> prose, with an offset map back to the source.
// ---------------------------------------------------------------------------

function isWordChar(s: string | undefined): boolean {
  return s !== undefined && /[\p{L}\p{N}]/u.test(s);
}

interface Projection {
  /** The prose a reader sees. */
  text: string;
  /** `map[i]` is the source offset that produced `text[i]`. */
  map: number[];
}

/**
 * Inline markdown reduced to its prose, keeping a per-character source offset.
 * A deliberate twin of `plainFromMarkdown` in commentHighlights (which needs no
 * map and therefore doesn't carry one); the rules are kept identical so the two
 * agree on what "the text" is.
 */
function projectInline(src: string): Projection {
  const chars: string[] = [];
  const map: number[] = [];
  const pushAt = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) {
      chars.push(s[k]!);
      map.push(at);
    }
  };
  const pushInner = (inner: Projection, base: number) => {
    for (let k = 0; k < inner.text.length; k++) {
      chars.push(inner.text[k]!);
      map.push(base + inner.map[k]!);
    }
  };

  let j = 0;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\" && j + 1 < src.length) {
      pushAt(src[j + 1]!, j);
      j += 2;
      continue;
    }
    if (c === "`") {
      j += 1;
      continue;
    }
    if (c === "!" && src[j + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(src.slice(j));
      if (m) {
        pushInner(projectInline(m[1]!), j + 2);
        j += m[0].length;
        continue;
      }
    } else if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(src.slice(j));
      if (m) {
        pushInner(projectInline(m[1]!), j + 1);
        j += m[0].length;
        continue;
      }
    }
    if (c === "*") {
      j += 1;
      continue;
    }
    // Strikethrough delimiters are syntax, not prose — `looksBalanced` already
    // treats them as such, and leaving them in the projection let a `~~x~~` →
    // `x` edit word-diff the tildes themselves, putting markdown on screen.
    // A lone `~` is ordinary text (approximations, home paths).
    if (c === "~" && src[j + 1] === "~") {
      j += 2;
      continue;
    }
    if (c === "_") {
      // Intra-word underscores are real text (snake_case); delimiters are not.
      if (isWordChar(src[j - 1]) && isWordChar(src[j + 1])) pushAt(c, j);
      j += 1;
      continue;
    }
    pushAt(c, j);
    j += 1;
  }
  return { text: chars.join(""), map };
}

/**
 * Is every inline delimiter in this fragment closed? A run cut mid-`**` would
 * otherwise reach the reader as literal asterisks — markdown syntax presented
 * as an edit, which is the one thing this module must never do.
 */
function looksBalanced(s: string): boolean {
  const count = (re: RegExp) => s.match(re)?.length ?? 0;
  if (count(/`/g) % 2) return false;
  if (count(/\*\*/g) % 2) return false;
  if ((s.replace(/\*\*/g, "").match(/\*/g)?.length ?? 0) % 2) return false;
  if (count(/~~/g) % 2) return false;
  if (count(/\[/g) !== count(/\]/g)) return false;
  if (count(/\(/g) !== count(/\)/g)) return false;
  let underscores = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "_" && !(isWordChar(s[i - 1]) && isWordChar(s[i + 1]))) underscores += 1;
  }
  return underscores % 2 === 0;
}

/** A source slice safe to hand to the renderer — flattened if it got cut. */
function safeInline(s: string): string {
  return looksBalanced(s) ? s : projectInline(s).text;
}

// ---------------------------------------------------------------------------
// Blocks and lines.
// ---------------------------------------------------------------------------

interface Line {
  /** Indent + blockquote markers + heading/list marker — structure, not prose. */
  prefix: string;
  inline: string;
  /** Structural class: a heading, a bullet, a quoted paragraph. */
  cls: string;
  /** The prose a reader sees on this line, normalized. */
  prose: string;
  /** Class + prose: what "the same line" means for pairing. */
  key: string;
  raw: string;
}

type Block =
  | { kind: "code"; raw: string; key: string; prose: string }
  | { kind: "text"; lines: Line[]; key: string; prose: string };

const LINE_RE = /^([ \t]*)((?:>[ \t]?)*)((?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+)?)([\s\S]*)$/;

function parseLine(raw: string): Line {
  const m = LINE_RE.exec(raw)!;
  const [, indent = "", quote = "", marker = "", inline = ""] = m;
  // The marker's SHAPE is structure ("a heading", "a bullet"), its exact
  // characters are not: `- x` and `* x` are the same line to a reader.
  const shape = marker.startsWith("#")
    ? `h${marker.trim().length}`
    : marker
      ? /^\d/.test(marker)
        ? "ol"
        : "ul"
      : "p";
  const cls = `${quote.length ? "q" : ""}${shape}`;
  const prose = normalizeForMatch(projectInline(inline).text);
  return { prefix: indent + quote + marker, inline, cls, prose, key: `${cls}|${prose}`, raw };
}

/**
 * A block's identity for pairing: its shape plus its prose. Consecutive lines of
 * the same shape collapse to one entry, so a paragraph reads the same however
 * its hard wraps fall — reflowing a paragraph is not a change anybody can see.
 */
function textBlockKey(lines: Line[]): string {
  const shape: string[] = [];
  for (const l of lines) if (shape[shape.length - 1] !== l.cls) shape.push(l.cls);
  return `${shape.join(",")}|${normalizeForMatch(lines.map((l) => l.prose).join(" "))}`;
}

/**
 * The body as blocks: fenced code is atomic, and everything else groups into
 * runs of non-blank lines. Blank lines are separators, not content — emitting
 * blocks joined by a blank line is what keeps a deleted paragraph from merging
 * into its neighbour.
 */
function splitBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let buf: Line[] = [];
  const flush = () => {
    if (!buf.length) return;
    blocks.push({
      kind: "text",
      lines: buf,
      key: textBlockKey(buf),
      prose: normalizeForMatch(buf.map((l) => l.prose).join(" ")),
    });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const fence = /^[ \t]*(```+|~~~+)/.exec(raw);
    if (fence) {
      flush();
      const collected = [raw];
      const closer = fence[1]!;
      i += 1;
      while (i < lines.length) {
        collected.push(lines[i]!);
        if (new RegExp(`^[ \\t]*${closer[0]}{${closer.length},}[ \\t]*$`).test(lines[i]!)) break;
        i += 1;
      }
      const rawBlock = collected.join("\n");
      blocks.push({ kind: "code", raw: rawBlock, key: `code|${rawBlock}`, prose: rawBlock });
      continue;
    }
    if (raw.trim() === "") flush();
    else buf.push(parseLine(raw));
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Merging one line's inline content.
// ---------------------------------------------------------------------------

interface Merge {
  out: string;
  insertions: number;
  deletions: number;
}

/** Source range for a projected run; the ends stretch to the fragment's edges. */
function sliceFor(
  proj: Projection,
  src: string,
  from: number,
  to: number,
  first: boolean,
  last: boolean,
): string {
  const at = (i: number) => (i < proj.map.length ? proj.map[i]! : src.length);
  const start = first ? 0 : at(from);
  const end = last ? src.length : at(to);
  return src.slice(start, Math.max(start, end));
}

type WordParts = ReturnType<typeof diffWordsWithSpace>;

/**
 * Walk the word diff, emitting each run as the markdown that produced it
 * (`flatten: false`) or as bare prose (`flatten: true`). The markdown pass is
 * what keeps an untouched `**bold**` bold; the prose pass is the escape hatch
 * for when a change cuts a delimiter pair in half.
 */
function emitRuns(
  parts: WordParts,
  b: Projection,
  t: Projection,
  baseInline: string,
  targetInline: string,
  flatten: boolean,
): Merge {
  const out: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let bPos = 0;
  let tPos = 0;

  const take = (
    proj: Projection,
    src: string,
    from: number,
    to: number,
    first: boolean,
    last: boolean,
  ) => (flatten ? proj.text.slice(from, to) : sliceFor(proj, src, from, to, first, last));

  parts.forEach((part, i) => {
    const first = i === 0;
    const last = i === parts.length - 1;
    const len = part.value.length;
    if (part.added) {
      const src = take(t, targetInline, tPos, tPos + len, first, last);
      tPos += len;
      if (src.trim()) {
        out.push(`${INS_OPEN}${safeInline(src)}</ins>`);
        insertions += 1;
      } else out.push(src);
      return;
    }
    if (part.removed) {
      const src = take(b, baseInline, bPos, bPos + len, first, last);
      bPos += len;
      if (src.trim()) {
        out.push(`${DEL_OPEN}${safeInline(src)}</del>`);
        deletions += 1;
      } else out.push(src);
      return;
    }
    out.push(take(t, targetInline, tPos, tPos + len, first, last));
    tPos += len;
    bPos += len;
  });

  return { out: out.join(""), insertions, deletions };
}

/** The merged line with the ins/del wrappers removed — just the markdown. */
function withoutMarks(s: string): string {
  return s.replace(/<\/?(?:ins|del)(?:\s[^>]*)?>/g, "");
}

/**
 * One line's inline markdown with the prose changes marked. Runs the word diff
 * on the PROJECTION and maps each run back to the markdown behind it, so what a
 * reader sees marked is words — never delimiters.
 */
function mergeInline(baseInline: string, targetInline: string): Merge {
  const b = projectInline(baseInline);
  const t = projectInline(targetInline);
  if (normalizeForMatch(b.text) === normalizeForMatch(t.text)) {
    return { out: targetInline, insertions: 0, deletions: 0 };
  }
  if (baseInline.length > MAX_WORD_DIFF_CHARS || targetInline.length > MAX_WORD_DIFF_CHARS) {
    return {
      out: `${DEL_OPEN}${safeInline(baseInline)}</del>${INS_OPEN}${safeInline(targetInline)}</ins>`,
      insertions: 1,
      deletions: 1,
    };
  }

  // diffWordsWithSpace keeps whitespace as its own tokens, so the two cursors
  // inside emitRuns stay exactly in step with the projections they walk.
  const parts = diffWordsWithSpace(b.text, t.text);
  const merged = emitRuns(parts, b, t, baseInline, targetInline, false);
  // A change can land between a delimiter and its partner — `**September 12th**`
  // → `**October 3rd**` splits the pair across the two versions — which would
  // leave a bare `**` on screen. Then the whole line drops to prose: losing the
  // bold is a cosmetic cost, showing the reader an asterisk is the failure.
  if (looksBalanced(withoutMarks(merged.out))) return merged;
  return emitRuns(parts, b, t, baseInline, targetInline, true);
}

/** Table rows keep their cells: the pipes are structure, not words. */
function mergeRow(baseInline: string, targetInline: string): Merge {
  const bc = baseInline.split("|");
  const tc = targetInline.split("|");
  // Cell counts disagree (a column was added/removed): mark nothing rather than
  // emit a mark that would break the table's shape.
  if (bc.length !== tc.length) return { out: targetInline, insertions: 0, deletions: 0 };
  const merged = tc.map((cell, i) => mergeInline(bc[i]!, cell));
  return {
    out: merged.map((m) => m.out).join("|"),
    insertions: merged.reduce((n, m) => n + m.insertions, 0),
    deletions: merged.reduce((n, m) => n + m.deletions, 0),
  };
}

const isTableRow = (l: Line) => l.inline.includes("|");
/** A table's `|---|---|` rule carries no prose; it is never marked. */
const isTableRule = (l: Line) => /^[|\s:-]+$/.test(l.inline) && l.inline.includes("-");

function mergeLine(base: Line, target: Line): Merge {
  if (isTableRule(target)) return { out: target.raw, insertions: 0, deletions: 0 };
  const m =
    isTableRow(base) && isTableRow(target)
      ? mergeRow(base.inline, target.inline)
      : mergeInline(base.inline, target.inline);
  return { ...m, out: target.prefix + m.out };
}

/** A whole line marked as gone or as new, with its structure left standing. */
function wholeLine(line: Line, kind: "ins" | "del"): string {
  if (!line.inline.trim() || isTableRule(line)) return line.raw;
  const open = kind === "ins" ? INS_OPEN : DEL_OPEN;
  return `${line.prefix}${open}${safeInline(line.inline)}</${kind}>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A code block cannot carry inline marks, so it is marked as a whole. */
function wholeCode(raw: string, kind: "ins" | "del"): string {
  const lines = raw.split("\n");
  // Drop the opening fence, and the closing one only if it is actually there —
  // an unterminated fence would otherwise lose its last line of code.
  const end = /^[ \t]*(?:```+|~~~+)[ \t]*$/.test(lines[lines.length - 1] ?? "")
    ? lines.length - 1
    : lines.length;
  const body = lines.slice(1, end).join("\n");
  return `<pre class="th-${kind}-block"><code>${escapeHtml(body)}</code></pre>`;
}

// ---------------------------------------------------------------------------
// Pairing changed runs.
// ---------------------------------------------------------------------------

/** Fraction of the shorter line's words the two lines share. */
function similarity(a: string, b: string): number {
  const aw = a.split(/\s+/).filter(Boolean);
  const bw = b.split(/\s+/).filter(Boolean);
  if (!aw.length || !bw.length) return 0;
  const pool = new Map<string, number>();
  for (const w of bw) pool.set(w, (pool.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of aw) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      shared += 1;
      pool.set(w, n - 1);
    }
  }
  return shared / Math.min(aw.length, bw.length);
}

/**
 * Walk a removed run and an added run together. Same-position entries that
 * still look like each other are an EDIT (word-diffed in place); everything
 * else is a plain removal or addition.
 */
function zipRuns<T>(
  removed: T[],
  added: T[],
  pairable: (a: T, b: T) => boolean,
  onPair: (a: T, b: T) => void,
  onRemoved: (a: T) => void,
  onAdded: (b: T) => void,
): void {
  let i = 0;
  const shared = Math.min(removed.length, added.length);
  for (; i < shared; i++) {
    const a = removed[i]!;
    const b = added[i]!;
    if (pairable(a, b)) onPair(a, b);
    else {
      onRemoved(a);
      onAdded(b);
    }
  }
  for (let k = i; k < removed.length; k++) onRemoved(removed[k]!);
  for (let k = i; k < added.length; k++) onAdded(added[k]!);
}

/** Group a diff's parts into (equal | removed+added) runs, in order. */
function runsOf<T>(parts: { value: T[]; added?: boolean; removed?: boolean }[]) {
  const runs: { equal?: T[]; removed: T[]; added: T[] }[] = [];
  for (const part of parts) {
    if (!part.added && !part.removed) {
      runs.push({ equal: part.value, removed: [], added: [] });
      continue;
    }
    const tail = runs[runs.length - 1];
    if (tail && !tail.equal) {
      if (part.added) tail.added.push(...part.value);
      else tail.removed.push(...part.value);
    } else {
      runs.push({
        removed: part.removed ? [...part.value] : [],
        added: part.added ? [...part.value] : [],
      });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// The merge.
// ---------------------------------------------------------------------------

/** Merge two text blocks line by line, keeping every line's own structure. */
function mergeTextBlock(base: Line[], target: Line[]): Merge {
  const out: string[] = [];
  let insertions = 0;
  let deletions = 0;

  const parts = diffArrays(
    base.map((l) => l.key),
    target.map((l) => l.key),
  );
  let bi = 0;
  let ti = 0;
  const takeBase = (n: number) => base.slice(bi, (bi += n));
  const takeTarget = (n: number) => target.slice(ti, (ti += n));

  for (const run of runsOf(
    parts.map((p) => ({ value: p.value, added: p.added, removed: p.removed })),
  )) {
    if (run.equal) {
      const n = run.equal.length;
      takeBase(n);
      // Equal by prose — the TARGET's markdown is the one that is current.
      for (const l of takeTarget(n)) out.push(l.raw);
      continue;
    }
    zipRuns(
      takeBase(run.removed.length),
      takeTarget(run.added.length),
      (a, b) => similarity(a.prose, b.prose) >= PAIR_SIMILARITY,
      (a, b) => {
        const m = mergeLine(a, b);
        out.push(m.out);
        insertions += m.insertions;
        deletions += m.deletions;
      },
      (a) => {
        out.push(wholeLine(a, "del"));
        if (a.inline.trim()) deletions += 1;
      },
      (b) => {
        out.push(wholeLine(b, "ins"));
        if (b.inline.trim()) insertions += 1;
      },
    );
  }
  return { out: out.join("\n"), insertions, deletions };
}

function mergeBlocks(base: Block[], target: Block[]): Merge {
  const out: string[] = [];
  let insertions = 0;
  let deletions = 0;

  const parts = diffArrays(
    base.map((b) => b.key),
    target.map((b) => b.key),
  );
  let bi = 0;
  let ti = 0;
  const takeBase = (n: number) => base.slice(bi, (bi += n));
  const takeTarget = (n: number) => target.slice(ti, (ti += n));

  const emitWhole = (block: Block, kind: "ins" | "del") => {
    if (block.kind === "code") {
      out.push(wholeCode(block.raw, kind));
      if (kind === "ins") insertions += 1;
      else deletions += 1;
      return;
    }
    // ONE entry, not one per line: the block's lines are soft wraps of a single
    // paragraph (or the items of one list), and pushing them separately would
    // split them into that many paragraphs on screen.
    out.push(block.lines.map((l) => wholeLine(l, kind)).join("\n"));
    for (const l of block.lines) {
      if (!l.inline.trim()) continue;
      if (kind === "ins") insertions += 1;
      else deletions += 1;
    }
  };

  for (const run of runsOf(
    parts.map((p) => ({ value: p.value, added: p.added, removed: p.removed })),
  )) {
    if (run.equal) {
      const n = run.equal.length;
      takeBase(n);
      for (const b of takeTarget(n))
        out.push(b.kind === "code" ? b.raw : b.lines.map((l) => l.raw).join("\n"));
      continue;
    }
    zipRuns(
      takeBase(run.removed.length),
      takeTarget(run.added.length),
      // Code has no prose to diff, so a code block never pairs — it is replaced.
      // Prose blocks pair only while they still recognisably say the same thing.
      (a, b) =>
        a.kind === "text" &&
        b.kind === "text" &&
        similarity(a.prose, b.prose) >= BLOCK_PAIR_SIMILARITY,
      (a, b) => {
        const m = mergeTextBlock((a as { lines: Line[] }).lines, (b as { lines: Line[] }).lines);
        out.push(m.out);
        insertions += m.insertions;
        deletions += m.deletions;
      },
      (a) => emitWhole(a, "del"),
      (b) => emitWhole(b, "ins"),
    );
  }
  return { out: out.join("\n\n"), insertions, deletions };
}

/**
 * The document a returning reader sees: the current version with everything
 * that changed since their last visit marked in place (R12).
 */
export function buildTrackChanges(base: string, target: string): TrackChangesResult {
  const baseBody = splitFrontMatter(base).body;
  const split = splitFrontMatter(target);
  const merged = mergeBlocks(splitBlocks(baseBody), splitBlocks(split.body));

  if (merged.insertions === 0 && merged.deletions === 0) {
    return { status: "no_visible_changes", markdown: "", insertions: 0, deletions: 0 };
  }
  // The target's front matter rides along untouched — never diffed as prose,
  // but the document should still render with the header it actually has.
  const head = split.frontMatter ? `${split.frontMatter}\n` : "";
  return {
    status: "changed",
    markdown: head + merged.out,
    insertions: merged.insertions,
    deletions: merged.deletions,
  };
}