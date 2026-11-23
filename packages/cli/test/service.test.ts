import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { stableDaemonPath } from "../src/paths";
import {
  convergeStableDaemon,
  daemonInvocation,
  launchdPlist,
  needsDaemonSpawn,
  parsePlistExec,
  systemdUnit,
  windowsTaskCommand,
  xdgDesktop,
} from "../src/service";

describe("service templates", () => {
  it("launchd plist: daemon program, RunAtLoad, crash-only KeepAlive, logs", () => {
    const p = launchdPlist("/usr/local/bin/treehouse", ["daemon"], "/tmp/th.log");
    expect(p).toContain("<string>io.treehouse.daemon</string>");
    expect(p).toContain("<string>/usr/local/bin/treehouse</string>");
    expect(p).toContain("<string>daemon</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>Crashed</key><true/>");
    expect(p).toContain("/tmp/th.log");
  });

  it("systemd --user unit: restarts on failure, enabled at default.target", () => {
    const u = systemdUnit("/usr/local/bin/treehouse", ["daemon"]);
    expect(u).toContain("ExecStart=/usr/local/bin/treehouse daemon");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
  });

  it("xdg autostart entry runs the daemon on login", () => {
    expect(xdgDesktop("/usr/local/bin/treehouse", ["daemon"])).toContain(
      "Exec=/usr/local/bin/treehouse daemon",
    );
  });

  it("windows logon task: ONLOGON, named Treehouse, quotes a spaced path", () => {
    const c = windowsTaskCommand("C:/Program Files/treehouse.exe", ["daemon"]);
    expect(c).toContain("/SC ONLOGON");
    expect(c).toContain("/TN Treehouse");
    expect(c).toContain('\\"C:/Program Files/treehouse.exe\\"');
  });

  it("daemonInvocation targets the daemon subcommand", () => {
    expect(daemonInvocation().args.at(-1)).toBe("daemon");
  });
});

describe("stable-path convergence (U10)", () => {
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  it("daemonInvocation prefers the stable shared binary when one is installed", () => {
    process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-svc-"));
    const stable = stableDaemonPath();
    mkdirSync(dirname(stable), { recursive: true });
    writeFileSync(stable, "#!/bin/sh\n"); // stand-in for the installed daemon

    const inv = daemonInvocation();
    // Both the CLI and the app now point launchd at the SAME executable — no fight.
    expect(inv.exec).toBe(stable);
    expect(inv.args).toEqual(["daemon"]);
  });

  it("falls back to this executable when no stable binary is installed", () => {
    process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-svc-"));
    const inv = daemonInvocation();
    expect(inv.exec).toBe(process.execPath);
    expect(inv.args.at(-1)).toBe("daemon");
  });
});

describe("plist exec parsing (U10 drift detection)", () => {
  it("extracts the ProgramArguments exec from a plist", () => {
    const xml = launchdPlist(
      "/Users/x/Library/Application Support/Treehouse/bin/treehouse-daemon",
      ["daemon"],
      "/tmp/th.log",
    );
    expect(parsePlistExec(xml)).toBe(
      "/Users/x/Library/Application Support/Treehouse/bin/treehouse-daemon",
    );
  });

  it("returns the drifted exec an old CLI's `start` bakes (process.execPath)", () => {
    const xml = launchdPlist("/usr/local/bin/treehouse", ["daemon"], "/tmp/th.log");
    expect(parsePlistExec(xml)).toBe("/usr/local/bin/treehouse");
  });

  it("returns null for a plist without ProgramArguments", () => {
    expect(parsePlistExec("<plist><dict></dict></plist>")).toBeNull();
  });
});

describe("convergeStableDaemon (U10 CLI newest-wins)", () => {
  it("is a no-op under the test runner and when no stable binary exists", () => {
    // VITEST-guarded: it must never copy a real binary during tests, and reports
    // "unavailable" rather than throwing, even with no stable daemon present.
    process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-conv-"));
    expect(convergeStableDaemon()).toBe("unavailable");
    delete process.env.TREEHOUSE_HOME;
  });
});
describe("needsDaemonSpawn", () => {
  // launchd (RunAtLoad) and systemd (`enable --now`) start the daemon as they
  // install it; spawning another would mean two supervisors for one daemon.
  it("leaves it to a service that started the daemon", () => {
    expect(needsDaemonSpawn({ installed: true, startedNow: true })).toBe(false);
  });

  // XDG autostart and the Windows logon task only run at the NEXT login.
  // Without a spawn here, `login` said "syncing now" over a folder that never
  // filled until the person logged out and back in.
  it("starts it now when the service only runs at the next login", () => {
    expect(needsDaemonSpawn({ installed: true, startedNow: false })).toBe(true);
  });

  it("starts it when there's no autostart service at all", () => {
    expect(needsDaemonSpawn({ installed: false })).toBe(true);
  });
});