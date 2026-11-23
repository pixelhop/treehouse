// Tags on notes: what counts as a tag, and when two tags are the same one.
// Shared because the server indexes tags and the app filters by them, and the
// two must agree on what `#Project/Alpha` matches.
//
// A note's tags come from its front matter (`tags: [a, b]`, or `tags: a, b`)
// and from inline `#tag`s in its body. Finding the inline ones needs the block
// structure of the note (a `#tag` in a code block isn't one), so that is done
// by the scanner in ./linkScan, on the server.
//
// Rules, close to Obsidian's so a synced vault behaves the same:
//   - case-insensitive: `#Planning` and `#planning` are one tag (shown as first
//     written);
//   - an inline tag is `#` then letters (with any combining marks), digits, `_`,
//     `-` or `/`, with at least
//     one character that isn't a digit (`#2026` is a number, not a tag), and
//     must follow whitespace or start a line (so `page#section` and `&#35;`
//     aren't tags, and `# Heading` isn't one either);
//   - `/` nests: `#project/alpha` is also under `#project`, so filtering by
//     `project` finds it.

/** The longest tag kept. Anything longer is almost certainly not one. */
const MAX_TAG_LENGTH = 100;

/** Characters an inline tag may contain. */
const TAG_CHAR = String.raw`[\p{L}\p{M}\p{N}_\-/]`;

/** An inline `#tag` at a given offset (sticky), capturing the tag without its `#`. */
export const INLINE_TAG_RE = new RegExp(`#(${TAG_CHAR}+)`, "uy");

/**
 * A tag as written, tidied: no leading `#`, no surrounding whitespace or
 * slashes, no empty nesting level (`a//b` is `a/b`), NFC. Null when nothing is
 * left or it's too long. For looking a tag up: `2026` is a fair thing to ask
 * for, since `#2026/planning` is filed under it.
 */
export function tidyTag(raw: string): string | null {
  const tag = raw
    .normalize("NFC")
    .trim()
    .replace(/^#+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "")
    .trim();
  return tag && tag.length <= MAX_TAG_LENGTH && !/[\n\r]/.test(tag) ? tag : null;
}

/** tidyTag, for a tag a note carries: digits alone (`#2026`) are a number, not a tag. */
export function normalizeTag(raw: string): string | null {
  const tag = tidyTag(raw);
  return tag && !/^\p{N}+$/u.test(tag) ? tag : null;
}

/** The key two tags share when they're the same tag. */
export function tagKey(tag: string): string {
  return tag.normalize("NFC").toLowerCase();
}

/** `project/alpha/v2` → `project`, `project/alpha`, `project/alpha/v2`: every tag it falls under. */
export function tagAncestors(tag: string): string[] {
  const segs = tagKey(tag).split("/").filter(Boolean);
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}

/** Tags from a front-matter `tags` value: a list, or text separated by commas. */
export function frontMatterTagList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" && typeof item !== "number") continue;
    const tag = normalizeTag(String(item));
    if (tag) out.push(tag);
  }
  return out;
}

/** `tags` with duplicates (by key) removed, keeping each one's first spelling. */
export function uniqueTags(tags: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const t of tags) if (!seen.has(tagKey(t))) seen.set(tagKey(t), t);
  return [...seen.values()];
}