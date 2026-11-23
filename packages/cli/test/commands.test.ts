import { describe, expect, it } from "vite-plus/test";
import { lastLines, statusBadge } from "../src/commands";
import type { DirStatus } from "../src/daemon";

// `treehouse status` badge rendering (U2). Pure mapping, so it's exercised
// directly — the live states must each render, and an old state.json (which only
// ever carried syncing/error/paused) must not throw.
describe("statusBadge", () => {
  const badge = (state: string, degraded = false) =>
    statusBadge({ state, degraded } as unknown as DirStatus);

  it("renders each live state distinctly", () => {
    expect(badge("synced")).toContain("synced");
    expect(badge("transferring")).toContain("syncing");
    expect(badge("auth-lost")).toContain("sign in");
    expect(badge("paused")).toContain("paused");
    expect(badge("error")).toContain("error");
  });

  it("distinguishes a degraded (polling) syncing engine", () => {
    expect(badge("syncing", true)).toContain("polling");
    expect(badge("syncing", false)).not.toContain("polling");
  });

  it("tolerates an unknown/legacy state value without throwing", () => {
    // A future daemon (or a corrupt file) could carry a state this CLI predates.
    expect(() => badge("some-future-state")).not.toThrow();
    expect(badge("some-future-state")).toContain("error");
  });
});
// `treehouse logs -n <n>`: the tail slicing is pure, so it is checked directly.
describe("lastLines", () => {
  it("keeps the last n lines and drops the trailing newline", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
  });

  it("returns everything when the log is shorter than n", () => {
    expect(lastLines("a\nb\n", 100)).toBe("a\nb");
  });

  it("returns nothing for an empty log or a non-positive n", () => {
    expect(lastLines("", 10)).toBe("");
    expect(lastLines("\n\n", 10)).toBe("");
    expect(lastLines("a\nb\n", 0)).toBe("");
  });
});