import { describe, expect, it } from "vite-plus/test";
import {
  readyStateAction,
  type UpdateState,
  updateMenuEnabled,
  updateMenuLabel,
} from "../src/updater";

// The menubar item is the app's only self-update affordance and its only progress
// indicator, so what it SAYS is the feature. These cover the label mapping and the
// re-entrancy rule; the Electron wiring around them is the U12 checklist's job.

describe("updateMenuLabel", () => {
  it("offers a check when idle", () => {
    expect(updateMenuLabel({ kind: "idle" }, "0.1.3")).toBe("Check for Updates…");
  });

  // The whole point: "Check for Updates…" alone cannot distinguish a working
  // updater from a dead one. Naming the running version is what makes a
  // successful check legible without opening a log.
  it("names the current version when up to date", () => {
    expect(updateMenuLabel({ kind: "up-to-date" }, "0.1.3")).toBe("Up to date (0.1.3)");
  });

  it("shows download progress", () => {
    const state: UpdateState = { kind: "downloading", version: "0.1.4", percent: 42 };
    expect(updateMenuLabel(state, "0.1.3")).toBe("Downloading update… 42%");
  });

  it("names the target version when an update is ready", () => {
    expect(updateMenuLabel({ kind: "ready", version: "0.1.4" }, "0.1.3")).toBe(
      "Restart to update to 0.1.4",
    );
  });

  // A failed check must not be silent, and must stay actionable — a disabled
  // "failed" item would strand the user with no way to retry.
  it("reports a failure and invites a retry", () => {
    const label = updateMenuLabel({ kind: "error", message: "ENOTFOUND" }, "0.1.3");
    expect(label).toMatch(/failed/i);
    expect(label).toMatch(/retry/i);
  });
});

describe("readyStateAction", () => {
  const ready: UpdateState = { kind: "ready", version: "0.1.4" };

  // The regression this exists for: the ready-state branch used to run for the
  // 6h background tick too, and re-opening clears promptRestart's per-version
  // memory — so declining "Later" bought six hours of peace, then the same
  // dialog came back, forever.
  it("does NOT re-open a declined prompt on a background tick", () => {
    expect(readyStateAction(ready, false)).toBe("do-nothing");
  });

  it("re-opens the prompt on an explicit menubar click", () => {
    expect(readyStateAction(ready, true)).toBe("reopen-prompt");
  });

  // A background tick must not fall through to a fresh check either: the feed
  // still advertises the same version, so it would re-download an update that
  // is already sitting on disk.
  it("never falls through to a re-check while an update is ready", () => {
    expect(readyStateAction(ready, false)).not.toBe("check");
  });

  it("checks normally in every other state, click or tick", () => {
    for (const state of [
      { kind: "idle" },
      { kind: "up-to-date" },
      { kind: "error", message: "boom" },
    ] satisfies UpdateState[]) {
      expect(readyStateAction(state, true)).toBe("check");
      expect(readyStateAction(state, false)).toBe("check");
    }
  });
});

describe("updateMenuEnabled", () => {
  it("blocks clicks while work is already in flight", () => {
    expect(updateMenuEnabled({ kind: "checking" })).toBe(false);
    expect(updateMenuEnabled({ kind: "downloading", version: "0.1.4", percent: 5 })).toBe(false);
  });

  it("stays clickable in every settled state", () => {
    expect(updateMenuEnabled({ kind: "idle" })).toBe(true);
    expect(updateMenuEnabled({ kind: "up-to-date" })).toBe(true);
    // Clickable BECAUSE it is ready: the click is how the restart gets applied
    // after a deferred prompt, which is the only path that ever installs it.
    expect(updateMenuEnabled({ kind: "ready", version: "0.1.4" })).toBe(true);
    expect(updateMenuEnabled({ kind: "error", message: "boom" })).toBe(true);
  });
});