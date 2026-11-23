// Links between notes: Obsidian-style `[[wikilinks]]` and relative markdown
// links. Shared because three places must agree on what a link points at: the
// app's viewer and editor (which render and route links), and the API (which
// indexes them for backlinks and rewrites them when a file is renamed). If any
// two of those disagreed, a note could list a backlink that its source doesn't
// visibly make, or a rename could "fix" a link to point somewhere else.
//
// This module is the syntax and the resolution rules. Finding every link in a
// document, and rewriting them, is in ./linkScan, which the server imports on
// its own: it needs a markdown parser the app has no use for.
//
// Everything here is pure: no DOM, no database.
//
// Resolution rules for a wikilink target:
//   - case-insensitive, and the `.md` extension is optional (`[[Note]]` and
//     `[[note.md]]` both reach `Note.md`);
//   - the target matches any file whose trailing path segments equal it, so
//     `[[Note]]` and `[[Alpha/Note]]` both reach `Projects/Alpha/Note.md`;
//   - a leading slash anchors the target at the workspace root;
//   - several matches resolve to the shallowest, then shortest, then
//     alphabetically first path. Deterministic, which is what matters: Obsidian
//     users are already used to qualifying an ambiguous name with its folder.
import { isMarkdownPath, withoutMarkdownExtension } from "./fileTypes";

// ---------------------------------------------------------------------------
// Wikilink syntax
// ---------------------------------------------------------------------------

/**
 * The body of a wikilink: anything up to the first `]]` that holds no bracket or
 * newline, so `[[a]] [[b]]` is two links rather than one greedy match. The
 * viewer's tokenizer, the editor's tokenizer and the scanner below all use it.
 */
const WIKILINK_BODY = String.raw`\[\[([^\[\]\n]+?)\]\]`;

/** A wikilink (or `![[embed]]`) at the very start of a string. */
export const WIKILINK_START_RE = new RegExp(`^(!?)${WIKILINK_BODY}`);

const WIKILINK_AT_RE = new RegExp(`(!?)${WIKILINK_BODY}`, "y");

export interface WikilinkParts {
  /** The note named, as authored minus alias and heading. "" for `[[#Heading]]`. */
  target: string;
  /** The `#heading` portion, or null. */
  fragment: string | null;
  /** The `|alias` display text, or null. */
  alias: string | null;
  /** Where `target` sits inside the inner text, so a rename can swap just it. */
  targetStart: number;
  targetEnd: number;
}

/**
 * Split the inside of `[[…]]` into target, heading and alias (Obsidian order:
 * `target#heading|alias`). A `\|` separator — how Obsidian writes a wikilink
 * inside a table cell — counts as the alias separator too.
 */
export function parseWikilinkInner(inner: string): WikilinkParts {
  const pipe = inner.indexOf("|");
  const escaped = pipe > 0 && inner[pipe - 1] === "\\";
  const head = pipe === -1 ? inner : inner.slice(0, escaped ? pipe - 1 : pipe);
  const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
  const hash = head.indexOf("#");
  const rawTarget = hash === -1 ? head : head.slice(0, hash);
  const lead = rawTarget.length - rawTarget.trimStart().length;
  const target = rawTarget.trim();
  const fragment = hash === -1 ? null : head.slice(hash + 1).trim() || null;
  return { target, fragment, alias, targetStart: lead, targetEnd: lead + target.length };
}

/** What a wikilink shows: its alias, else its target (and heading). */
export function wikilinkLabel(parts: Pick<WikilinkParts, "target" | "fragment" | "alias">): string {
  if (parts.alias) return parts.alias;
  if (!parts.target) return parts.fragment ?? "";
  return parts.fragment ? `${parts.target} > ${parts.fragment}` : parts.target;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const MD_EXT_RE = /\.(md|markdown)$/i;

/**
 * Lower-cased, NFC-normalized segments with the markdown extension dropped from
 * the last one. NFC because macOS hands the sync client decomposed file names,
 * and an "é" typed into a note is composed. Null for anything that isn't a
 * clean relative path (traversal, backslashes), matching the path rules.
 */
function normalizeKey(raw: string): string | null {
  if (raw.includes("\\") || raw.includes("\0")) return null;
  const segs = raw
    .normalize("NFC")
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segs.length === 0 || segs.includes("..")) return null;
  const last = segs.length - 1;
  segs[last] = (segs[last] as string).replace(MD_EXT_RE, "") || (segs[last] as string);
  return segs.join("/");
}

/** The lookup key a wikilink target asks for, or null when it can't name a file. */
export function wikilinkKey(target: string): { key: string; anchored: boolean } | null {
  const t = target.trim();
  const key = normalizeKey(t);
  return key ? { key, anchored: t.startsWith("/") } : null;
}

/** Shallowest, then shortest, then alphabetically first. */
function preferred(a: string, b: string): string {
  const da = a.split("/").length;
  const db = b.split("/").length;
  if (da !== db) return da < db ? a : b;
  if (a.length !== b.length) return a.length < b.length ? a : b;
  return a <= b ? a : b;
}

export type WikilinkResolver = (target: string) => string | null;

/**
 * Build a resolver over a list of workspace paths. Precomputes every trailing
 * run of segments once, so each lookup is a map hit — cheap enough to call per
 * link in a large workspace. Pass only the paths the reader may see: resolving
 * against files someone else keeps private would route a link differently for
 * them, which is itself a disclosure.
 */
export function createWikilinkResolver(paths: Iterable<string>): WikilinkResolver {
  const bySuffix = new Map<string, string>();
  const byFull = new Map<string, string>();
  const keep = (map: Map<string, string>, key: string, path: string) => {
    const held = map.get(key);
    map.set(key, held === undefined ? path : preferred(held, path));
  };
  for (const path of paths) {
    const key = normalizeKey(path);
    if (!key) continue;
    keep(byFull, key, path);
    const segs = key.split("/");
    for (let i = 0; i < segs.length; i++) keep(bySuffix, segs.slice(i).join("/"), path);
  }
  return (target) => {
    const k = wikilinkKey(target);
    if (!k) return null;
    return (k.anchored ? byFull : bySuffix).get(k.key) ?? null;
  };
}

/** A wikilink found in a document. */
export interface WikilinkMatch {
  /** Offsets of the whole `[[…]]`, including a leading `!`. */
  start: number;
  end: number;
  embed: boolean;
  /** Offset of the inner text (just after `[[`). */
  innerStart: number;
  parts: WikilinkParts;
}

/**
 * The wikilink starting exactly at `i` (at its `!` for an embed), or null.
 * `[[]]` and `[[|x]]` name nothing, so they aren't links.
 */
export function wikilinkAt(src: string, i: number): WikilinkMatch | null {
  WIKILINK_AT_RE.lastIndex = i;
  const m = WIKILINK_AT_RE.exec(src);
  if (!m) return null;
  const parts = parseWikilinkInner(m[2] as string);
  if (!parts.target && !parts.fragment) return null;
  const embed = m[1] === "!";
  return { start: i, end: i + m[0].length, embed, innerStart: i + (embed ? 3 : 2), parts };
}

/**
 * The index keys under which a link to `path` would have been recorded. Each
 * wikilink key comes with the target text that produced it, because a name
 * match is only a candidate: `[[Note]]` reaches this file only if no shallower
 * `Note.md` wins, which the caller checks with a resolver.
 */
export function incomingLinkKeys(path: string): { key: string; wikilink: string | null }[] {
  const out: { key: string; wikilink: string | null }[] = [{ key: `p:${path}`, wikilink: null }];
  const full = normalizeKey(path);
  if (!full) return out;
  const segs = full.split("/");
  for (let i = 0; i < segs.length; i++) {
    const suffix = segs.slice(i).join("/");
    out.push({ key: `w:${suffix}`, wikilink: suffix });
  }
  out.push({ key: `w:/${full}`, wikilink: `/${full}` });
  return out;
}

/**
 * Whether `target` survives being written inside `[[…]]` and read back: no
 * brackets, no `#` or `|` (they would start a heading or an alias), no
 * surrounding whitespace (trimmed on read) and nothing the resolver rejects.
 */
function writableWikilinkTarget(target: string): boolean {
  if (/[[\]#|\n\\]/.test(target) || target !== target.trim()) return false;
  return parseWikilinkInner(target).target === target;
}

/**
 * The shortest wikilink target that reaches `path`: its name alone when that is
 * unambiguous, otherwise as many parent folders as it takes. Keeps an explicit
 * `.md` only if the link being replaced had one. Null when no wikilink can name
 * the file: a name containing `#`, `|` or a bracket can't be written as one.
 */
export function wikilinkTargetFor(
  path: string,
  previous: string,
  resolve: WikilinkResolver,
): string | null {
  const segs = path.split("/");
  const name = segs[segs.length - 1] as string;
  const keepExt = MD_EXT_RE.test(previous.trim()) || !isMarkdownPath(name);
  const leaf = keepExt ? name : withoutMarkdownExtension(name);
  for (let i = segs.length - 1; i >= 0; i--) {
    const candidate = [...segs.slice(i, -1), leaf].join("/");
    if (writableWikilinkTarget(candidate) && resolve(candidate) === path) return candidate;
  }
  return null;
}