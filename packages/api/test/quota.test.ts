import { afterEach, describe, expect, it } from "vite-plus/test";
import { quotaForWorkspace, quotaStatus } from "../server/utils/quota";

afterEach(() => {
  delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
});

describe("quotaForWorkspace", () => {
  it("is unlimited (null) when the env var is unset", () => {
    delete process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
    expect(quotaForWorkspace("ws_1")).toBeNull();
  });

  it("is unlimited when the env var is blank, non-numeric, or non-positive", () => {
    for (const v of ["", "  ", "abc", "0", "-5"]) {
      process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = v;
      expect(quotaForWorkspace("ws_1")).toBeNull();
    }
  });

  it("returns the configured byte value when positive", () => {
    process.env.DEFAULT_WORKSPACE_QUOTA_BYTES = "1048576";
    expect(quotaForWorkspace("ws_1")).toBe(1048576);
  });
});

describe("quotaStatus", () => {
  it("reports unlimited with no warning and null remaining", () => {
    expect(quotaStatus({ usedBytes: 9_999, limitBytes: null })).toEqual({
      usedBytes: 9_999,
      limitBytes: null,
      remainingBytes: null,
      warning: false,
    });
  });

  it("does not warn below the 0.9 ratio", () => {
    const s = quotaStatus({ usedBytes: 89, limitBytes: 100 });
    expect(s.warning).toBe(false);
    expect(s.remainingBytes).toBe(11);
  });

  it("warns at or above the 0.9 ratio", () => {
    expect(quotaStatus({ usedBytes: 90, limitBytes: 100 }).warning).toBe(true);
    expect(quotaStatus({ usedBytes: 100, limitBytes: 100 }).warning).toBe(true);
  });

  it("floors remaining at zero when over the limit", () => {
    expect(quotaStatus({ usedBytes: 150, limitBytes: 100 }).remainingBytes).toBe(0);
  });
});