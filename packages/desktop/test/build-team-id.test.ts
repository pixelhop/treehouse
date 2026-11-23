import { build } from "esbuild";
import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error — build.mjs is a plain ESM build script with no type declarations;
// we import its exported options so this test asserts the REAL bundle define, not a copy.
import { buildOptions } from "../scripts/build.mjs";

interface BuildOpts {
  teamId?: string;
  write?: boolean;
}
const makeOptions = buildOptions as (o?: BuildOpts) => Parameters<typeof build>[0];

// P0-1 CI gate: the Apple Team ID must be BAKED into the main-process bundle at build
// time (esbuild `define`). Without it the shipped app runs with the UNSET_TEAM_ID
// placeholder and refuses every daemon swap. These build the real entry in-memory
// (write:false) and assert the placeholder is present iff no Team ID was baked.

async function bundle(teamId: string): Promise<string> {
  const result = await build(makeOptions({ teamId, write: false }));
  return (result.outputFiles ?? []).map((f) => f.text).join("\n");
}

describe("TREEHOUSE_TEAM_ID bake", () => {
  it("eliminates the UNSET_TEAM_ID placeholder when a real Team ID is baked", async () => {
    const out = await bundle("ABCDE12345");
    expect(out).toContain("ABCDE12345");
    expect(out).not.toContain("UNSET_TEAM_ID");
  }, 30_000);

  it("keeps the fail-closed placeholder when no Team ID is baked", async () => {
    const out = await bundle("");
    expect(out).toContain("UNSET_TEAM_ID");
  }, 30_000);
});