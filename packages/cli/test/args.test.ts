import { describe, expect, it } from "vite-plus/test";
import { positionals } from "../src/args";

describe("positionals", () => {
  it("finds the folder wherever the flags are", () => {
    expect(positionals(["~/Acme", "--workspace", "ws_1"])).toEqual(["~/Acme"]);
    expect(positionals(["--workspace", "ws_1", "~/Acme"])).toEqual(["~/Acme"]);
  });

  // An agent writing `login --api-base <url> <folder>` must not end up syncing
  // into a folder named after the URL.
  it("never mistakes a flag's value for a folder", () => {
    expect(positionals(["--api-base", "https://api.example.com", "~/Acme", "--force"])).toEqual([
      "~/Acme",
    ]);
  });

  it("keeps both paths for relocate", () => {
    expect(positionals(["~/old", "~/new"])).toEqual(["~/old", "~/new"]);
  });
});