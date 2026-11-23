import { describe, expect, it } from "vite-plus/test";
import { conflictedCopyBounds, conflictedCopyName, isConflictedCopy } from "../index";

const ISO = "2026-10-30T09:00:00.000Z";
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

describe("conflicted copy names", () => {
  const table: [string, string, string][] = [
    ["a.md", "a (", ").md"],
    ["notes/a.md", "notes/a (", ").md"],
    ["README", "README (", ")"],
    ["notes/README", "notes/README (", ")"],
    // A dot in a directory is not an extension.
    ["client.v1/README", "client.v1/README (", ")"],
    ["client.v1/a.md", "client.v1/a (", ").md"],
    // A leading dot is part of the name, in a folder as at the root.
    [".env", ".env (", ")"],
    ["app/.env", "app/.env (", ")"],
    // A trailing dot isn't an extension either.
    ["notes/a.", "notes/a. (", ")"],
  ];

  it.each(table)("%s", (path, head, tail) => {
    const name = conflictedCopyName(path, "human", ISO, 1);
    expect(name.startsWith(head)).toBe(true);
    expect(name.endsWith(tail)).toBe(true);
    expect(isConflictedCopy(name)).toBe(true);
  });

  it.each(table)("%s stays in its directory", (path) => {
    expect(dirOf(conflictedCopyName(path, "human", ISO, 1))).toBe(dirOf(path));
    expect(dirOf(conflictedCopyName(path, "human", ISO, 2))).toBe(dirOf(path));
  });

  it.each(table)("%s is found by its own bounds", (path) => {
    const { prefix, suffix } = conflictedCopyBounds(path);
    for (const counter of [1, 2]) {
      const name = conflictedCopyName(path, "agent", ISO, counter);
      expect(name.startsWith(prefix)).toBe(true);
      expect(name.endsWith(suffix)).toBe(true);
    }
  });
});