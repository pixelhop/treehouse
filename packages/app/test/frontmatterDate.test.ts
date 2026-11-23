import { describe, expect, it } from "vite-plus/test";
import { splitFrontMatter } from "../app/utils/frontmatter";
import {
  parseFrontMatter,
  setFrontMatterDate,
  setFrontMatterFields,
} from "../app/utils/frontmatterData";

describe("setFrontMatterDate", () => {
  it("updates an existing date and leaves the body untouched", () => {
    const source = "---\ntitle: Launch post\ndate: 2026-06-15\n---\nThe body stays.\n";
    const out = setFrontMatterDate(source, "2026-06-18");
    const { frontMatter, body } = splitFrontMatter(out);
    expect(parseFrontMatter(frontMatter)).toEqual({ title: "Launch post", date: "2026-06-18" });
    expect(body).toBe("The body stays.\n");
  });

  it("adds a date key when front matter exists without one", () => {
    const source = "---\ntitle: Draft\n---\nBody.\n";
    const out = setFrontMatterDate(source, "2026-06-20");
    expect(parseFrontMatter(splitFrontMatter(out).frontMatter)).toEqual({
      title: "Draft",
      date: "2026-06-20",
    });
  });

  it("creates a front-matter block when the file has none", () => {
    const source = "Just a body, no front matter.\n";
    const out = setFrontMatterDate(source, "2026-06-20");
    expect(out.startsWith("---\n")).toBe(true);
    const { frontMatter, body } = splitFrontMatter(out);
    expect(parseFrontMatter(frontMatter)).toEqual({ date: "2026-06-20" });
    expect(body).toBe("Just a body, no front matter.\n");
  });

  it("returns the source byte-for-byte when the date is unchanged", () => {
    const source = "---\ndate: 2026-06-15\n---\nBody.\n";
    expect(setFrontMatterDate(source, "2026-06-15")).toBe(source);
  });

  it("throws when an existing block is not a YAML mapping", () => {
    const source = "---\n- just\n- a list\n---\nBody.\n";
    expect(() => setFrontMatterDate(source, "2026-06-20")).toThrow();
  });
});
describe("setFrontMatterFields", () => {
  it("sets several keys at once and leaves the body untouched", () => {
    const source = "---\ntitle: Card\nstatus: doing\n---\nBody.\n";
    const out = setFrontMatterFields(source, { status: "done", order: 1.5 });
    const { frontMatter, body } = splitFrontMatter(out);
    expect(parseFrontMatter(frontMatter)).toEqual({ title: "Card", status: "done", order: 1.5 });
    expect(body).toBe("Body.\n");
  });

  it("removes a key when patched with undefined", () => {
    const source = "---\ntitle: Card\nstatus: doing\norder: 2\n---\nBody.\n";
    const out = setFrontMatterFields(source, { status: undefined, order: undefined });
    expect(parseFrontMatter(splitFrontMatter(out).frontMatter)).toEqual({ title: "Card" });
  });

  it("drops the block entirely when its last key is removed", () => {
    const source = "---\nstatus: doing\n---\nBody.\n";
    expect(setFrontMatterFields(source, { status: undefined })).toBe("Body.\n");
  });

  it("returns the source byte-for-byte when nothing changes", () => {
    const source = "---\nstatus: doing\ncolumns: [a, b]\n---\nBody.\n";
    expect(setFrontMatterFields(source, { status: "doing", columns: ["a", "b"] })).toBe(source);
    expect(setFrontMatterFields(source, { missing: undefined })).toBe(source);
  });

  it("never writes prototype-polluting keys", () => {
    const out = setFrontMatterFields("Body.\n", { __proto__: "x", status: "a" } as never);
    expect(parseFrontMatter(splitFrontMatter(out).frontMatter)).toEqual({ status: "a" });
  });
});