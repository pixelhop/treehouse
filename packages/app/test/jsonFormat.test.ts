import { describe, expect, it } from "vite-plus/test";
import { formatMinifiedJson } from "../app/utils/jsonFormat";

describe("formatMinifiedJson", () => {
  it("lays out one-line JSON with two-space indentation", () => {
    expect(formatMinifiedJson('{"a":1,"b":[true,null],"c":{"d":"x"}}')).toBe(
      [
        "{",
        '  "a": 1,',
        '  "b": [',
        "    true,",
        "    null",
        "  ],",
        '  "c": {',
        '    "d": "x"',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("keeps values exactly as written", () => {
    const out = formatMinifiedJson('{"id":12345678901234567890,"v":1.0,"e":1E3}');
    expect(out).toContain("12345678901234567890");
    expect(out).toContain('"v": 1.0');
    expect(out).toContain('"e": 1E3');
  });

  it("leaves structural characters inside strings alone", () => {
    expect(formatMinifiedJson('{"s":"a, {b}: [c] \\"q\\" \\\\"}')).toBe(
      '{\n  "s": "a, {b}: [c] \\"q\\" \\\\"\n}',
    );
  });

  it("keeps empty objects and arrays on one line", () => {
    expect(formatMinifiedJson('{"a":{},"b":[ ]}')).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it("returns null for JSON that already spans lines, invalid JSON and empty text", () => {
    expect(formatMinifiedJson('{\n"a":1}')).toBeNull();
    expect(formatMinifiedJson('{"a":')).toBeNull();
    expect(formatMinifiedJson("")).toBeNull();
  });
});