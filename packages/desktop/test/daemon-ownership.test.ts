import { stableDaemonPath } from "cli/src/paths";
import { describe, expect, it } from "vite-plus/test";
import {
  acceptsDaemonSignature,
  type DaemonOps,
  decideDaemonManagement,
  parseTeamId,
  reconcileDaemon,
  startDaemonOwnershipMonitor,
} from "../src/daemon";

// U10: shared-binary ownership. The pure decision + team-id parse are unit-tested
// directly; the OS-touching orchestration (reconcileDaemon) is driven with fakes so
// no real launchd/codesign is invoked — the repo's VITEST-guard pattern.

const STABLE = "/Users/x/Library/Application Support/Treehouse/bin/treehouse-daemon";

const baseState = {
  shippedVersion: "1.2.0" as string | null,
  installedVersion: "1.2.0" as string | null,
  runningProtocol: 1 as number | null,
  knownProtocol: 1,
  plistExec: STABLE as string | null,
  stablePath: STABLE,
};

describe("decideDaemonManagement (pure ownership rule)", () => {
  it("fresh install: nothing installed, no plist → install binary, write plist, restart", () => {
    const d = decideDaemonManagement({
      ...baseState,
      installedVersion: null,
      runningProtocol: null,
      plistExec: null,
    });
    expect(d).toMatchObject({ installBinary: true, repairPlist: true, restart: true });
  });

  it("newest-wins: shipped newer than installed → upgrade the shared binary", () => {
    const d = decideDaemonManagement({ ...baseState, shippedVersion: "1.3.0" });
    expect(d.installBinary).toBe(true);
    expect(d.restart).toBe(true);
    expect(d.reason).toMatch(/1\.2\.0 → 1\.3\.0/);
  });

  it("never downgrades: installed newer than shipped → no swap", () => {
    const d = decideDaemonManagement({ ...baseState, shippedVersion: "1.1.0" });
    expect(d.installBinary).toBe(false);
  });

  it("same version, plist correct → nothing to do", () => {
    const d = decideDaemonManagement(baseState);
    expect(d).toMatchObject({ installBinary: false, repairPlist: false, restart: false });
  });

  it("plist drift (old CLI rewrote it to its execPath) → repair + restart, no swap", () => {
    const d = decideDaemonManagement({ ...baseState, plistExec: "/usr/local/bin/treehouse" });
    expect(d).toMatchObject({ installBinary: false, repairPlist: true, restart: true });
    expect(d.reason).toMatch(/drift/i);
  });

  // The dead-daemon hole: a failed `launchctl bootstrap` leaves the service booted
  // out with nothing running. Everything else looks converged (binary current,
  // plist correct), so without an explicit liveness clause the reconcile concludes
  // "healthy" every 5 minutes forever while nothing syncs. KeepAlive can't recover
  // it either — the SIGTERM path exits 0.
  it("service installed but no daemon running → restart it", () => {
    const d = decideDaemonManagement({ ...baseState, runningProtocol: null });
    expect(d).toMatchObject({ installBinary: false, repairPlist: false, restart: true });
    expect(d.reason).toMatch(/no daemon is running/i);
  });

  it("no service installed and nothing running → plist repair covers it, not a bare restart", () => {
    const d = decideDaemonManagement({ ...baseState, runningProtocol: null, plistExec: null });
    expect(d).toMatchObject({ repairPlist: true, restart: true });
    expect(d.reason).toMatch(/drift|installing/i);
  });

  it("a newer daemon that is DOWN is still left alone (protocol guard wins)", () => {
    // The protocol guard short-circuits before the liveness check, so a client
    // that cannot speak to the daemon never restarts one it doesn't understand.
    const d = decideDaemonManagement({ ...baseState, runningProtocol: 2, knownProtocol: 1 });
    expect(d.restart).toBe(false);
  });

  it("refuses to manage a daemon speaking a newer protocol than we know", () => {
    const d = decideDaemonManagement({
      ...baseState,
      runningProtocol: 2,
      knownProtocol: 1,
      shippedVersion: "9.9.9",
      plistExec: "/somewhere/else",
    });
    // Even with a newer shipped binary and drift, we leave a newer daemon alone.
    expect(d).toMatchObject({ installBinary: false, repairPlist: false, restart: false });
    expect(d.reason).toMatch(/newer than this client knows/i);
  });
});

describe("parseTeamId", () => {
  it("extracts a Team ID from codesign output", () => {
    expect(parseTeamId("Authority=Developer ID Application\nTeamIdentifier=ABCDE12345\n")).toBe(
      "ABCDE12345",
    );
  });
  it("returns null when the signature has no team (adhoc)", () => {
    expect(parseTeamId("TeamIdentifier=not set\n")).toBeNull();
    expect(parseTeamId("Identifier=io.treehouse\n")).toBeNull();
  });
});

// ─── reconcileDaemon orchestration, driven with fakes ───

function fakeOps(over: Partial<DaemonOps> & { calls?: string[] } = {}): DaemonOps & {
  calls: string[];
} {
  const calls = over.calls ?? [];
  return {
    calls,
    shippedDaemonPath: () => "/App/Contents/Resources/daemon",
    stablePath: () => STABLE,
    readBinaryVersion: (p) => (p === STABLE ? "1.2.0" : "1.3.0"),
    readRunningProtocol: async () => 1,
    readPlistExec: () => STABLE,
    verifySignature: () => true,
    installBinaryAtStablePath: () => calls.push("swap"),
    assertService: () => calls.push("restart"),
    log: () => {},
    ...over,
  };
}

describe("reconcileDaemon (orchestration with fakes)", () => {
  it("fresh install swaps the binary and asserts the service", async () => {
    const ops = fakeOps({
      readBinaryVersion: (p) => (p === STABLE ? null : "1.3.0"),
      readRunningProtocol: async () => null,
      readPlistExec: () => null,
    });
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(d.installBinary).toBe(true);
    expect(ops.calls).toEqual(["swap", "restart"]);
  });

  it("app update with an older shared binary → upgrade + restart", async () => {
    const ops = fakeOps(); // installed 1.2.0, shipped 1.3.0
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(d.installBinary).toBe(true);
    expect(ops.calls).toEqual(["swap", "restart"]);
  });

  it("BAD/foreign signature → refuse the swap, keep the running daemon (no restart)", async () => {
    const ops = fakeOps({ verifySignature: () => false });
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(d.installBinary).toBe(false);
    expect(d.restart).toBe(false);
    expect(ops.calls).toEqual([]); // never swapped, never restarted
    expect(d.reason).toMatch(/signature verification failed/i);
  });

  it("plist drift with matching versions → repair only, no swap", async () => {
    const ops = fakeOps({
      readBinaryVersion: () => "1.2.0", // shipped == installed
      readPlistExec: () => "/usr/local/bin/treehouse",
    });
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(d.installBinary).toBe(false);
    expect(ops.calls).toEqual(["restart"]); // re-assert plist, no binary swap
  });

  it("newer running daemon → leave it entirely alone", async () => {
    const ops = fakeOps({ readRunningProtocol: async () => 99 });
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(ops.calls).toEqual([]);
    expect(d.restart).toBe(false);
  });

  it("dev/unpackaged (no shipped daemon) → no swap; plist still reconciled if drifted", async () => {
    const ops = fakeOps({
      shippedDaemonPath: () => null,
      readBinaryVersion: (p) => (p === STABLE ? "1.2.0" : null),
      readPlistExec: () => "/usr/local/bin/treehouse",
    });
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(d.installBinary).toBe(false);
    expect(ops.calls).toEqual(["restart"]);
  });

  it("a throwing OS op is contained: logged, no rejection, no-op decision returned", async () => {
    const logs: string[] = [];
    const ops = fakeOps({
      installBinaryAtStablePath: () => {
        throw new Error("ENOSPC");
      },
      log: (m) => logs.push(m),
    });
    // Must resolve (not reject) with a no-op decision so the fire-and-forget monitor
    // never produces a recurring unhandled rejection.
    const d = await reconcileDaemon("ABCDE12345", ops);
    expect(d).toMatchObject({ installBinary: false, restart: false });
    expect(logs.some((m) => /reconcile failed/i.test(m))).toBe(true);
  });

  it("the monitor's tick swallows a rejecting reconcile (no unhandled rejection)", async () => {
    const logs: string[] = [];
    const ops = fakeOps({
      readRunningProtocol: async () => {
        throw new Error("ipc boom");
      },
      log: (m) => logs.push(m),
    });
    // reconcileDaemon awaits readRunningProtocol OUTSIDE its try/catch, so this
    // rejects — the monitor's .catch must absorb it.
    const stop = startDaemonOwnershipMonitor(60_000, "ABCDE12345", ops);
    await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(logs.some((m) => /tick failed/i.test(m))).toBe(true);
  });
});

describe("stable path placement (U10 trash-the-app safety)", () => {
  it("lives under the per-user app dir, not inside a .app bundle", () => {
    process.env.TREEHOUSE_HOME = "/Users/x/Library/Application Support/Treehouse";
    const p = stableDaemonPath();
    delete process.env.TREEHOUSE_HOME;
    expect(p).toContain("/Treehouse/bin/treehouse-daemon");
    expect(p).not.toMatch(/\.app\//); // trashing Treehouse.app can't remove it
  });
});
// ── Ad-hoc escape hatch (alpha, unsigned builds) ────────────────────────────
// Unsigned builds can't pass the Team-ID gate (an ad-hoc signature carries no
// TeamIdentifier), so the shell refused to install its OWN bundled daemon and
// onboarding dead-ended permanently. ALLOW_ADHOC_DAEMON opens that path — but only
// for a build with no Team ID baked. These pin the boundary, because the danger is
// the flag silently weakening a signed release.
describe("acceptsDaemonSignature", () => {
  const TEAM = "ABCDE12345";

  it("accepts a correctly-signed daemon on a signed build", () => {
    expect(
      acceptsDaemonSignature({
        codesignValid: true,
        teamId: TEAM,
        expectedTeamId: TEAM,
        teamIdConfigured: true,
        allowAdhoc: false,
      }),
    ).toBe(true);
  });

  it("rejects a daemon signed by a DIFFERENT team on a signed build", () => {
    expect(
      acceptsDaemonSignature({
        codesignValid: true,
        teamId: "OTHER99999",
        expectedTeamId: TEAM,
        teamIdConfigured: true,
        allowAdhoc: false,
      }),
    ).toBe(false);
  });

  // The security property that matters: the flag must not weaken a signed release.
  it("IGNORES allowAdhoc once a real Team ID is baked", () => {
    expect(
      acceptsDaemonSignature({
        codesignValid: true,
        teamId: null, // ad-hoc daemon
        expectedTeamId: TEAM,
        teamIdConfigured: true,
        allowAdhoc: true, // must not rescue it
      }),
    ).toBe(false);
  });

  it("still fails closed on an unsigned build when the flag is off", () => {
    expect(
      acceptsDaemonSignature({
        codesignValid: true,
        teamId: null,
        expectedTeamId: "UNSET_TEAM_ID",
        teamIdConfigured: false,
        allowAdhoc: false,
      }),
    ).toBe(false);
  });

  it("accepts an ad-hoc daemon on an unsigned build when the flag is on", () => {
    expect(
      acceptsDaemonSignature({
        codesignValid: true,
        teamId: null,
        expectedTeamId: "UNSET_TEAM_ID",
        teamIdConfigured: false,
        allowAdhoc: true,
      }),
    ).toBe(true);
  });

  // A broken signature means a tampered or corrupt binary — never install it.
  it("rejects an INVALID signature even with the flag on", () => {
    expect(
      acceptsDaemonSignature({
        codesignValid: false,
        teamId: null,
        expectedTeamId: "UNSET_TEAM_ID",
        teamIdConfigured: false,
        allowAdhoc: true,
      }),
    ).toBe(false);
  });
});