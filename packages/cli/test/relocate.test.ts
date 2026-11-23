import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { addLink, loadLinks, relocateLink } from "../src/links-store";
import { planRelocation, type RelocationFacts, type RelocationPlan } from "../src/relocate";

// The relocation DECISION (pure). The fs/daemon glue that executes a plan is
// wired and covered by the packaged-app QA checklist, per
// docs/solutions/conventions/pure-wired-split-electron.md.

const FROM = "/Users/x/Treehouse/Acme";
const TO = "/Users/x/Work/Acme";

/** Default world: source is a live, unpaused link; destination doesn't exist. */
function facts(over: Partial<RelocationFacts> = {}): RelocationFacts {
  return {
    isLinked: true,
    paused: false,
    isAlive: () => true,
    exists: () => false,
    isEmpty: () => true,
    otherRoots: [],
    ...over,
  };
}

function refusal(plan: RelocationPlan): { reason: string; message: string } {
  if (plan.ok) throw new Error("expected a refusal, got a plan");
  return { reason: plan.reason, message: plan.message };
}

describe("planRelocation refusals", () => {
  it("refuses a destination nested inside the source (would recurse)", () => {
    expect(refusal(planRelocation(FROM, join(FROM, "moved"), facts())).reason).toBe(
      "destination-inside-source",
    );
    // Deeply nested, and nested with a trailing separator, are the same trap.
    expect(refusal(planRelocation(FROM, join(FROM, "a/b/c"), facts())).reason).toBe(
      "destination-inside-source",
    );
    expect(refusal(planRelocation(`${FROM}/`, `${FROM}/moved/`, facts())).reason).toBe(
      "destination-inside-source",
    );
  });

  it("refuses a case-variant nested destination (macOS is case-insensitive)", () => {
    expect(refusal(planRelocation(FROM, "/Users/x/treehouse/acme/inner", facts())).reason).toBe(
      "destination-inside-source",
    );
  });

  it("refuses an existing NON-EMPTY destination (never adopt someone else's files)", () => {
    const plan = planRelocation(FROM, TO, facts({ exists: () => true, isEmpty: () => false }));
    expect(refusal(plan).reason).toBe("destination-not-empty");
    expect(refusal(plan).message).toContain(TO);
  });

  it("refuses a source that is not alive, with a DISTINCT reason", () => {
    const plan = planRelocation(FROM, TO, facts({ isAlive: () => false }));
    expect(refusal(plan).reason).toBe("source-not-alive");
    // Distinct from the other refusals: the folder is gone, not the destination.
    expect(refusal(plan).reason).not.toBe("destination-not-empty");
    expect(refusal(plan).reason).not.toBe("destination-inside-source");
    expect(refusal(plan).message).toContain(FROM);
  });

  it("refuses a source that isn't a registered link (nothing to commit)", () => {
    expect(refusal(planRelocation(FROM, TO, facts({ isLinked: false }))).reason).toBe(
      "source-not-linked",
    );
  });

  it("refuses a move onto the same location and a relative path", () => {
    expect(refusal(planRelocation(FROM, FROM, facts())).reason).toBe("same-location");
    expect(refusal(planRelocation(FROM, `${FROM}/`, facts())).reason).toBe("same-location");
    expect(refusal(planRelocation(FROM, "Work/Acme", facts())).reason).toBe("not-absolute");
    expect(refusal(planRelocation("Treehouse/Acme", TO, facts())).reason).toBe("not-absolute");
  });

  it("explains every refusal in a sentence, not just a code", () => {
    const cases: RelocationPlan[] = [
      planRelocation(FROM, join(FROM, "x"), facts()),
      planRelocation(FROM, TO, facts({ exists: () => true, isEmpty: () => false })),
      planRelocation(FROM, TO, facts({ isAlive: () => false })),
      planRelocation(FROM, TO, facts({ isLinked: false })),
      planRelocation(FROM, FROM, facts()),
      planRelocation(FROM, "relative", facts()),
    ];
    for (const plan of cases) expect(refusal(plan).message.length).toBeGreaterThan(20);
  });
});

describe("planRelocation permitted moves", () => {
  it("allows a destination that exists and is EMPTY (a picker only returns real dirs)", () => {
    const plan = planRelocation(FROM, TO, facts({ exists: () => true, isEmpty: () => true }));
    expect(plan.ok).toBe(true);
  });

  it("allows a destination that doesn't exist yet", () => {
    expect(planRelocation(FROM, TO, facts()).ok).toBe(true);
  });

  it("pauses the OLD root before moving, and resumes the NEW root last", () => {
    const plan = planRelocation(FROM, TO, facts());
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.steps.map((s) => s.kind)).toEqual(["pause", "move", "commit", "resume"]);

    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds.indexOf("pause")).toBeLessThan(kinds.indexOf("move"));
    // links.json is the commit point: it is rewritten only after the bytes moved…
    expect(kinds.indexOf("move")).toBeLessThan(kinds.indexOf("commit"));
    // …and syncing resumes last, once the registry already points at the new root.
    expect(kinds.indexOf("resume")).toBe(kinds.length - 1);

    expect(plan.steps[0]).toEqual({ kind: "pause", root: FROM });
    expect(plan.steps[1]).toEqual({ kind: "move", from: FROM, to: TO });
    expect(plan.steps[2]).toEqual({ kind: "commit", from: FROM, to: TO });
    expect(plan.steps[3]).toEqual({ kind: "resume", root: TO, restorePaused: false });
  });

  it("keeps a deliberately-paused folder paused after the move", () => {
    const plan = planRelocation(FROM, TO, facts({ paused: true }));
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.steps.at(-1)).toEqual({ kind: "resume", root: TO, restorePaused: true });
  });
});

describe("relocateLink (the commit point)", () => {
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  function freshHome(): void {
    process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-relocate-"));
  }

  it("rewrites exactly one entry, keyed on the old root, leaving the others untouched", () => {
    freshHome();
    addLink("/a", "ws1", { origin: "app", account: "u", keyId: "K1" });
    addLink("/b", "ws2", { origin: "cli" });
    addLink("/c", "ws3");

    expect(relocateLink("/b", "/moved/b")).toBe(true);

    const links = loadLinks();
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.root)).toEqual(["/a", "/moved/b", "/c"]);
    expect(links.find((l) => l.root === "/a")).toEqual({
      root: "/a",
      workspaceId: "ws1",
      origin: "app",
      account: "u",
      keyId: "K1",
    });
    expect(links.find((l) => l.root === "/c")).toEqual({ root: "/c", workspaceId: "ws3" });
  });

  it("carries the workspace, pause flag and attribution across the move", () => {
    freshHome();
    addLink("/a", "ws1", { origin: "app", account: "u", keyId: "K1", appOrigin: "https://x.test" });
    const before = loadLinks()[0];

    expect(relocateLink("/a", "/moved/a")).toBe(true);

    expect(loadLinks()[0]).toEqual({ ...before, root: "/moved/a" });
  });

  it("changes nothing when the old root isn't registered", () => {
    freshHome();
    addLink("/a", "ws1");
    expect(relocateLink("/nope", "/moved")).toBe(false);
    expect(loadLinks().map((l) => l.root)).toEqual(["/a"]);
  });

  it("refuses to collide with an existing entry rather than merge two links", () => {
    freshHome();
    addLink("/a", "ws1");
    addLink("/b", "ws2");
    expect(relocateLink("/a", "/b")).toBe(false);
    expect(loadLinks().map((l) => l.root)).toEqual(["/a", "/b"]);
  });
});
// ── CLI parity ──────────────────────────────────────────────────────────────
// Relocation must be reachable from the terminal, not only the menubar. The
// repo's agent-native rule is that any action a user can take, an agent can take
// too — and relocation matters precisely because it keeps the key and the local
// index, so the unlink-and-relogin workaround pays the exact cost it avoids.

describe("CLI surface", () => {
  it("registers relocate as a known command with help text", async () => {
    const src = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("relocate:");
    expect(src).toContain("treehouse relocate <folder> <new-path>");
    // The allow-list is what makes it dispatchable rather than "Unknown command".
    expect(src).toMatch(/"resume",\s*"relocate"/);
  });

  it("routes the CLI through the same shared function the tray uses", async () => {
    const cmds = await readFile(new URL("../src/commands.ts", import.meta.url), "utf8");
    expect(cmds).toContain("export async function cmdRelocate");
    expect(cmds).toContain("relocateFolder");
  });
});

// ── Collisions with OTHER synced folders ────────────────────────────────────
// Both of these were reachable before: relocateLink refuses a destination that is
// already a registered root, but only at the commit step — after a same-volume
// renameSync has atomically destroyed the source, leaving nothing to roll back to.

describe("planRelocation — other links", () => {
  const OTHER = "/Users/x/Treehouse/Other";

  it("refuses a destination that is already another link's root", () => {
    const plan = planRelocation(FROM, OTHER, facts({ otherRoots: [OTHER] }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("destination-is-linked");
  });

  it("matches an existing root case-insensitively (macOS default FS)", () => {
    const plan = planRelocation(FROM, "/Users/x/treehouse/OTHER", facts({ otherRoots: [OTHER] }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("destination-is-linked");
  });

  it("refuses a destination INSIDE another synced folder", () => {
    // The outer workspace's recursive scan would otherwise upload this folder's
    // entire contents into it.
    const plan = planRelocation(FROM, `${OTHER}/nested`, facts({ otherRoots: [OTHER] }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("destination-nested-in-link");
  });

  it("allows a destination that merely shares a prefix with another root", () => {
    // "/Users/x/Treehouse/Other2" is NOT inside "/Users/x/Treehouse/Other".
    const plan = planRelocation(FROM, `${OTHER}2`, facts({ otherRoots: [OTHER] }));
    expect(plan.ok).toBe(true);
  });

  it("ignores the source's own entry when checking for clashes", () => {
    const plan = planRelocation(FROM, TO, facts({ otherRoots: [] }));
    expect(plan.ok).toBe(true);
  });
});