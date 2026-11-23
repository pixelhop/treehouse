/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POSTHOG_CLI_TIMEOUT_MS,
  posthogSourceMapCredentials,
  uploadPosthogSourceMaps,
} from "../scripts/posthog-sourcemaps";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function outputDir(): string {
  const root = mkdtempSync(join(tmpdir(), "treehouse-posthog-sourcemaps-"));
  roots.push(root);
  const dir = join(root, ".output", "public");
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "app.js"), "export {};");
  writeFileSync(join(dir, "app.js.map"), "{}");
  writeFileSync(join(dir, "nested", "chunk.js.map"), "{}");
  return dir;
}

describe("PostHog source-map builds", () => {
  it("requires both upload credentials before enabling source maps", () => {
    expect(posthogSourceMapCredentials({})).toBeUndefined();
    expect(posthogSourceMapCredentials({ POSTHOG_CLI_TOKEN: "token" })).toBeUndefined();
    expect(posthogSourceMapCredentials({ POSTHOG_PROJECT_ID: "42" })).toBeUndefined();
    expect(
      posthogSourceMapCredentials({ POSTHOG_CLI_TOKEN: "token", POSTHOG_PROJECT_ID: "42" }),
    ).toEqual({ token: "token", projectId: "42" });
  });

  it("removes every public map after a forced upload failure", () => {
    const dir = outputDir();
    const run = vi
      .fn()
      .mockReturnValueOnce(Buffer.from(""))
      .mockImplementationOnce(() => {
        throw new Error("forced upload failure");
      });
    const warn = vi.fn();

    uploadPosthogSourceMaps({
      token: "token",
      projectId: "42",
      dir,
      host: "https://example.test",
      run,
      warn,
    });

    expect(run).toHaveBeenCalledTimes(2);
    for (const [, , options] of run.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({ timeout: POSTHOG_CLI_TIMEOUT_MS, killSignal: "SIGKILL" }),
      );
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "app.js.map"))).toBe(false);
    expect(existsSync(join(dir, "nested", "chunk.js.map"))).toBe(false);
    expect(existsSync(join(dir, "app.js"))).toBe(true);
  });
});