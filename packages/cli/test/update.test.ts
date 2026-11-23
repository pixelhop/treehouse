import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { currentTarget, isNewer, readLatestSeen, writeLatestSeen } from "../src/update";

describe("isNewer", () => {
  it("compares semver release versions", () => {
    expect(isNewer("0.1.3", "0.1.2")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });

  it("ignores prerelease suffixes", () => {
    expect(isNewer("0.1.3-rc.1", "0.1.2")).toBe(true);
    expect(isNewer("0.1.2-rc.1", "0.1.2")).toBe(false);
  });

  it("never updates a dev build, or on an empty latest", () => {
    expect(isNewer("9.9.9", "dev")).toBe(false);
    expect(isNewer("", "0.1.2")).toBe(false);
  });
});

describe("currentTarget", () => {
  it("matches the published asset key format", () => {
    expect(currentTarget()).toBe(`${process.platform}-${process.arch}`);
    expect(currentTarget()).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
  });
});

describe("update state", () => {
  beforeEach(() => {
    process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-upd-"));
  });
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  it("round-trips the latest-seen version", () => {
    expect(readLatestSeen()).toBeUndefined();
    writeLatestSeen("0.1.5");
    expect(readLatestSeen()).toBe("0.1.5");
  });
});