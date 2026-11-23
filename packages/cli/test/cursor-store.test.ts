import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadCursor, saveCursor } from "../src/cursor-store";

const tmp = () => mkdtempSync(join(tmpdir(), "th-cursor-"));
const writeRaw = (root: string, body: string) => {
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(join(root, ".treehouse", "cursor.json"), body);
};

describe("cursor-store", () => {
  it("round-trips a saved cursor (creating .treehouse)", () => {
    const root = tmp();
    saveCursor(root, 42);
    expect(loadCursor(root)).toBe(42);
  });

  it("returns undefined when absent — the bootstrap signal", () => {
    expect(loadCursor(tmp())).toBeUndefined();
  });

  it("returns undefined on corrupt JSON without throwing", () => {
    const root = tmp();
    writeRaw(root, "{ not json");
    expect(loadCursor(root)).toBeUndefined();
  });

  it("rejects a non-integer or negative seq", () => {
    const root = tmp();
    writeRaw(root, JSON.stringify({ seq: -1 }));
    expect(loadCursor(root)).toBeUndefined();
    writeRaw(root, JSON.stringify({ seq: 1.5 }));
    expect(loadCursor(root)).toBeUndefined();
    writeRaw(root, JSON.stringify({ seq: "5" }));
    expect(loadCursor(root)).toBeUndefined();
  });

  it("overwrites a previous cursor", () => {
    const root = tmp();
    saveCursor(root, 1);
    saveCursor(root, 7);
    expect(loadCursor(root)).toBe(7);
  });
});