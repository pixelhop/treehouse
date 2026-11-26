import { describe, expect, it } from "vite-plus/test";
import { runtimeHealthLine, STALL_MS } from "../server/utils/runtime-health";

const quiet = {
  maxDelayMs: 12.4,
  p99DelayMs: 3.2,
  heapUsedMb: 210.4,
  heapLimitMb: 1000.2,
  rssMb: 380.7,
  uptimeHours: 21.34,
};

describe("runtimeHealthLine", () => {
  it("says nothing in a quiet minute between baselines", () => {
    expect(runtimeHealthLine(quiet, 7, 15)).toBeNull();
  });

  it("logs a baseline every Nth minute", () => {
    expect(runtimeHealthLine(quiet, 15, 15)).toEqual({
      level: "log",
      line: "[runtime] event loop max 12 ms (p99 3 ms) in the last minute; heap 210 of 1000 MB, rss 381 MB, up 21.3 h",
    });
  });

  it("warns about a stall in the minute it happens, baseline or not", () => {
    const out = runtimeHealthLine({ ...quiet, maxDelayMs: 1234.6 }, 7, 15);
    expect(out?.level).toBe("warn");
    expect(out?.line).toContain("event loop blocked for up to 1235 ms");
    expect(runtimeHealthLine({ ...quiet, maxDelayMs: STALL_MS }, 7, 15)?.level).toBe("warn");
  });
});