import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { linksPath } from "../src/paths";
import {
  addLink,
  appOwnedLinks,
  isAppOwned,
  type Link,
  loadLinks,
  removeLink,
  saveLinks,
  setPaused,
  WorkspaceAlreadyLinkedError,
} from "../src/links-store";

function freshHome() {
  process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-links-"));
}

// Create a real folder with a `.treehouse/config.json` carrying `keyId` — the
// ownership anchor isAppOwned checks against a link's recorded key id.
function folderWithConfigKey(keyId: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "th-linkroot-"));
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(
    join(root, ".treehouse", "config.json"),
    JSON.stringify({ apiBase: "x", apiKey: "s", workspaceId: "w", keyId }),
  );
  return root;
}

describe("links-store", () => {
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  it("returns [] for a missing registry", () => {
    freshHome();
    expect(loadLinks()).toEqual([]);
  });

  it("adds, lists, updates, pauses, and removes links", () => {
    freshHome();
    addLink("/a", "ws1");
    addLink("/b", "ws2");
    expect(loadLinks().map((l) => l.root)).toEqual(["/a", "/b"]);

    // Re-adding the same root updates its workspace (idempotent on root).
    addLink("/a", "ws1b");
    expect(loadLinks().find((l) => l.root === "/a")?.workspaceId).toBe("ws1b");

    setPaused("/b", true);
    expect(loadLinks().find((l) => l.root === "/b")?.paused).toBe(true);

    expect(removeLink("/a")).toBe(true);
    expect(removeLink("/a")).toBe(false); // already gone
    expect(loadLinks().map((l) => l.root)).toEqual(["/b"]);
  });
});

describe("links-store attribution + ownership (U3)", () => {
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  it("records attribution when provided and stays idempotent on root (AE3)", () => {
    freshHome();
    addLink("/a", "ws1", { origin: "app", account: "user_1", keyId: "K1" });
    // Re-adding the same root WITH attribution replaces the entry, never duplicates.
    addLink("/a", "ws1", { origin: "app", account: "user_1", keyId: "K1" });
    const links = loadLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ origin: "app", account: "user_1", keyId: "K1" });
  });

  it("treats an app link as owned only while the folder's key id still matches", () => {
    freshHome();
    const root = folderWithConfigKey("K1");
    addLink(root, "ws1", { origin: "app", account: "u", keyId: "K1" });
    expect(isAppOwned(loadLinks()[0])).toBe(true);
    expect(appOwnedLinks().map((l) => l.root)).toEqual([root]);
  });

  it("does not own a CLI link or a legacy (attribution-absent) link", () => {
    freshHome();
    const cli = folderWithConfigKey("K9");
    addLink(cli, "ws1", { origin: "cli", keyId: "K9" });
    saveLinks([...loadLinks(), { root: "/legacy", workspaceId: "ws2" } as Link]);
    expect(appOwnedLinks()).toEqual([]);
  });

  it("transfers ownership when the folder is re-keyed away (config/key-ID mismatch)", () => {
    freshHome();
    // Link records K1, but the folder's config now points at K2 (a CLI re-link).
    const root = folderWithConfigKey("K2");
    addLink(root, "ws1", { origin: "app", account: "u", keyId: "K1" });
    expect(isAppOwned(loadLinks()[0])).toBe(false);
  });

  it("write-through: the shipped 2-arg addLink strips attribution → no longer app-owned", () => {
    freshHome();
    const root = folderWithConfigKey("K1");
    addLink(root, "ws1", { origin: "app", account: "u", keyId: "K1" });
    expect(isAppOwned(loadLinks()[0])).toBe(true);

    // Simulate an OLD CLI re-linking the same root: addLink(root, workspaceId)
    // rewrites the entry bare, stripping origin/account/keyId.
    addLink(root, "ws1");
    const rewritten = loadLinks()[0];
    expect(rewritten.origin).toBeUndefined();
    expect(rewritten.keyId).toBeUndefined();
    expect(isAppOwned(rewritten)).toBe(false); // ownership transferred
  });

  it("new-schema links.json parses under an old-schema reader, and vice versa", () => {
    freshHome();
    // New code writes attributed entries…
    addLink("/a", "ws1", { origin: "app", account: "u", keyId: "K1" });
    // …an old reader only knows root/workspaceId/paused — extra keys are ignored.
    const raw = JSON.parse(readFileSync(linksPath(), "utf8")) as {
      links: Array<{ root: string; workspaceId: string }>;
    };
    expect(raw.links[0].root).toBe("/a");
    expect(raw.links[0].workspaceId).toBe("ws1");

    // An old-schema file (no attribution) loads fine under the new reader.
    writeFileSync(linksPath(), JSON.stringify({ links: [{ root: "/b", workspaceId: "ws2" }] }));
    expect(loadLinks()).toEqual([{ root: "/b", workspaceId: "ws2" }]);
    expect(appOwnedLinks()).toEqual([]);
  });

  it("setPaused marks and clears a folder's paused flag", () => {
    freshHome();
    addLink("/a", "ws1", { origin: "app", keyId: "K1" });
    setPaused("/a", true);
    expect(loadLinks()[0].paused).toBe(true);
    setPaused("/a", false);
    expect(loadLinks()[0].paused).toBe(false);
  });
});
// ── One folder per workspace per Mac ────────────────────────────────────────
// Two local roots for one workspace means two engines syncing the same remote
// tree against each other, and the second folder gets a numeric suffix — the
// "Acme 2" the onboarding naming work exists to prevent.

describe("addLink — duplicate workspace", () => {
  // freshHome() is NOT optional: without it these write to the developer's real
  // ~/Library/Application Support/Treehouse/links.json and add phantom folders to
  // their actual sync registry.
  beforeEach(() => {
    freshHome();
  });

  it("refuses a second root for a workspace that already has one", () => {
    addLink("/tmp/a", "ws_1");
    expect(() => addLink("/tmp/b", "ws_1")).toThrow(WorkspaceAlreadyLinkedError);
    expect(loadLinks().map((l) => l.root)).toEqual(["/tmp/a"]);
  });

  it("names the existing folder so the caller can explain the refusal", () => {
    addLink("/tmp/a", "ws_1");
    try {
      addLink("/tmp/b", "ws_1");
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceAlreadyLinkedError);
      expect((e as WorkspaceAlreadyLinkedError).existingRoot).toBe("/tmp/a");
      expect((e as Error).message).toContain("/tmp/a");
    }
  });

  it("still allows re-linking the SAME root (a re-key, not a duplicate)", () => {
    addLink("/tmp/a", "ws_1", { origin: "cli" });
    expect(() => addLink("/tmp/a", "ws_1", { origin: "app", keyId: "K2" })).not.toThrow();
    expect(loadLinks()).toHaveLength(1);
    expect(loadLinks()[0]?.keyId).toBe("K2");
  });

  it("allows different workspaces in different folders — the normal case", () => {
    addLink("/tmp/a", "ws_1");
    addLink("/tmp/b", "ws_2");
    expect(loadLinks()).toHaveLength(2);
  });
});