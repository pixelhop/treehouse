import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import {
  isAppMode,
  normalizeWorkspaceName,
  parseLinkedFromHash,
  SENTINEL_PATH,
  sentinelUrl,
  WORKSPACE_STEP_PATH,
} from "../app/utils/connect";

// This contract is mirrored in packages/desktop/src/contract.ts. If these paths
// change on one side only, the desktop workspace step waits until it times out —
// so the round-trip shape is pinned on both sides deliberately.

describe("sentinelUrl", () => {
  it("carries the workspace id on the sentinel path", () => {
    const url = new URL(sentinelUrl("https://treehouse.pixelhop.io", "ws_1"));
    expect(url.pathname).toBe(SENTINEL_PATH);
    expect(url.searchParams.get("workspace")).toBe("ws_1");
  });

  it("stays on the origin it was given (self-host safe)", () => {
    expect(
      sentinelUrl("https://selfhost.example.com", "ws_1").startsWith(
        "https://selfhost.example.com/connect/chosen",
      ),
    ).toBe(true);
  });

  it("escapes an id with URL-significant characters", () => {
    const url = new URL(sentinelUrl("https://x.example.com", "a&b=c"));
    expect(url.searchParams.get("workspace")).toBe("a&b=c");
  });

  // This is a real cross-package check, not a restatement of our own constant.
  // The two halves live in different runtimes and cannot import each other, so the
  // paths are duplicated by necessity — and drift is silent and expensive: the
  // desktop workspace step would wait on a sentinel the web never navigates to,
  // and hang until the five-minute timeout in windows.ts. Reading the desktop
  // source is the only way to assert the pair actually agrees.
  it("agrees with the desktop side's copy of the same paths", async () => {
    const desktopContract = await readFile(
      new URL("../../desktop/src/contract.ts", import.meta.url),
      "utf8",
    );
    expect(desktopContract).toContain(`const SENTINEL_PATH = "${SENTINEL_PATH}"`);
    expect(desktopContract).toContain(`const WORKSPACE_STEP_PATH = "${WORKSPACE_STEP_PATH}"`);
  });
});

describe("isAppMode", () => {
  it("recognises the shell's marker", () => {
    expect(isAppMode({ app: "1" })).toBe(true);
    expect(isAppMode({ app: "true" })).toBe(true);
  });

  it("treats a plain browser visit as not app mode", () => {
    expect(isAppMode({})).toBe(false);
    expect(isAppMode({ app: "0" })).toBe(false);
    expect(isAppMode({ app: ["1"] })).toBe(false);
  });
});

describe("normalizeWorkspaceName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeWorkspaceName("  Acme   Corp  ")).toBe("Acme Corp");
  });

  it("rejects a name that is only whitespace", () => {
    expect(normalizeWorkspaceName("   ")).toBeNull();
    expect(normalizeWorkspaceName("")).toBeNull();
  });

  it("caps at the server's own limit — not lower, or valid names get truncated", () => {
    expect(normalizeWorkspaceName("a".repeat(200))?.length).toBe(100);
    // A name the server would accept must survive untouched.
    expect(normalizeWorkspaceName("a".repeat(100))?.length).toBe(100);
  });

  it("keeps a name that is already fine untouched", () => {
    expect(normalizeWorkspaceName("Acme")).toBe("Acme");
  });
});
// The other half of the fragment contract in packages/desktop/src/contract.ts.
// A round-trip test lives on the desktop side for building; this covers reading,
// including the shapes a hand-typed fragment can produce.

describe("parseLinkedFromHash", () => {
  it("reads a single linked workspace", () => {
    expect(parseLinkedFromHash("#linked=ws_1:Acme")).toEqual([
      { workspaceId: "ws_1", folderName: "Acme" },
    ]);
  });

  it("reads several", () => {
    expect(parseLinkedFromHash("#linked=ws_1:Acme,ws_2:Home")).toHaveLength(2);
  });

  it("decodes ids and names containing the separators", () => {
    const [first] = parseLinkedFromHash(
      `#linked=${encodeURIComponent("a:b,c")}:${encodeURIComponent("My, Folder: 2")}`,
    );
    expect(first).toEqual({ workspaceId: "a:b,c", folderName: "My, Folder: 2" });
  });

  it("returns nothing for an absent or empty fragment", () => {
    expect(parseLinkedFromHash("")).toEqual([]);
    expect(parseLinkedFromHash("#")).toEqual([]);
    expect(parseLinkedFromHash("#other=1")).toEqual([]);
  });

  it("skips malformed entries but keeps the good ones", () => {
    // A forged fragment can only ever disable rows, so degrading is right —
    // throwing would break the step over something cosmetic.
    expect(parseLinkedFromHash("#linked=broken,ws_2:Home,:noid")).toEqual([
      { workspaceId: "ws_2", folderName: "Home" },
    ]);
  });

  it("survives bad percent-encoding without throwing", () => {
    expect(() => parseLinkedFromHash("#linked=%E0%A4%A:x")).not.toThrow();
  });
});