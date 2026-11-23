// Data-level front-matter handling: parse a leading YAML block into a plain
// object and serialize an edited object back into a `---`-delimited block.
// Display classification lives in frontmatterFields.ts, which doesn't need the
// YAML parser. Eagerly loaded code should reach this module through
// `loadFrontMatterData()` there, so the parser stays out of the first load.
//
// This sits one layer above `frontmatter.ts` (which only splits/joins the block
// as an opaque string). Parsing is lossless for the read path — it never
// rewrites the file. Serialization is only used on the edit path: re-emitting
// the whole block is accepted to drop comments / normalize quoting (KTD3), and
// values are preserved.
//
// Security: front matter is written by agents and humans and is therefore
// untrusted. `parseFrontMatter` rebuilds the top level into a clean object and
// drops the prototype-pollution vectors (`__proto__`, `constructor`,
// `prototype`). Callers must still render keys AND values as text, never v-html.
import { parse, stringify } from "yaml";
import { joinFrontMatter, splitFrontMatter } from "./frontmatter";

export type FrontMatterData = Record<string, unknown>;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Strip the opening/closing `---` fence lines, returning the inner YAML text. */
function innerYaml(block: string): string {
  const norm = block.replace(/\r\n/g, "\n");
  const match = norm.match(/^---\n([\s\S]*?)\n?---\n?$/);
  return match?.[1] ?? norm;
}

/**
 * Parse a front-matter block (as produced by `splitFrontMatter`) into a plain
 * object. Returns `null` when the block is empty, is not valid YAML, or does not
 * parse to a mapping (front matter is conventionally a map) — callers treat
 * `null` as "unparseable, fall back" and must never dump the raw block into a
 * rendered body.
 *
 * The default `yaml` schema is YAML 1.2 core, which has no timestamp type, so a
 * `date: 2026-06-09` value parses (and re-serializes) as the string
 * `"2026-06-09"` rather than a coerced JS `Date`/ISO instant — keeping unchanged
 * fields textually stable across an edit (KTD3/KTD7).
 */
export function parseFrontMatter(block: string): FrontMatterData | null {
  const inner = innerYaml(block);
  if (inner.trim() === "") return null;

  let doc: unknown;
  try {
    doc = parse(inner);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;

  // Rebuild the top level into a fresh null-prototype object. Iterating
  // own-enumerable entries excludes any prototype YAML may have reparented via a
  // `__proto__` key, the explicit denylist drops `constructor`/`prototype` if
  // present as data, and the null prototype means nothing can pollute through it.
  const out: FrontMatterData = Object.create(null);
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Serialize an edited object back into a `---`-delimited block (trailing
 * newline included, matching `frontmatter.ts`'s block contract). Only ever
 * called on the edit path. */
export function serializeFrontMatter(data: FrontMatterData): string {
  const body = stringify(data); // yaml.stringify emits a trailing newline
  return `---\n${body}---\n`;
}

/**
 * Patch top-level keys in a markdown source's front matter, returning the new
 * source. The write path behind the calendar's drag-to-reschedule and every
 * board action (a card's `status`/`order`/`assignee`, a folder README's
 * `view`/`columns`). A patch value of `undefined` removes the key.
 *
 * The body is left untouched; only the front-matter block is re-serialized
 * (inheriting the accepted reformat-on-edit cost — comments/key-order may
 * normalize, KTD3). When the file has no block, one is created carrying just the
 * patched keys. When nothing would change, the original source is returned
 * byte-for-byte so a no-op edit never rewrites the file.
 *
 * Throws when an existing front-matter block is present but does not parse to a
 * YAML mapping — callers surface this rather than silently dropping the block.
 */
export function setFrontMatterFields(source: string, patch: Record<string, unknown>): string {
  const { frontMatter, body } = splitFrontMatter(source);
  let data: FrontMatterData;
  if (frontMatter) {
    const parsed = parseFrontMatter(frontMatter);
    if (parsed === null) {
      throw new Error("Cannot edit front matter: it is not a valid YAML mapping");
    }
    data = parsed;
  } else {
    data = Object.create(null);
  }
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (value === undefined) {
      if (key in data) {
        delete data[key];
        changed = true;
      }
    } else if (!sameValue(data[key], value)) {
      data[key] = value;
      changed = true;
    }
  }
  if (!changed) return source;
  // Removing the last key leaves no block at all rather than an empty `---\n---`.
  if (Object.keys(data).length === 0) return body;
  return joinFrontMatter(serializeFrontMatter(data), body);
}

/** Structural equality for plain YAML values (scalars, arrays, maps). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Set the `date` key in a markdown source's front matter, returning the new
 * source. Used by the calendar's drag-to-reschedule write path; see
 * `setFrontMatterFields` for the byte-identity and error contract.
 */
export function setFrontMatterDate(source: string, date: string): string {
  return setFrontMatterFields(source, { date });
}