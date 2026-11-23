import { describe, expect, it } from "vite-plus/test";
import { parseDeleteResponse, parseWriteResponse, writeHeaders } from "../app/utils/fileWrites";

describe("writeHeaders", () => {
  it("sends If-Match for a compare-and-swap update", () => {
    const h = writeHeaders({ path: "notes.md", baseVersion: 4 });
    expect(h["if-match"]).toBe('"4"');
    expect(h["if-none-match"]).toBeUndefined();
    expect(h["content-type"]).toBe("text/markdown");
  });

  it("sends If-None-Match:* for a create-only write", () => {
    const h = writeHeaders({ path: "notes.md", create: true });
    expect(h["if-none-match"]).toBe("*");
    expect(h["if-match"]).toBeUndefined();
  });

  it("prefers create over baseVersion when both are given", () => {
    const h = writeHeaders({ path: "a.txt", create: true, baseVersion: 9 });
    expect(h["if-none-match"]).toBe("*");
    expect(h["if-match"]).toBeUndefined();
  });

  it("derives content-type from the extension and allows an override", () => {
    expect(writeHeaders({ path: "data.json", baseVersion: 1 })["content-type"]).toBe(
      "application/json",
    );
    expect(
      writeHeaders({ path: "x.bin", baseVersion: 1, contentType: "text/plain" })["content-type"],
    ).toBe("text/plain");
  });

  it("sends no conditional header when neither create nor baseVersion is set", () => {
    const h = writeHeaders({ path: "a.txt" });
    expect(h["if-match"]).toBeUndefined();
    expect(h["if-none-match"]).toBeUndefined();
  });
});

describe("parseWriteResponse", () => {
  it("maps 200 to an updated ok result", () => {
    expect(parseWriteResponse(200, { version: 5 })).toEqual({
      ok: true,
      version: 5,
      created: false,
    });
  });

  it("maps 201 to a created ok result", () => {
    expect(parseWriteResponse(201, { version: 1 })).toEqual({
      ok: true,
      version: 1,
      created: true,
    });
  });

  it("maps 412 to a conflict result carrying current version and copy path", () => {
    expect(
      parseWriteResponse(412, {
        current_version: 7,
        conflict_copy_path: "notes (conflicted copy — agent — 2026).md",
      }),
    ).toEqual({
      ok: false,
      conflict: true,
      currentVersion: 7,
      conflictCopyPath: "notes (conflicted copy — agent — 2026).md",
    });
  });

  it("throws on an unexpected status", () => {
    expect(() => parseWriteResponse(500, null)).toThrow();
  });
});

describe("parseDeleteResponse", () => {
  it("maps 204 to ok", () => {
    expect(parseDeleteResponse(204, null)).toEqual({ ok: true });
  });

  it("maps 412 to a conflict result with the current version", () => {
    expect(parseDeleteResponse(412, { current_version: 3 })).toEqual({
      ok: false,
      conflict: true,
      currentVersion: 3,
    });
  });

  it("maps 404 to not-found", () => {
    expect(parseDeleteResponse(404, null)).toEqual({ ok: false, notFound: true });
  });

  it("throws on an unexpected status", () => {
    expect(() => parseDeleteResponse(200, null)).toThrow();
  });
});