import { describe, expect, it } from "vite-plus/test";
import {
  collectDatedChildren,
  type MarkdownCandidate,
  selectMarkdownCandidates,
} from "../app/utils/folderDates";
import type { TreeNode } from "../app/utils/treehouse";

const node = (name: string, path: string, isDir = false): TreeNode => ({
  name,
  path,
  isDir,
  conflicted: false,
  icon: null,
  order: null,
  private: false,
  explicitPrivate: false,
  size: null,
  createdAt: null,
  updatedAt: null,
  modifiedBy: null,
  unseen: false,
  children: [],
});

describe("selectMarkdownCandidates", () => {
  it("keeps markdown files with a known version and drops the rest", () => {
    const children = [
      node("a.md", "posts/a.md"),
      node("b.md", "posts/b.md"),
      node("cover.png", "posts/cover.png"),
      node("sub", "posts/sub", true),
      node("orphan.md", "posts/orphan.md"), // no version in the map
    ];
    const versions = new Map([
      ["posts/a.md", 3],
      ["posts/b.md", 1],
      ["posts/cover.png", 2],
    ]);
    const got = selectMarkdownCandidates(children, versions);
    expect(got).toEqual([
      { path: "posts/a.md", name: "a.md", version: 3 },
      { path: "posts/b.md", name: "b.md", version: 1 },
    ]);
  });
});

describe("collectDatedChildren", () => {
  const candidates: MarkdownCandidate[] = [
    { path: "posts/a.md", name: "a.md", version: 1 },
    { path: "posts/b.md", name: "b.md", version: 1 },
    { path: "posts/c.md", name: "c.md", version: 1 },
    { path: "posts/d.md", name: "d.md", version: 1 },
  ];

  it("includes only candidates with a valid front-matter date", () => {
    const got = collectDatedChildren(candidates, {
      "posts/a.md": { date: "2026-06-15" },
      "posts/b.md": { title: "no date" },
      "posts/c.md": { date: "not-a-date" },
      "posts/d.md": null, // unreadable / no front matter
    });
    expect(got).toEqual([
      { path: "posts/a.md", name: "a.md", date: "2026-06-15", title: undefined },
    ]);
  });

  it("treats a candidate with no entry in the map (not yet loaded) as undated", () => {
    const got = collectDatedChildren([candidates[0]!], {}); // key absent, not null
    expect(got).toEqual([]);
  });

  it("carries a string front-matter title and ignores non-string titles", () => {
    const got = collectDatedChildren([candidates[0]!, candidates[1]!], {
      "posts/a.md": { date: "2026-06-15", title: "Launch day" },
      "posts/b.md": { date: "2026-06-16", title: 42 },
    });
    expect(got[0]!.title).toBe("Launch day");
    expect(got[1]!.title).toBeUndefined();
  });

  it("normalizes a timestamped date to its day", () => {
    const got = collectDatedChildren([candidates[0]!], {
      "posts/a.md": { date: "2026-06-15T08:00:00Z" },
    });
    expect(got[0]!.date).toBe("2026-06-15");
  });
});