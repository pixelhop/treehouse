import { describe, expect, it } from "vite-plus/test";
import { isKeepFile, isSafeRelPath } from "shared";
import { buildTree, findNode } from "../app/utils/treehouse";

describe("isSafeRelPath", () => {
  it("accepts ordinary relative paths", () => {
    expect(isSafeRelPath("notes.md")).toBe(true);
    expect(isSafeRelPath("reports/q3.md")).toBe(true);
    expect(isSafeRelPath(".keep")).toBe(true);
  });

  it("rejects traversal and dot segments", () => {
    expect(isSafeRelPath("..")).toBe(false);
    expect(isSafeRelPath(".")).toBe(false);
    expect(isSafeRelPath("../etc/passwd")).toBe(false);
    expect(isSafeRelPath("a/../b")).toBe(false);
    expect(isSafeRelPath("a/./b")).toBe(false);
  });

  it("rejects backslashes, null bytes, empty, and leading/trailing slashes", () => {
    expect(isSafeRelPath("a\\b")).toBe(false);
    expect(isSafeRelPath("a\0b")).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
    expect(isSafeRelPath("/abs")).toBe(false);
    expect(isSafeRelPath("trailing/")).toBe(false);
    expect(isSafeRelPath("a//b")).toBe(false);
  });
});

describe("isKeepFile", () => {
  it("matches a .keep at the root or in any folder", () => {
    expect(isKeepFile(".keep")).toBe(true);
    expect(isKeepFile("notes/.keep")).toBe(true);
    expect(isKeepFile("a/b/c/.keep")).toBe(true);
  });

  it("does not match regular files", () => {
    expect(isKeepFile("keep")).toBe(false);
    expect(isKeepFile("notes/keep.md")).toBe(false);
    expect(isKeepFile("notes/.keepsake")).toBe(false);
  });
});

describe("buildTree with .keep placeholders", () => {
  it("materializes the folder but hides the .keep child", () => {
    const tree = buildTree([{ path: "empty/.keep" }, { path: "docs/readme.md" }]);
    const empty = findNode(tree, "empty");
    expect(empty?.isDir).toBe(true);
    expect(empty?.children).toEqual([]); // folder renders, placeholder hidden
  });

  it("hides .keep alongside real files in the same folder", () => {
    const tree = buildTree([{ path: "docs/.keep" }, { path: "docs/readme.md" }]);
    const docs = findNode(tree, "docs");
    expect(docs?.children.map((c) => c.name)).toEqual(["readme.md"]);
  });

  it("drops a root-level .keep entirely", () => {
    const tree = buildTree([{ path: ".keep" }, { path: "top.md" }]);
    expect(tree.map((n) => n.name)).toEqual(["top.md"]);
  });
});