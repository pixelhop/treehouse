import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadIndex, saveIndex } from "../src/index-store";

const tmp = () => mkdtempSync(join(tmpdir(), "th-index-"));
const entry = (version: number) => ({ version, hash: `h${version}` });

describe("index store workspace binding", () => {
  it("round-trips entries when the workspace matches", () => {
    const root = tmp();
    saveIndex(root, { "a.md": entry(1) }, "ws-A");
    expect(loadIndex(root, "ws-A")).toEqual({ "a.md": entry(1) });
  });

  it("discards a baseline built against a different workspace", () => {
    const root = tmp();
    saveIndex(root, { "a.md": entry(1), "b.md": entry(2) }, "ws-A");
    // Re-pointed at another workspace: the old baseline must NOT be trusted, or
    // every local file would look remote-deleted and get wiped.
    expect(loadIndex(root, "ws-B")).toEqual({});
  });

  it("adopts a legacy flat-map baseline (no workspace stamp) as-is", () => {
    const root = tmp();
    mkdirSync(join(root, ".treehouse"), { recursive: true });
    writeFileSync(join(root, ".treehouse", "index.json"), JSON.stringify({ "a.md": entry(1) }));
    expect(loadIndex(root, "ws-A")).toEqual({ "a.md": entry(1) });
  });

  it("returns entries when no workspace is supplied to load", () => {
    const root = tmp();
    saveIndex(root, { "a.md": entry(1) }, "ws-A");
    expect(loadIndex(root)).toEqual({ "a.md": entry(1) });
  });

  it("returns {} for a missing baseline", () => {
    expect(loadIndex(tmp(), "ws-A")).toEqual({});
  });
});