import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { appDir, logDir, logPath, sockPath } from "../src/paths";

function withPlatform(p: NodeJS.Platform, fn: () => void) {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  }
}

function clearEnv() {
  delete process.env.TREEHOUSE_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.APPDATA;
  delete process.env.LOCALAPPDATA;
}

describe("paths", () => {
  afterEach(clearEnv);

  it("honors the TREEHOUSE_HOME override", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-home-"));
    process.env.TREEHOUSE_HOME = dir;
    expect(appDir()).toBe(dir);
    expect(logDir()).toBe(join(dir, "logs"));
  });

  it("keeps every named log in the one log dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-home-"));
    process.env.TREEHOUSE_HOME = dir;
    expect(logPath("daemon")).toBe(join(dir, "logs", "daemon.log"));
    expect(logPath("app")).toBe(join(dir, "logs", "app.log"));
    expect(logPath("updater")).toBe(join(dir, "logs", "updater.log"));
  });

  it("resolves per-platform app + log dirs", () => {
    clearEnv();
    withPlatform("darwin", () => {
      expect(appDir()).toMatch(/Library\/Application Support\/Treehouse$/);
      expect(logDir()).toMatch(/Library\/Logs\/Treehouse$/);
    });
    withPlatform("linux", () => {
      process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
      process.env.XDG_STATE_HOME = "/tmp/xdg-state";
      expect(appDir()).toBe("/tmp/xdg-config/treehouse");
      expect(logDir()).toBe("/tmp/xdg-state/treehouse");
    });
    withPlatform("win32", () => {
      process.env.APPDATA = "C:/Users/x/AppData/Roaming";
      expect(appDir()).toContain("Treehouse");
    });
  });

  it("uses a named pipe on Windows, a socket otherwise", () => {
    clearEnv();
    withPlatform("win32", () => expect(sockPath()).toMatch(/^\\\\\.\\pipe\\/));
    withPlatform("darwin", () => expect(sockPath()).toMatch(/daemon\.sock$/));
  });
});