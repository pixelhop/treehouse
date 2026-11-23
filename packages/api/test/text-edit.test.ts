import { describe, expect, it } from "vite-plus/test";
import {
  applyTextEdits,
  findInvalidEdit,
  isEditableText,
  type TextEdit,
} from "../server/utils/textEdit";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// applyTextEdits works on bytes; these tests read and write text.
function apply(text: string, edits: TextEdit[], maxBytes?: number) {
  const r = applyTextEdits(enc(text), edits, maxBytes);
  return r.ok ? { ok: true, text: dec(r.body), replacements: r.replacements } : r;
}

describe("applyTextEdits", () => {
  it("replaces a unique match", () => {
    expect(apply("one two three", [{ oldString: "two", newString: "2" }])).toEqual({
      ok: true,
      text: "one 2 three",
      replacements: 1,
    });
  });

  it("deletes with an empty newString", () => {
    const r = apply("keep drop keep", [{ oldString: " drop", newString: "" }]);
    expect(r).toMatchObject({ ok: true, text: "keep keep" });
  });

  it("matches and replaces multi-byte text", () => {
    expect(apply("café — naïve 🌳", [{ oldString: "naïve 🌳", newString: "ø" }])).toMatchObject({
      ok: true,
      text: "café — ø",
    });
  });

  it("reports a missing oldString", () => {
    expect(apply("abc", [{ oldString: "xyz", newString: "q" }])).toEqual({
      ok: false,
      reason: "not_found",
      index: 0,
    });
  });

  it("refuses an ambiguous match and says how many there are", () => {
    expect(apply("a-a-a", [{ oldString: "a", newString: "b" }])).toEqual({
      ok: false,
      reason: "ambiguous",
      index: 0,
      matches: 3,
    });
  });

  it("counts overlapping matches as ambiguous", () => {
    expect(apply("aaa", [{ oldString: "aa", newString: "b" }])).toMatchObject({
      ok: false,
      reason: "ambiguous",
      matches: 2,
    });
  });

  it("detects ambiguity in linear time, even for self-overlapping needles", () => {
    // ~7 million overlapping matches if counted one by one; a quadratic count
    // here would block the event loop for hours.
    const hay = new Uint8Array(8 * 1024 * 1024).fill(0x61);
    const started = performance.now();
    const r = applyTextEdits(hay, [{ oldString: "a".repeat(1024 * 1024), newString: "b" }]);
    expect(r).toMatchObject({ ok: false, reason: "ambiguous", matches: 8 });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("replaceAll changes every occurrence", () => {
    expect(apply("a-a-a", [{ oldString: "a", newString: "b", replaceAll: true }])).toEqual({
      ok: true,
      text: "b-b-b",
      replacements: 3,
    });
  });

  it("replaceAll counts the matches it actually replaces, without overlaps", () => {
    expect(apply("aaaa", [{ oldString: "aa", newString: "b", replaceAll: true }])).toEqual({
      ok: true,
      text: "bb",
      replacements: 2,
    });
  });

  it("replaceAll still fails when there is nothing to replace", () => {
    expect(apply("abc", [{ oldString: "z", newString: "y", replaceAll: true }])).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("treats $ patterns in newString literally", () => {
    expect(apply("x", [{ oldString: "x", newString: "$&$1$$" }])).toMatchObject({
      text: "$&$1$$",
    });
    expect(apply("x x", [{ oldString: "x", newString: "$&", replaceAll: true }])).toMatchObject({
      text: "$& $&",
    });
  });

  it("applies several edits in order, each to the previous result", () => {
    const r = apply("alpha beta", [
      { oldString: "alpha", newString: "gamma" },
      { oldString: "gamma beta", newString: "done" },
    ]);
    expect(r).toEqual({ ok: true, text: "done", replacements: 2 });
  });

  it("fails the whole batch on the first edit that can't apply, naming it", () => {
    const r = apply("alpha beta", [
      { oldString: "alpha", newString: "gamma" },
      { oldString: "missing", newString: "x" },
    ]);
    expect(r).toEqual({ ok: false, reason: "not_found", index: 1 });
  });

  it("leaves a byte-order mark in place", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("x y")]);
    const r = applyTextEdits(bom, [{ oldString: "y", newString: "z" }]);
    expect(r.ok && [...r.body]).toEqual([0xef, 0xbb, 0xbf, ...enc("x z")]);
  });

  it("refuses growth past maxBytes before building the result", () => {
    // Chained doubling: 2, 4, 8, ... bytes. Without a bound, 28 of these reach
    // 256 MiB from a one-byte file.
    const doubling = Array.from({ length: 28 }, () => ({
      oldString: "a",
      newString: "aa",
      replaceAll: true,
    }));
    expect(apply("a", doubling, 1000)).toEqual({
      ok: false,
      reason: "too_large",
      index: 9, // the 10th doubling (0-based 9) would reach 1024 > 1000
      limit: 1000,
    });
    expect(apply("abc", [{ oldString: "b", newString: "x".repeat(10) }], 10)).toMatchObject({
      ok: false,
      reason: "too_large",
      index: 0,
    });
    // The limit counts bytes, not characters: "é" is two.
    expect(apply("ab", [{ oldString: "b", newString: "éé" }], 4)).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    // Exactly at the limit is fine.
    expect(apply("abc", [{ oldString: "b", newString: "bcdefghi" }], 10)).toMatchObject({
      ok: true,
      text: "abcdefghic",
    });
  });

  it("rejects an empty oldString and a no-op edit", () => {
    expect(findInvalidEdit([{ oldString: "", newString: "x" }])).toEqual({
      reason: "empty_old_string",
      index: 0,
    });
    expect(
      findInvalidEdit([
        { oldString: "a", newString: "b" },
        { oldString: "same", newString: "same" },
      ]),
    ).toEqual({ reason: "no_change", index: 1 });
    expect(apply("abc", [{ oldString: "", newString: "x" }])).toMatchObject({
      ok: false,
      reason: "empty_old_string",
    });
  });
});

describe("isEditableText", () => {
  it("accepts UTF-8 text, with or without a byte-order mark", () => {
    expect(isEditableText(enc("héllo 🌳"))).toBe(true);
    expect(isEditableText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("x")]))).toBe(true);
    expect(isEditableText(new Uint8Array())).toBe(true);
  });

  it("rejects invalid UTF-8 and NUL bytes", () => {
    expect(isEditableText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
    expect(isEditableText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG magic
    expect(isEditableText(enc("a\u0000b"))).toBe(false);
  });
});