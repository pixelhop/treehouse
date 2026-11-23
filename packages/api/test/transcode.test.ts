import { describe, expect, it } from "vite-plus/test";
import { decodeContent, encodeContent } from "../server/utils/transcode";

// A tiny but real non-UTF-8 binary: PNG signature + some high bytes.
const binary = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80,
]);

describe("transcode", () => {
  it("defaults to utf8 for text round-trips", () => {
    const text = "# Hello\n\nsome **markdown** — café 🚀\n";
    expect(encodeContent(decodeContent(text))).toBe(text);
    expect(decodeContent(text)).toEqual(new TextEncoder().encode(text));
  });

  it("round-trips arbitrary binary bytes via base64 without corruption", () => {
    const b64 = encodeContent(binary, "base64");
    expect(decodeContent(b64, "base64")).toEqual(binary);
  });

  it("base64 decode of binary differs from a utf8 decode (the corruption it prevents)", () => {
    // Decoding raw binary as utf8 mangles the high bytes; base64 preserves them.
    const asUtf8 = encodeContent(binary, "utf8");
    const reUtf8 = decodeContent(asUtf8, "utf8");
    expect(reUtf8).not.toEqual(binary); // lossy — this is the bug base64 avoids
    expect(decodeContent(encodeContent(binary, "base64"), "base64")).toEqual(binary); // lossless
  });

  it("produces valid standard base64 for the bytes", () => {
    expect(encodeContent(new Uint8Array([1, 2, 3]), "base64")).toBe("AQID");
    expect(decodeContent("AQID", "base64")).toEqual(new Uint8Array([1, 2, 3]));
  });
});