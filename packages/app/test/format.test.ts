import { describe, expect, it } from "vite-plus/test";
import { basename, friendlyType, prettyBytes, textStats } from "../app/utils/format";

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("dir/sub/file.md")).toBe("file.md");
    expect(basename("top.md")).toBe("top.md");
    expect(basename("")).toBe("");
  });
});

describe("prettyBytes", () => {
  it("formats bytes across units", () => {
    expect(prettyBytes(0)).toBe("0 B");
    expect(prettyBytes(512)).toBe("512 B");
    expect(prettyBytes(2048)).toBe("2.0 KB");
    expect(prettyBytes(1536)).toBe("1.5 KB");
    expect(prettyBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("textStats", () => {
  it("counts lines and words", () => {
    expect(textStats("one two three")).toEqual({ lines: 1, words: 3 });
    expect(textStats("a\nb\nc")).toEqual({ lines: 3, words: 3 });
    expect(textStats("  hello   world  \n")).toEqual({ lines: 2, words: 2 });
  });
  it("handles empty / whitespace-only content", () => {
    expect(textStats("")).toEqual({ lines: 1, words: 0 });
    expect(textStats("   \n  ")).toEqual({ lines: 2, words: 0 });
  });
});

describe("friendlyType", () => {
  it("names common types in plain words", () => {
    expect(friendlyType("text/markdown")).toBe("Markdown");
    expect(friendlyType("application/pdf")).toBe("PDF");
  });

  it("describes media by format and family", () => {
    expect(friendlyType("image/png")).toBe("PNG image");
    expect(friendlyType("video/mp4")).toBe("MP4 video");
  });

  it("falls back to the raw type", () => {
    expect(friendlyType("application/x-unknown")).toBe("application/x-unknown");
  });
});