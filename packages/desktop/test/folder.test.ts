import { describe, expect, it } from "vite-plus/test";
import {
  checkOverride,
  filesOutsideBaseline,
  planFolder,
  sanitizeFolderName,
  summarizePaths,
} from "../src/onboarding/folder";

describe("sanitizeFolderName", () => {
  it("strips path separators", () => {
    expect(sanitizeFolderName("a/b\\c")).toBe("a b c");
  });

  it("strips filesystem-reserved and control characters", () => {
    expect(sanitizeFolderName('re<po>:"|?*')).toBe("re po");
  });

  it("removes leading dots (no hidden / traversal names)", () => {
    expect(sanitizeFolderName("...Secret")).toBe("Secret");
    expect(sanitizeFolderName("..")).toBe("Workspace");
  });

  it("trims trailing dots and spaces", () => {
    expect(sanitizeFolderName("Team.  ")).toBe("Team");
  });

  it("keeps unicode letters", () => {
    expect(sanitizeFolderName("Café 日本")).toBe("Café 日本");
  });

  it("falls back to Workspace when nothing usable remains", () => {
    expect(sanitizeFolderName("///")).toBe("Workspace");
    expect(sanitizeFolderName("   ")).toBe("Workspace");
  });

  it("caps the length", () => {
    expect(sanitizeFolderName("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("never ends in a dot or space, even when the length cap cuts there", () => {
    // The trailing-dot strip used to run BEFORE the cut, so a dot sitting at the
    // boundary survived and the result violated this function's own contract.
    expect(sanitizeFolderName(`${"a".repeat(63)}.tail`)).toBe("a".repeat(63));
    expect(sanitizeFolderName(`${"a".repeat(63)} tail`)).toBe("a".repeat(63));
  });

  it("truncates by code point so an emoji is never split into a lone surrogate half", () => {
    // "🌳" is two UTF-16 code units; a code-unit slice at the cap could keep half
    // of it and yield an unpaired surrogate in a real path segment.
    const name = "🌳".repeat(70);
    const out = sanitizeFolderName(name);
    expect(Array.from(out).length).toBe(64);
    expect(out).toBe("🌳".repeat(64));
    // No unpaired surrogate survived the cut.
    expect(/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  });
});

describe("planFolder", () => {
  it("uses ~/Treehouse/<name> by default", () => {
    const plan = planFolder("Design Team", { home: "/Users/me" });
    expect(plan.root).toBe("/Users/me/Treehouse/Design Team");
    expect(plan.name).toBe("Design Team");
    expect(plan.tccWarning).toBeUndefined();
  });

  it("sanitizes the workspace name into the path", () => {
    const plan = planFolder("a/b", { home: "/Users/me" });
    expect(plan.root).toBe("/Users/me/Treehouse/a b");
  });

  it("appends a numeric suffix on collision", () => {
    const taken = new Set(["/Users/me/Treehouse/Team", "/Users/me/Treehouse/Team 2"]);
    const plan = planFolder("Team", { home: "/Users/me", exists: (p) => taken.has(p) });
    expect(plan.root).toBe("/Users/me/Treehouse/Team 3");
    expect(plan.name).toBe("Team 3");
  });

  it("warns on a TCC-protected override", () => {
    const plan = planFolder("Team", { home: "/Users/me", override: "/Users/me/Documents/Team" });
    expect(plan.root).toBe("/Users/me/Documents/Team");
    expect(plan.tccWarning).toMatch(/protected/i);
  });

  it("does not warn for a non-protected override", () => {
    const plan = planFolder("Team", { home: "/Users/me", override: "/Users/me/Code/Team" });
    expect(plan.tccWarning).toBeUndefined();
  });

  // Stop syncing leaves the folder (and its files) on disk by design. Coming back
  // to the same workspace used to step around it to "Team 2", leaving two folders
  // — and the one the user knew about was the dead one.
  it("picks a workspace's own earlier folder back up instead of suffixing past it", () => {
    const taken = new Set(["/Users/me/Treehouse/Team"]);
    const plan = planFolder("Team", {
      home: "/Users/me",
      exists: (p) => taken.has(p),
      isReclaimable: (p) => p === "/Users/me/Treehouse/Team",
    });
    expect(plan.root).toBe("/Users/me/Treehouse/Team");
    expect(plan.reclaim).toBe(true);
  });

  it("still suffixes past a same-named folder that belongs to something else", () => {
    const taken = new Set(["/Users/me/Treehouse/Team", "/Users/me/Treehouse/Team 2"]);
    const plan = planFolder("Team", {
      home: "/Users/me",
      exists: (p) => taken.has(p),
      isReclaimable: (p) => p === "/Users/me/Treehouse/Team 2",
    });
    // "Team" is someone else's; "Team 2" is ours from before.
    expect(plan.root).toBe("/Users/me/Treehouse/Team 2");
    expect(plan.reclaim).toBe(true);
  });

  it("reuses an empty, unlinked folder (an abandoned setup's) instead of suffixing", () => {
    const taken = new Set(["/Users/me/Treehouse/Team"]);
    const plan = planFolder("Team", {
      home: "/Users/me",
      exists: (p) => taken.has(p),
      isUnusedEmpty: (p) => p === "/Users/me/Treehouse/Team",
    });
    expect(plan.root).toBe("/Users/me/Treehouse/Team");
    expect(plan.reclaim).toBeUndefined(); // nothing to reclaim — it's just empty
  });

  it("marks a chosen override as a reclaim only when it holds this workspace", () => {
    const own = planFolder("Team", {
      home: "/Users/me",
      override: "/Users/me/Code/Team",
      exists: () => true,
      isReclaimable: () => true,
    });
    expect(own.reclaim).toBe(true);
    const other = planFolder("Team", {
      home: "/Users/me",
      override: "/Users/me/Code/Team",
      exists: () => true,
      isReclaimable: () => false,
    });
    expect(other.reclaim).toBeUndefined();
  });
});
// ── Override acceptance (the picker's guard) ────────────────────────────────
// The picker can only ever hand back a directory that EXISTS, so "reject anything
// that exists" would reject every possible answer. The real rule is emptiness:
// bootstrap sync pushes everything local, so a populated folder would leak the
// user's unrelated documents into a shared workspace.

describe("checkOverride", () => {
  const empty = { isEmpty: () => true };
  const populated = { isEmpty: () => false };

  it("accepts an existing EMPTY directory", () => {
    expect(checkOverride("/Users/me/Projects/Acme", empty)).toBeNull();
  });

  it("refuses a directory that already has files in it", () => {
    expect(checkOverride("/Users/me/Documents", populated)).toBe("not-empty");
  });

  it("accepts a populated folder that holds this workspace's own earlier files", () => {
    expect(
      checkOverride("/Users/me/Treehouse/Acme", {
        isEmpty: () => false,
        isReclaimable: () => true,
      }),
    ).toBeNull();
  });

  it("refuses a relative path", () => {
    expect(checkOverride("Projects/Acme", empty)).toBe("not-absolute");
  });

  it("reports WHY it refused, so the UI can explain rather than just decline", () => {
    // The distinction matters: "not-empty" is the user's to fix by picking
    // elsewhere; "not-absolute" would be our bug.
    expect(checkOverride("/x", populated)).toBe("not-empty");
    expect(checkOverride("x", populated)).toBe("not-absolute");
  });
});
// ── Reclaim consent ─────────────────────────────────────────────────────────
// A folder picked back up may hold files added after syncing stopped. Those are
// not the workspace's — they need the user's say-so before anything uploads them.

describe("filesOutsideBaseline", () => {
  it("lists only files the sync baseline doesn't know", () => {
    expect(
      filesOutsideBaseline(
        ["README.md", "tax-return.pdf", "notes/a.md"],
        ["README.md", "notes/a.md"],
      ),
    ).toEqual(["tax-return.pdf"]);
  });

  it("treats every file as unknown when there is no baseline", () => {
    expect(filesOutsideBaseline(["b.md", "a.md"], [])).toEqual(["a.md", "b.md"]);
  });

  it("is empty when the folder holds only the workspace's own files", () => {
    expect(filesOutsideBaseline(["README.md"], ["README.md", "gone.md"])).toEqual([]);
  });
});

describe("summarizePaths", () => {
  it("shows the first few and counts the rest", () => {
    expect(summarizePaths(["a", "b", "c"], 2)).toBe("• a\n• b\n…and 1 more");
    expect(summarizePaths(["a"], 2)).toBe("• a");
  });
});