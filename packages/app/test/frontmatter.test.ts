import { describe, expect, it } from "vite-plus/test";
import { joinFrontMatter, splitFrontMatter } from "../app/utils/frontmatter";

describe("splitFrontMatter", () => {
  it("peels a leading YAML front-matter block verbatim", () => {
    const src = "---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n\ntext\n";
    const { frontMatter, body } = splitFrontMatter(src);
    expect(frontMatter).toBe("---\ntitle: Hello\ntags: [a, b]\n---\n");
    expect(body).toBe("# Body\n\ntext\n");
  });

  it("returns no front-matter and the full body when there is none", () => {
    const src = "# Heading\n\nJust a normal doc.\n";
    const { frontMatter, body } = splitFrontMatter(src);
    expect(frontMatter).toBe("");
    expect(body).toBe(src);
  });

  it("does not treat a mid-document --- horizontal rule as front-matter", () => {
    const src = "# Heading\n\n---\n\nMore text\n";
    const { frontMatter, body } = splitFrontMatter(src);
    expect(frontMatter).toBe("");
    expect(body).toBe(src);
  });

  it("does not eat content when the opening fence has no closing fence", () => {
    const src = "---\ntitle: unterminated\n\nbody with no closing fence\n";
    const { frontMatter, body } = splitFrontMatter(src);
    expect(frontMatter).toBe("");
    expect(body).toBe(src);
  });

  it("handles an empty front-matter block", () => {
    const src = "---\n---\nbody\n";
    const { frontMatter, body } = splitFrontMatter(src);
    expect(frontMatter).toBe("---\n---\n");
    expect(body).toBe("body\n");
  });
});

describe("joinFrontMatter", () => {
  it("re-attaches front-matter byte-for-byte (round-trip)", () => {
    const src = "---\ntitle: Hello\n---\n# Body\ntext\n";
    const { frontMatter, body } = splitFrontMatter(src);
    expect(joinFrontMatter(frontMatter, body)).toBe(src);
  });

  it("is a no-op prefix when there is no front-matter", () => {
    expect(joinFrontMatter("", "# Body\n")).toBe("# Body\n");
  });
});