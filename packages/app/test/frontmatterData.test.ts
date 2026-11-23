import { describe, expect, it } from "vite-plus/test";
import { splitFrontMatter } from "../app/utils/frontmatter";
import { parseFrontMatter, serializeFrontMatter } from "../app/utils/frontmatterData";
import { frontMatterFieldKind } from "../app/utils/frontmatterFields";

const block = (inner: string) => `---\n${inner}\n---\n`;

describe("parseFrontMatter", () => {
  it("parses a well-formed block (scalars, arrays, booleans, dates)", () => {
    const data = parseFrontMatter(
      block("title: Hello\nstatus: draft\ncount: 5\ndraft: true\ntags:\n  - a\n  - b"),
    );
    expect(data).toEqual({
      title: "Hello",
      status: "draft",
      count: 5,
      draft: true,
      tags: ["a", "b"],
    });
  });

  it("keeps dates as strings (no Date/ISO coercion)", () => {
    const data = parseFrontMatter(block("date: 2026-06-09\nwhen: 2026-06-09T10:00:00Z"));
    expect(data).toEqual({ date: "2026-06-09", when: "2026-06-09T10:00:00Z" });
  });

  it("returns null for an empty block", () => {
    expect(parseFrontMatter(block(""))).toBeNull();
    expect(parseFrontMatter("")).toBeNull();
  });

  it("returns null when the block is not valid YAML", () => {
    expect(parseFrontMatter(block("foo: [1, 2"))).toBeNull();
  });

  it("returns null when the block parses to a non-map", () => {
    expect(parseFrontMatter(block("just a string"))).toBeNull();
    expect(parseFrontMatter(block("- a\n- b"))).toBeNull();
  });

  it("drops prototype-pollution keys and never pollutes Object.prototype", () => {
    const data = parseFrontMatter(block("__proto__:\n  polluted: true\nsafe: 1"));
    expect(data).toEqual({ safe: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("serializeFrontMatter", () => {
  it("produces a --- block that splitFrontMatter round-trips as one block", () => {
    const out = serializeFrontMatter({ title: "Hello", tags: ["a", "b"] });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("---\n")).toBe(true);
    const split = splitFrontMatter(out);
    expect(split.frontMatter).toBe(out);
    expect(split.body).toBe("");
  });

  it("round-trips values: parse(serialize(data)) deep-equals data", () => {
    const data = {
      title: "Hello",
      count: 5,
      draft: true,
      date: "2026-06-09",
      tags: ["x", "y"],
    };
    expect(parseFrontMatter(serializeFrontMatter(data))).toEqual(data);
  });

  it("drops YAML comments on re-serialization while preserving values (R7)", () => {
    const data = parseFrontMatter(block("# a leading comment\ntitle: Hello # trailing\ncount: 5"));
    expect(data).toEqual({ title: "Hello", count: 5 });
    const out = serializeFrontMatter(data!);
    expect(out).not.toContain("#");
    expect(out).toContain("title: Hello");
    expect(out).toContain("count: 5");
  });
});

describe("frontMatterFieldKind", () => {
  it("classifies each top-level value type", () => {
    expect(frontMatterFieldKind("plain")).toBe("scalar");
    expect(frontMatterFieldKind(5)).toBe("scalar");
    expect(frontMatterFieldKind(true)).toBe("boolean");
    expect(frontMatterFieldKind("2026-06-09")).toBe("date");
    expect(frontMatterFieldKind(["a", "b"])).toBe("array");
    expect(frontMatterFieldKind([1, 2, 3])).toBe("array");
    expect(frontMatterFieldKind({ nested: true })).toBe("complex");
    expect(frontMatterFieldKind([{ a: 1 }])).toBe("complex");
  });
});