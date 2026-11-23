import { Buffer, isUtf8 } from "node:buffer";

// Find-and-replace edits for the partial-edit path (`edit_file`), kept free of
// the database and blob store so the matching rules can be unit-tested on
// their own; the file service owns reading, versioning and the write itself.
//
// Edits work on the file's UTF-8 bytes, not a decoded string. UTF-8 is
// self-synchronising, so a byte match of valid text is a character match, and
// working in bytes keeps memory to the input plus one exactly-sized output per
// edit: no UTF-16 copy of the file, and no array with an entry per match (a
// replaceAll of a one-letter string in a large file would otherwise build
// millions of them).

export interface TextEdit {
  oldString: string;
  newString: string;
  /** Replace every occurrence. Without it, oldString must match exactly once. */
  replaceAll?: boolean;
}

/** Why an edit could not be applied. `index` is the 0-based edit that failed. */
export type EditFailure =
  | { reason: "empty_old_string"; index: number }
  | { reason: "no_change"; index: number }
  | { reason: "not_found"; index: number }
  | { reason: "ambiguous"; index: number; matches: number }
  | { reason: "too_large"; index: number; limit: number };

export type EditOutcome =
  | { ok: true; body: Uint8Array; replacements: number }
  | ({ ok: false } & EditFailure);

/**
 * Whether a file's bytes are editable text: valid UTF-8 with no NUL byte (valid
 * UTF-8, but the mark of a binary file). Checked without decoding the file.
 */
export function isEditableText(body: Uint8Array): boolean {
  return !body.includes(0) && isUtf8(body);
}

// A Buffer view of the same memory, for its byte-wise indexOf and copy.
const view = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

// Non-overlapping matches: the ones a replaceAll replaces. Each search resumes
// past the previous match, so the total work is linear in the file. (Counting
// overlapping matches would re-scan the needle at every byte: a 1 MiB
// oldString of one repeated letter in a file of that letter is ~10^12
// comparisons, on the event loop.)
function countMatches(hay: Buffer, needle: Buffer): number {
  let count = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

// Whether a single match is ambiguous because it overlaps another, as "aa"
// does in "aaa": replacing one would be a guess about which was meant. One
// extra search, never a count.
function overlapsAnother(hay: Buffer, needle: Buffer): boolean {
  return hay.indexOf(needle, hay.indexOf(needle) + 1) !== -1;
}

// Replace the first `count` non-overlapping matches into a buffer allocated at
// its final size.
function replaceInto(src: Buffer, from: Buffer, to: Buffer, count: number, size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let read = 0;
  let written = 0;
  for (let n = 0, at = src.indexOf(from); n < count && at !== -1; n++) {
    written += src.copy(out, written, read, at);
    written += to.copy(out, written);
    read = at + from.length;
    at = src.indexOf(from, read);
  }
  src.copy(out, written, read);
  return out;
}

/**
 * The first edit that is malformed whatever the file holds: an empty oldString
 * (which would match everywhere) or a replacement identical to its target.
 */
export function findInvalidEdit(
  edits: readonly TextEdit[],
): Extract<EditFailure, { reason: "empty_old_string" | "no_change" }> | undefined {
  for (const [index, edit] of edits.entries()) {
    if (edit.oldString === "") return { reason: "empty_old_string", index };
    if (edit.oldString === edit.newString) return { reason: "no_change", index };
  }
  return undefined;
}

/**
 * Apply edits to UTF-8 text in order, each to the result of the one before,
 * all or nothing. The first edit that can't be applied fails the whole call.
 *
 * `maxBytes` bounds every intermediate result, checked BEFORE it is allocated:
 * chained replaceAll edits (a -> aa, again and again) would otherwise double
 * the text each time and exhaust the process long before the size check on
 * the final write.
 */
export function applyTextEdits(
  body: Uint8Array,
  edits: readonly TextEdit[],
  maxBytes = Number.POSITIVE_INFINITY,
): EditOutcome {
  const invalid = findInvalidEdit(edits);
  if (invalid) return { ok: false, ...invalid };
  let out = view(body);
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    const from = Buffer.from(edit.oldString, "utf8");
    const to = Buffer.from(edit.newString, "utf8");
    const count = countMatches(out, from);
    if (count === 0) return { ok: false, reason: "not_found", index };
    if (!edit.replaceAll && (count > 1 || overlapsAnother(out, from))) {
      return { ok: false, reason: "ambiguous", index, matches: Math.max(count, 2) };
    }
    const size = out.length + count * (to.length - from.length);
    if (size > maxBytes) return { ok: false, reason: "too_large", index, limit: maxBytes };
    out = replaceInto(out, from, to, count, size);
    replacements += count;
  }
  return { ok: true, body: out, replacements };
}