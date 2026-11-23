import { describe, expect, it } from "vite-plus/test";
import { detectServerChange, type FileChangeEvent } from "../app/utils/changeFeed";

function ev(p: Partial<FileChangeEvent>): FileChangeEvent {
  return { path: "a.md", op: "write", version: 1, ...p };
}

describe("detectServerChange", () => {
  it("flags a write to the open path with a higher version", () => {
    expect(detectServerChange([ev({ path: "a.md", version: 3 })], "a.md", 2)).toBe(true);
  });

  it("ignores our own echoed save (version equals loaded)", () => {
    expect(detectServerChange([ev({ path: "a.md", version: 2 })], "a.md", 2)).toBe(false);
  });

  it("ignores changes to other paths", () => {
    expect(detectServerChange([ev({ path: "b.md", version: 9 })], "a.md", 1)).toBe(false);
  });

  it("flags a delete of the open path regardless of version", () => {
    expect(detectServerChange([ev({ path: "a.md", op: "delete", version: null })], "a.md", 5)).toBe(
      true,
    );
  });

  it("ignores a comment or a visibility change on the open path", () => {
    expect(detectServerChange([ev({ op: "comment_created", version: 2 })], "a.md", 2)).toBe(false);
    expect(detectServerChange([ev({ op: "access_granted", version: null })], "a.md", 2)).toBe(
      false,
    );
  });

  it("returns false for an empty batch", () => {
    expect(detectServerChange([], "a.md", 1)).toBe(false);
  });
});