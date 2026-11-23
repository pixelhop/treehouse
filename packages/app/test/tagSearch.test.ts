import { describe, expect, it } from "vite-plus/test";
import { isTagQuery, tagSearch, tagSearchEmptyText } from "../app/utils/tagSearch";

const tags = [
  { tag: "launch/beta", paths: ["a.md"] },
  { tag: "Planning", paths: ["a.md", "notes/b.md"] },
  { tag: "planning/q4", paths: ["c.md"] },
  { tag: "product", paths: ["d.md"] },
];

describe("tagSearch", () => {
  it("only treats a query starting with # as a tag search", () => {
    expect(isTagQuery("  #plan")).toBe(true);
    expect(isTagQuery("plan #x")).toBe(false);
  });

  it("matches tags by prefix, case-insensitively, nested ones included", () => {
    const { tags: found, outcome } = tagSearch("#PLAN", tags);
    expect(found).toEqual([
      { tag: "Planning", count: 2 },
      { tag: "planning/q4", count: 1 },
    ]);
    expect(outcome.results.map((r) => r.path)).toEqual(["a.md", "c.md", "notes/b.md"]);
    expect(outcome.results[2]).toMatchObject({ name: "b.md", isDir: false });
  });

  it("narrows to a tag and what's nested under it once the query names it", () => {
    const list = [
      { tag: "plan", paths: ["a.md"] },
      { tag: "plan/q4", paths: ["b.md"] },
      { tag: "planning", paths: ["c.md"] },
    ];
    const { tags: chips, outcome } = tagSearch("#plan", list);
    expect(outcome.results.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    expect(chips.map((c) => c.tag)).toEqual(["plan", "plan/q4", "planning"]);
  });

  it("caps the rows it returns, but reports how many matched", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `n${i}.md`);
    const { outcome } = tagSearch("#", [{ tag: "big", paths }]);
    expect(outcome.results).toHaveLength(50);
    expect(outcome.totalMatches).toBe(300);
  });

  it("reaches every note under a big tag by adding part of its name", () => {
    const paths = Array.from({ length: 300 }, (_, i) => `n${i}.md`);
    const { outcome } = tagSearch("#big n299", [
      { tag: "big", paths },
      { tag: "other", paths: ["n299-elsewhere.md"] },
    ]);
    expect(outcome.results.map((r) => r.path)).toEqual(["n299.md"]);
  });

  it("treats a tag holding a space as one tag", () => {
    const list = [{ tag: "big project", paths: ["a.md"] }];
    expect(tagSearch("#big project", list).outcome.results.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("doesn't claim nothing is tagged while it can't know yet", () => {
    const state = { pending: false, indexing: false, anyTags: true };
    expect(tagSearchEmptyText("#x", state)).toBe("No notes tagged “#x”.");
    expect(tagSearchEmptyText("#x", { ...state, indexing: true })).toContain("Still indexing");
    expect(tagSearchEmptyText("#x", { ...state, pending: true })).toContain("Loading");
    expect(tagSearchEmptyText("#", { ...state, anyTags: false })).toContain("No tags yet");
  });

  it("lists every tag and tagged note for a bare #", () => {
    const { tags: found, outcome } = tagSearch("#", tags);
    expect(found).toHaveLength(4);
    expect(outcome.totalMatches).toBe(4);
  });
});