// Finding the links in a markdown document, and rewriting them after a rename.
// Server-side: it parses block structure with markdown-it, which the app has no
// use for, so it is a separate entry point (`shared/linkScan`) rather than part
// of the package index. The syntax and resolution rules are in ./links.
//
// Two layers, because each is the right tool for one job:
//   - markdown-it parses the BLOCK structure: which lines are code (fenced or
//     indented, at any depth of lists and quotes), raw HTML, or reference
//     definitions. That is CommonMark's container logic, which approximating
//     with patterns kept getting wrong, and getting it wrong means a rename
//     rewrites a code sample. Its block parser is linear even on hostile input.
//   - a small scanner reads the remaining lines for inline links, with a work
//     budget. markdown-it's inline parser (like micromark's) goes quadratic on a
//     paragraph full of brackets, and this runs on the server for every
//     markdown write.
import MarkdownIt, { type Env, type Token } from "markdown-it";
import { parse as parseYaml } from "yaml";
import {
  type WikilinkMatch,
  type WikilinkResolver,
  wikilinkAt,
  wikilinkKey,
  wikilinkTargetFor,
} from "./links";
import { dirOf, resolveRef } from "./relativeRefs";
import { frontMatterTagList, INLINE_TAG_RE, normalizeTag, tagAncestors, uniqueTags } from "./tags";

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export type ScannedLink =
  | ({ kind: "wiki" } & WikilinkMatch)
  | {
      kind: "markdown";
      /** Offsets of the whole link, or of a reference definition's line. */
      start: number;
      end: number;
      /** The destination as a renderer reads it: backslash escapes and entities decoded. */
      href: string;
      /** The destination as written, and where it sits. */
      raw: string;
      hrefStart: number;
      hrefEnd: number;
      /** Written as `<dest>`, which allows raw spaces. */
      angle: boolean;
    };

type MarkdownLink = Extract<ScannedLink, { kind: "markdown" }>;

/** How far a bracketed link text may run before it is not a link. */
const MAX_LINK_TEXT = 1000;

/**
 * Most lines scanned. Block parsing is linear but costs about 2 µs a line, and
 * it holds the server's event loop: 2 MB of one-character lines would take over
 * a second, on a write anyone can make. A real note this long is reported as
 * unscanned, like one over the size limit.
 */
const MAX_SCANNED_LINES = 100_000;

function tooManyLines(src: string): boolean {
  let lines = 0;
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) {
    if (++lines > MAX_SCANNED_LINES) return true;
  }
  return false;
}

/** Index just past a leading YAML front-matter block, or 0. Same rule as the app's splitFrontMatter. */
function frontMatterEnd(src: string): number {
  const firstNl = src.indexOf("\n");
  // A byte-order mark before the opening line is allowed: the rename path keeps
  // it in the text, and the block is front matter all the same.
  const opening = src
    .slice(0, firstNl)
    .replace(/^\uFEFF/, "")
    .replace(/\r$/, "");
  if (firstNl === -1 || opening !== "---") return 0;
  let idx = firstNl + 1;
  while (idx <= src.length) {
    const nextNl = src.indexOf("\n", idx);
    const lineEnd = nextNl === -1 ? src.length : nextNl;
    if (src.slice(idx, lineEnd).replace(/\r$/, "") === "---") {
      return nextNl === -1 ? src.length : nextNl + 1;
    }
    if (nextNl === -1) break;
    idx = nextNl + 1;
  }
  return 0;
}

function lineEndAt(src: string, i: number): number {
  const nl = src.indexOf("\n", i);
  return nl === -1 ? src.length : nl;
}

/** True when the line starting at `i` holds only whitespace. */
function blankLineAt(src: string, i: number): boolean {
  for (let at = i; at < src.length && src[at] !== "\n"; at++) {
    if (src[at] !== " " && src[at] !== "\t" && src[at] !== "\r") return false;
  }
  return true;
}

/** Index of the first character at or after `p` that isn't a space or tab. */
function skipSpaces(src: string, p: number): number {
  let at = p;
  while (src[at] === " " || src[at] === "\t") at++;
  return at;
}

/**
 * Past the gap a link may hold between its parts: spaces, and one line break
 * with any quote markers that open the next line.
 */
function skipGap(src: string, p: number): number {
  let at = skipSpaces(src, p);
  if (src[at] === "\r") at++;
  if (src[at] !== "\n") return at;
  at = skipSpaces(src, at + 1);
  while (src[at] === ">") at = skipSpaces(src, at + 1);
  return at;
}

// Block parsing only, so none of the inline rules ever run. `html` on, because
// the viewer passes raw HTML through: a link inside an HTML block isn't
// rendered as one, so it mustn't be indexed or rewritten as one either.
const md = new MarkdownIt({ html: true });

/** Block tokens whose lines hold no links: code and raw HTML. */
const OPAQUE_BLOCKS = new Set(["fence", "code_block", "html_block"]);

type Span = { start: number; end: number };

/** What the block parse tells the scanner, as offsets into the document. */
interface Blocks {
  /**
   * Where the scanner must stop looking ahead, in order: code and HTML blocks,
   * skipped whole, and the empty span at the end of each paragraph or heading,
   * because nothing inline runs from one block into the next. Without those a
   * backtick left open in a paragraph pairs with one in the next heading, and
   * text in a code span reads as a link.
   */
  opaque: Span[];
  /** Reference definitions (`[ref]: dest`) by normalized label → the destination markdown-it read. */
  references: Map<string, string>;
}

/** Start offset of every line in `src`. */
function lineStarts(src: string): number[] {
  const out = [0];
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** Parse the block structure of `src[first..]`. */
function parseBlocks(src: string, first: number): Blocks {
  // markdown-it splits lines on `\n` alone and would read a `\r` as text (so
  // "```\r" wouldn't close a fence). Same-length replacements keep every
  // offset valid.
  const body = src.slice(first).replace(/\r/g, " ").replace(/\0/g, "\uFFFD");
  const env: Env = {};
  const tokens: Token[] = [];
  md.block.parse(body, md, env, tokens);
  const starts = lineStarts(body);
  const at = (line: number) =>
    first + (line < starts.length ? (starts[line] as number) : body.length);
  const opaque: Span[] = [];
  for (const t of tokens) {
    if (OPAQUE_BLOCKS.has(t.type) && t.map) opaque.push({ start: at(t.map[0]), end: at(t.map[1]) });
    else if (t.type === "inline" && t.map) opaque.push({ start: at(t.map[1]), end: at(t.map[1]) });
  }
  opaque.sort((a, b) => a.start - b.start);
  const references = new Map<string, string>();
  for (const [label, ref] of Object.entries(env.references ?? {})) references.set(label, ref.href);
  return { opaque, references };
}

/**
 * A reference definition at the start of a line, after any quote or list
 * markers: `[label]: dest`, or `[label]: <dest>`. A reference-style link's
 * destination is written here, once, however many `[text][label]` uses it has.
 */
const DEFINITION_RE =
  /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?\[((?:\\.|[^\\[\]]){1,999})\]:[ \t]*(?:\r?\n(?:[ \t]*>)*[ \t]*)?(?:<((?:\\.|[^\\<>\n])*)>|([^\s<]\S*))/;

/**
 * An inline HTML open or closing tag at the start of a string (CommonMark's
 * definition): a tag name, then attributes whose values may be quoted.
 */
const INLINE_HTML_TAG_RE =
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)/;

/** How each bracket changes the nesting depth while looking for a link's closing `]`. */
const BRACKET_DEPTH: Record<string, number> = { "[": 1, "]": -1 };
type Destination = { start: number; end: number; angle: boolean; next: number };
type Found = { end: number; link: ScannedLink | null };

/**
 * One pass over a document's inline content. All look-ahead draws on `budget`,
 * proportional to the document's length: looking ahead for a closing bracket or
 * backtick from every opener is quadratic on hostile input (a megabyte of `[`).
 * A normal note never comes near the budget; a pathological one stops scanning
 * early and contributes fewer links. Nothing reaches into a code or HTML block:
 * look-ahead stops at the next one (`limit`), and the scan jumps over it.
 */
class LinkScanner {
  private budget: number;
  readonly links: ScannedLink[] = [];
  /** Inline `#tag`s, as written, in order. */
  readonly tags: string[] = [];
  private next = 0;
  /** Where the next code or HTML block starts: no construct can run into it. */
  private limit: number;
  /** The next `-->` found so far (-1: there is none); see skipComment. */
  private commentClose = -2;

  constructor(
    private readonly src: string,
    private readonly blocks: Blocks,
  ) {
    this.budget = src.length * 8 + 4096;
    this.limit = blocks.opaque[0]?.start ?? src.length;
  }

  run(first: number): { links: ScannedLink[]; tags: string[]; complete: boolean } {
    const src = this.src;
    let i = first;
    while (i < src.length && this.budget-- > 0) {
      if (i >= this.limit) {
        i = this.skipBlock(i);
        continue;
      }
      const atLineStart = i === first || src[i - 1] === "\n";
      i = (atLineStart ? this.definition(i) : null) ?? this.step(i);
    }
    return { links: this.links, tags: this.tags, complete: i >= src.length };
  }

  /** Past the block boundary at `limit`: a code or HTML block's end, or just on. */
  private skipBlock(i: number): number {
    const block = this.blocks.opaque[this.next++] as Span;
    this.limit = this.blocks.opaque[this.next]?.start ?? this.src.length;
    this.budget -= Math.max(0, block.end - i);
    return Math.max(block.end, i);
  }

  /** Past a reference definition on the line at `i`, recording its destination; else null. */
  private definition(i: number): number | null {
    const src = this.src;
    if (this.blocks.references.size === 0) return null;
    // The destination may sit on the next line (`[ref]:` then `  dest`).
    const lineEnd = lineEndAt(src, i);
    const twoLines = Math.min(lineEndAt(src, lineEnd + 1), this.limit);
    this.budget -= twoLines - i;
    const m = DEFINITION_RE.exec(src.slice(i, Math.max(lineEnd, twoLines)));
    if (!m) return null;
    const label = md.utils.normalizeReference(m[1] as string);
    const angle = m[2] !== undefined;
    const raw = (angle ? m[2] : m[3]) as string;
    const href = md.utils.unescapeAll(raw);
    // Only a line markdown-it read as this definition: the same label, reaching
    // the same destination. Anything else (a paragraph line that merely looks
    // like one) is ordinary text.
    if (this.blocks.references.get(label) !== md.normalizeLink(href)) return null;
    const hrefEnd = i + m[0].length - (angle ? 1 : 0);
    const end = lineEndAt(src, hrefEnd);
    this.links.push({
      kind: "markdown",
      start: i,
      end,
      href,
      raw,
      hrefStart: hrefEnd - raw.length,
      hrefEnd,
      angle,
    });
    return end;
  }

  /** Advance past whatever starts at `i`, recording a link or tag if it is one. */
  private step(i: number): number {
    const c = this.src[i];
    if (c === "<") return this.skipHtml(i);
    if (c === "#") return this.tryTag(i);
    if (c === "[" || c === "!") return this.tryLink(i);
    return this.skipEscapeOrCode(i) ?? i + 1;
  }

  /**
   * Past an inline `#tag` at `i`, recording it, or just past the `#`. Only
   * after whitespace or at a line's start, so a URL fragment, an entity or a
   * heading's `# ` never reads as one.
   */
  private tryTag(i: number): number {
    if (i > 0 && !/\s/.test(this.src[i - 1] as string)) return i + 1;
    INLINE_TAG_RE.lastIndex = i;
    const m = INLINE_TAG_RE.exec(this.src);
    if (!m) return i + 1;
    const end = Math.min(i + m[0].length, this.limit);
    this.budget -= end - i;
    const tag = normalizeTag(this.src.slice(i + 1, end));
    if (tag) this.tags.push(tag);
    return end;
  }

  /** Past a backslash escape or a code span at `i`, or null when neither starts there. */
  private skipEscapeOrCode(i: number): number | null {
    const c = this.src[i];
    if (c === "\\") return i + 2;
    return c === "`" ? this.skipCodeSpan(i) : null;
  }

  /**
   * Past raw inline HTML at `i`: a comment, or a tag with its attributes. A
   * renderer passes it through, so a `[[link]]` in a comment or a `title="…"`
   * attribute isn't one. Otherwise just past the `<`.
   */
  private skipHtml(i: number): number {
    if (this.src.startsWith("<!--", i)) return this.skipComment(i);
    if (!/[A-Za-z/]/.test(this.src[i + 1] ?? "")) return i + 1;
    // Bounded like any other look-ahead, and charged to the budget: an
    // unclosed `<a title="` mustn't make every later `<` search to the end.
    const stop = Math.min(this.limit, i + MAX_LINK_TEXT);
    const m = INLINE_HTML_TAG_RE.exec(this.src.slice(i, stop));
    this.budget -= m ? m[0].length : stop - i;
    return m ? i + m[0].length : i + 1;
  }

  /**
   * Past an HTML comment starting at `i`, or just past the `<` when it never
   * closes. The next `-->` is remembered, so a run of unclosed openers costs
   * one search rather than one each.
   */
  private skipComment(i: number): number {
    if (this.commentClose !== -1 && this.commentClose < i + 4) {
      this.commentClose = this.src.indexOf("-->", i + 4);
    }
    const close = this.commentClose;
    return close === -1 || close >= this.limit ? i + 1 : close + 3;
  }

  /** Past a link or image starting at `i`, recording a link; otherwise just past `i`. */
  private tryLink(i: number): number {
    if (this.src[i] === "!" && this.src[i + 1] !== "[") return i + 1;
    const found = this.matchWikilink(i) ?? this.matchMarkdownLink(i);
    if (!found) return i + 1;
    if (found.link) this.links.push(found.link);
    return found.end;
  }

  /** Past a backtick code span starting at `i`, or past the literal backticks if it never closes. */
  private skipCodeSpan(i: number): number {
    const src = this.src;
    const run = this.runLength(i, "`");
    for (let at = i + run; at < this.limit && this.budget > 0; at++, this.budget--) {
      // A code span can't cross a blank line.
      if (src[at] === "\n" && blankLineAt(src, at + 1)) break;
      if (src[at] !== "`") continue;
      const close = this.runLength(at, "`");
      if (close === run) return at + close;
      at += close - 1;
    }
    return i + run;
  }

  private runLength(i: number, ch: string): number {
    let n = 0;
    while (this.src[i + n] === ch) n++;
    return n;
  }

  private matchWikilink(i: number): Found | null {
    const link = wikilinkAt(this.src, i);
    if (!link || link.end > this.limit) return null;
    this.budget -= link.end - i;
    return { end: link.end, link: { kind: "wiki", ...link } };
  }

  /**
   * An inline `[text](dest "title")` or `![alt](src)` starting at `i`. Returns
   * the span either way so the caller steps over an image, but only links are
   * recorded. A reference-style link's destination is recorded at its
   * definition instead (see `definition`).
   */
  private matchMarkdownLink(i: number): Found | null {
    const image = this.src[i] === "!";
    const open = image ? i + 1 : i;
    const close = this.closingBracket(open);
    if (close === null) return null;
    if (this.src[close + 1] !== "(") return this.matchReference(open, close);
    const dest = this.destination(close + 2);
    const end = dest ? this.afterTitle(dest.next) : null;
    if (!dest || end === null) return null;
    this.budget -= end - close;
    if (image) return { end, link: null };
    const raw = this.src.slice(dest.start, dest.end);
    return {
      end,
      link: {
        kind: "markdown",
        start: i,
        end,
        href: md.utils.unescapeAll(raw),
        raw,
        hrefStart: dest.start,
        hrefEnd: dest.end,
        angle: dest.angle,
      },
    };
  }

  /**
   * A reference-style link or image whose text is `[open..close]`: `[text][ref]`,
   * `[text][]` or `[text]`. Its destination is recorded at its definition, so
   * this only steps over the text, which isn't body text a tag could be in.
   */
  private matchReference(open: number, close: number): Found | null {
    if (this.blocks.references.size === 0) return null;
    const src = this.src;
    const labelled = src[close + 1] === "[" ? this.closingDelimiter("]", close + 2) : -1;
    const named = labelled > close + 2;
    const label = named ? src.slice(close + 2, labelled) : src.slice(open + 1, close);
    if (!this.blocks.references.has(md.utils.normalizeReference(label))) return null;
    return { end: labelled === -1 ? close + 1 : labelled + 1, link: null };
  }

  /** The `]` matching the `[` at `open`, within one paragraph, or null. */
  private closingBracket(open: number): number | null {
    const src = this.src;
    const limit = Math.min(this.limit, open + MAX_LINK_TEXT);
    let depth = 0;
    for (let k = open; k < limit && this.budget > 0; this.budget--) {
      const skipped = this.skipEscapeOrCode(k);
      if (skipped !== null) {
        k = skipped;
        continue;
      }
      const ch = src[k];
      if (ch === "\n" && blankLineAt(src, k + 1)) return null;
      depth += BRACKET_DEPTH[ch as string] ?? 0;
      if (depth === 0) return k;
      k++;
    }
    return null;
  }

  /** A link destination starting at (or after spaces from) `p`. */
  private destination(p: number): Destination | null {
    const at = skipGap(this.src, p);
    if (at >= this.limit) return null;
    return this.src[at] === "<" ? this.angleDestination(at) : this.bareDestination(at);
  }

  /** `<dest>`, which may hold raw spaces and escaped brackets but not a newline or a bare `<`. */
  private angleDestination(p: number): Destination | null {
    const src = this.src;
    const stop = Math.min(this.limit, p + MAX_LINK_TEXT);
    for (let at = p + 1; at < stop; at++) {
      const ch = src[at];
      if (ch === "\\") at++;
      else if (ch === "\n" || ch === "<") break;
      else if (ch === ">") {
        this.budget -= at - p;
        return { start: p + 1, end: at, angle: true, next: at + 1 };
      }
    }
    this.budget -= stop - p;
    return null;
  }

  /** A bare destination: no spaces or controls, parentheses balanced. */
  private bareDestination(p: number): Destination {
    const src = this.src;
    const stop = Math.min(this.limit, p + MAX_LINK_TEXT);
    let parens = 0;
    let at = p;
    for (; at < stop; at++) {
      const ch = src[at] as string;
      if (ch === "\\") at++;
      else if (ch <= " ") break;
      else if (ch === "(") parens++;
      else if (ch === ")" && parens-- === 0) break;
    }
    this.budget -= at - p;
    return { start: p, end: Math.min(at, stop), angle: false, next: Math.min(at, stop) };
  }

  /** Past an optional `"title"` and the closing `)`, or null when the link doesn't close. */
  private afterTitle(p: number): number | null {
    const src = this.src;
    let at = skipGap(src, p);
    const quote = src[at];
    if (quote === '"' || quote === "'" || quote === "(") {
      const close = this.closingDelimiter(quote === "(" ? ")" : quote, at + 1);
      if (close === -1) return null;
      at = skipGap(src, close + 1);
    }
    return at < this.limit && src[at] === ")" ? at + 1 : null;
  }

  /** The first unescaped `delimiter` from `from`, within look-ahead range, or -1. */
  private closingDelimiter(delimiter: string, from: number): number {
    const src = this.src;
    const stop = Math.min(this.limit, from + MAX_LINK_TEXT);
    let at = from;
    while (at < stop && src[at] !== delimiter) at += src[at] === "\\" ? 2 : 1;
    this.budget -= Math.max(0, at - from);
    return at < stop ? at : -1;
  }
}

/**
 * Every wikilink and markdown link in a markdown document, in order, with
 * offsets into `src`. Markdown links are inline `[text](dest)` links and
 * reference definitions (`[ref]: dest`, where a reference-style link's
 * destination is written). Skips what a renderer wouldn't treat as a link:
 * front matter, code blocks and spans at any depth of lists and quotes, raw
 * HTML blocks, HTML comments, images and backslash-escaped brackets.
 */
export function scanLinks(src: string): ScannedLink[] {
  return scanNote(src).links;
}

/**
 * scanLinks, saying whether the scan reached the end. A pathological document
 * exhausts the scanner's work budget part-way (see LinkScanner), and the links
 * after that point are unknown: callers must not treat the list as complete.
 */
export function scanLinksFully(src: string): { links: ScannedLink[]; complete: boolean } {
  return scanNote(src);
}

/** Front matter longer than this isn't parsed for tags; it bounds the YAML parser's work. */
const MAX_FRONT_MATTER_FOR_TAGS = 64 * 1024;

/** The `tags` listed in front matter that ends at `end`, or none when it doesn't parse. */
function frontMatterTags(src: string, end: number): string[] {
  if (end === 0 || end > MAX_FRONT_MATTER_FOR_TAGS) return [];
  const block = src.slice(0, end).replace(/\r?\n$/, "");
  const body = block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
  try {
    const data: unknown = parseYaml(body, { maxAliasCount: 20, uniqueKeys: false });
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    return frontMatterTagList((data as Record<string, unknown>).tags);
  } catch {
    // Front matter that doesn't parse has no tags, the same as in the app.
    return [];
  }
}

export interface ScannedNote {
  links: ScannedLink[];
  /** Front-matter tags, then inline ones, each once (first spelling kept). */
  tags: string[];
  /** False when the scan's work budget ran out: links and tags after that point weren't seen. */
  complete: boolean;
}

/** Everything the index reads from a note: its links and its tags, in one pass. */
export function scanNote(src: string): ScannedNote {
  if (tooManyLines(src)) return { links: [], tags: [], complete: false };
  const first = frontMatterEnd(src);
  const scan = new LinkScanner(src, parseBlocks(src, first)).run(first);
  return { ...scan, tags: uniqueTags([...frontMatterTags(src, first), ...scan.tags]) };
}

// ---------------------------------------------------------------------------
// Index keys
// ---------------------------------------------------------------------------
//
// The backlink index stores, per source note, the set of keys its links ask
// for. A wikilink is recorded by NAME ("w:note", "w:alpha/note", "w:/x/note"
// when anchored) rather than by the file it resolves to today, because what it
// resolves to changes whenever files are created, renamed or deleted. A
// markdown link is recorded by the PATH it resolves to ("p:docs/x.md"), which
// only the source's own location can change.

/** The index key one link contributes, or null when it can't reach a file. */
function linkIndexKey(link: ScannedLink, dir: string): string | null {
  if (link.kind === "wiki") {
    const k = link.parts.target ? wikilinkKey(link.parts.target) : null;
    return k ? `w:${k.anchored ? "/" : ""}${k.key}` : null;
  }
  const ref = resolveRef(dir, link.href);
  return ref.kind === "workspace" && ref.path ? `p:${ref.path}` : null;
}

/** The index key under which a note carrying `tag` is found (see tagAncestors for nesting). */
export function tagIndexKey(tag: string): string {
  return `t:${tag}`;
}

/**
 * What the index stores for a note: the keys its links ask for, plus a `t:`
 * key for each tag and each tag it nests under, and its tags as written (for
 * listing).
 */
export function noteIndexEntry(
  src: string,
  sourcePath: string,
): { keys: string[]; tags: string[]; complete: boolean } {
  const dir = dirOf(sourcePath);
  const note = scanNote(src);
  const keys = new Set<string>();
  for (const link of note.links) {
    const key = linkIndexKey(link, dir);
    if (key) keys.add(key);
  }
  for (const tag of note.tags) for (const t of tagAncestors(tag)) keys.add(tagIndexKey(t));
  return { keys: [...keys], tags: note.tags, complete: note.complete };
}

// ---------------------------------------------------------------------------
// Rewriting links after a rename
// ---------------------------------------------------------------------------

/** A relative path from directory `fromDir` to workspace path `to`. */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
  return [...Array.from({ length: a.length - k }, () => ".."), ...b.slice(k)].join("/");
}

/**
 * Percent-encode a path for a markdown link destination. A bare destination
 * encodes everything, parentheses included (they would end the link). An
 * `<angle>` one keeps spaces readable but must still encode what the resolver
 * decodes or splits on (`%`, `#`, `?`), what markdown would decode (`\\` and
 * `&`), and the brackets that would end it.
 */
function encodeHref(path: string, angle: boolean): string {
  const segment = angle
    ? (s: string) => s.replace(/[%#?<>\n\\&]/g, (c) => encodeURIComponent(c))
    : (s: string) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return path
    .split("/")
    .map((s) => (s === ".." || s === "." ? s : segment(s)))
    .join("/");
}

export interface RelinkInput {
  content: string;
  /** Where the document lived when its links were written. */
  docPathBefore: string;
  /** Where it lives now. Differs from `docPathBefore` only for the moved file itself. */
  docPathAfter: string;
  move: { from: string; to: string };
  /** Resolve a wikilink against the workspace as it was before the move. */
  resolveBefore: WikilinkResolver;
  /** …and as it is after. */
  resolveAfter: WikilinkResolver;
  /** Whether a path existed before the move. Lets the moved file keep its own relative links. */
  existedBefore: (path: string) => boolean;
}

type Edit = { start: number; end: number; text: string };

/**
 * What one link needs: nothing, a replacement, or a rewrite that can't be
 * written (the new name can't be expressed in this link's syntax). An
 * unwritable link is left as it was and reported, never written broken.
 */
type LinkChange = null | Edit | "unwritable";

/** The new target for a wikilink that reached the moved file and no longer does. */
function wikiEdit(link: Extract<ScannedLink, { kind: "wiki" }>, input: RelinkInput): LinkChange {
  const target = link.parts.target;
  if (!target || input.resolveBefore(target) !== input.move.from) return null;
  if (input.resolveAfter(target) === input.move.to) return null;
  const text = wikilinkTargetFor(input.move.to, target, input.resolveAfter);
  if (text === null) return "unwritable";
  return {
    start: link.innerStart + link.parts.targetStart,
    end: link.innerStart + link.parts.targetEnd,
    text,
  };
}

/** The file a markdown link should reach after the move, or null to leave it alone. */
function markdownTarget(href: string, input: RelinkInput): string | null {
  const ref = resolveRef(dirOf(input.docPathBefore), href);
  if (ref.kind !== "workspace" || !ref.path) return null;
  if (ref.path === input.move.from) return input.move.to;
  const docMoved = input.docPathBefore !== input.docPathAfter;
  return docMoved && input.existedBefore(ref.path) ? ref.path : null;
}

/** Where a raw destination's query or fragment starts: `?`, `#`, or either written as an entity. */
const RAW_SUFFIX_RE = /[?#]|&(?:#35|#x23|num|#63|#x3f|quest);/i;

/** A destination for `target` in the same style as `href`, as written (relative, `./`, rooted, angle). */
function restyleHref(href: string, angle: boolean, target: string, fromDir: string): string {
  const rooted = href.startsWith("/");
  let next = rooted ? `/${target}` : relativePath(fromDir, target);
  if (!rooted && href.startsWith("./") && !next.startsWith("../")) next = `./${next}`;
  const cut = href.search(RAW_SUFFIX_RE);
  return encodeHref(next, angle) + (cut === -1 ? "" : href.slice(cut));
}

/** A `?query#fragment` as a renderer reads it, or "" when there is none. */
function decodedSuffix(raw: string): string {
  const href = md.utils.unescapeAll(raw);
  const cut = href.search(/[?#]/);
  return cut === -1 ? "" : href.slice(cut);
}

/**
 * The new destination for a markdown link, in the same style as the old one.
 * Checked by resolving it again: a destination that wouldn't reach the file is
 * reported, not written.
 */
function markdownEdit(link: MarkdownLink, input: RelinkInput): LinkChange {
  const target = markdownTarget(link.href, input);
  if (target === null) return null;
  const dirAfter = dirOf(input.docPathAfter);
  const href = restyleHref(link.raw, link.angle, target, dirAfter);
  if (href === link.raw) return null;
  const check = resolveRef(dirAfter, md.utils.unescapeAll(href));
  if (check.kind !== "workspace" || check.path !== target) return "unwritable";
  if (decodedSuffix(href) !== decodedSuffix(link.raw)) return "unwritable";
  return { start: link.hrefStart, end: link.hrefEnd, text: href };
}

/** `content` with each edit applied, assembled in one pass (edits sorted, non-overlapping). */
function applyEdits(content: string, edits: Edit[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const e of edits) {
    parts.push(content.slice(at, e.start), e.text);
    at = e.end;
  }
  parts.push(content.slice(at));
  return parts.join("");
}

export interface RelinkResult {
  content: string;
  /** Links rewritten. */
  changed: number;
  /** Links that reached the moved file but can't be written to reach its new name. */
  unwritable: number;
  /** False when the document was too pathological to scan to the end: it may hold more links. */
  complete: boolean;
}

/**
 * Rewrite the links in one document so they still reach their files after
 * `move.from` became `move.to`. Only the target of each affected link changes:
 * aliases, headings, link text and every other byte are kept. A wikilink that
 * still resolves to the moved file (a move between folders that kept its name)
 * is left exactly as written.
 *
 * For the moved file itself, its relative markdown links are re-pointed from
 * its new folder, so they keep reaching the files they reached before.
 */
export function relinkForMove(input: RelinkInput): RelinkResult {
  const edits: Edit[] = [];
  let unwritable = 0;
  const scan = scanLinksFully(input.content);
  for (const link of scan.links) {
    const change = link.kind === "wiki" ? wikiEdit(link, input) : markdownEdit(link, input);
    if (change === "unwritable") unwritable++;
    else if (change) edits.push(change);
  }
  // scanLinks reports links in document order and only their targets change,
  // so the edits are already sorted and never overlap.
  return {
    content: applyEdits(input.content, edits),
    changed: edits.length,
    unwritable,
    complete: scan.complete,
  };
}