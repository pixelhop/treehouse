import { describe, expect, it } from "vite-plus/test";
import { dropModeAt, normalizeExpanded } from "../app/composables/useFileTreeUi";

// The sidebar's expanded-folder state changed shape from `{ [wsId]: string[] }`
// to `{ [wsId]: { [path]: true } }` so that expanding one folder invalidates only
// the rows that read that folder, rather than every row in the tree. Real
// browsers already hold the array shape, so the read path has to migrate it —
// silently losing someone's expansion state is a bad way to ship a perf fix.

describe("normalizeExpanded", () => {
  it("migrates the legacy array shape to a keyed record", () => {
    expect(normalizeExpanded({ ws1: ["a", "a/b"] })).toEqual({
      ws1: { a: true, "a/b": true },
    });
  });

  it("passes the current keyed shape through unchanged", () => {
    expect(normalizeExpanded({ ws1: { a: true } })).toEqual({ ws1: { a: true } });
  });

  it("migrates a mix of shapes across workspaces", () => {
    expect(normalizeExpanded({ ws1: ["a"], ws2: { b: true } })).toEqual({
      ws1: { a: true },
      ws2: { b: true },
    });
  });

  it("drops non-true values so a persisted false does not read as expanded", () => {
    // JSON.stringify of a record never writes `false` today, but a hand-edited or
    // older payload must not resurrect a collapsed folder as expanded.
    expect(normalizeExpanded({ ws1: { a: true, b: false } })).toEqual({ ws1: { a: true } });
  });

  it("drops non-string entries from a legacy array", () => {
    expect(normalizeExpanded({ ws1: ["a", 3, null, "b"] })).toEqual({
      ws1: { a: true, b: true },
    });
  });

  it("returns an empty store for empty, null, or non-object input", () => {
    expect(normalizeExpanded({})).toEqual({});
    expect(normalizeExpanded(null)).toEqual({});
    expect(normalizeExpanded(undefined)).toEqual({});
    expect(normalizeExpanded("nonsense")).toEqual({});
    expect(normalizeExpanded(42)).toEqual({});
  });

  it("ignores a top-level array (the shape was never that)", () => {
    expect(normalizeExpanded(["a", "b"])).toEqual({});
  });

  it("skips buckets that are neither array nor object", () => {
    expect(normalizeExpanded({ ws1: "nope", ws2: ["a"] })).toEqual({ ws2: { a: true } });
  });

  it("preserves an empty bucket rather than dropping the workspace", () => {
    // A workspace with everything collapsed is meaningful state, not absence.
    expect(normalizeExpanded({ ws1: [] })).toEqual({ ws1: {} });
  });
});
describe("dropModeAt", () => {
  it("splits a folder row into before / into / after, and a file row in two", () => {
    expect([0.1, 0.5, 0.9].map((y) => dropModeAt(true, y, true))).toEqual([
      "before",
      "into",
      "after",
    ]);
    expect([0.1, 0.9].map((y) => dropModeAt(false, y, true))).toEqual(["before", "after"]);
  });

  it("makes a whole folder row a destination while the tree is sorted", () => {
    expect([0.1, 0.5, 0.9].map((y) => dropModeAt(true, y, false))).toEqual([
      "into",
      "into",
      "into",
    ]);
  });
});