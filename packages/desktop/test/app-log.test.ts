import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { formatLine, rotateIfLarge } from "../src/app-log";

// The app log is the only record a packaged app keeps of its own failures, so the
// line shape (greppable next to daemon.log) and the size cap are what matter.
describe("formatLine", () => {
  it("timestamps and tags the level, formatting args like console does", () => {
    const at = new Date("2026-09-23T09:41:17.283Z");
    expect(formatLine("error", ["[tray] action failed:", "boom", 42], at)).toBe(
      "2026-09-23T09:41:17.283Z [error] [tray] action failed: boom 42\n",
    );
  });

  it("keeps an Error's message in the line", () => {
    expect(formatLine("error", [new Error("ENOSPC")])).toContain("ENOSPC");
  });
});

describe("rotateIfLarge", () => {
  it("moves an oversized log aside", () => {
    const file = join(mkdtempSync(join(tmpdir(), "th-log-")), "app.log");
    writeFileSync(file, "x".repeat(20));
    rotateIfLarge(file, 10);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(20);
  });

  it("leaves a small log alone", () => {
    const file = join(mkdtempSync(join(tmpdir(), "th-log-")), "app.log");
    writeFileSync(file, "small");
    rotateIfLarge(file, 10);
    expect(readFileSync(file, "utf8")).toBe("small");
  });

  it("tolerates a log that doesn't exist yet", () => {
    expect(() => rotateIfLarge(join(tmpdir(), "th-missing", "app.log"))).not.toThrow();
  });
});