import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { configFingerprint, loadConfig } from "../src/config";

const ENV_KEYS = ["TREEHOUSE_API_BASE", "TREEHOUSE_API_KEY", "TREEHOUSE_WORKSPACE_ID"] as const;

const roots: string[] = [];
function folder(cfg: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "th-config-"));
  roots.push(root);
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(join(root, ".treehouse", "config.json"), JSON.stringify(cfg));
  return root;
}

const FILE = {
  apiBase: "https://api.example.com",
  apiKey: "secret",
  workspaceId: "ws",
  keyId: "K1",
};

describe("loadConfig", () => {
  // These vars OVERRIDE the config file, so an ambient TREEHOUSE_* in the
  // developer's shell would quietly invalidate every assertion below. Clear them
  // for the duration and put whatever was there back afterwards.
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const prev = saved[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  it("carries the file's keyId through as the revocation handle", () => {
    // The key secret alone can't be revoked, so a caller holding a Config needs
    // the id that came with it.
    expect(loadConfig(folder(FILE))).toEqual(FILE);
  });

  it("drops the keyId when TREEHOUSE_API_KEY overrides the secret", () => {
    // The env key is a different credential; pairing it with the file's id would
    // hand the caller a handle that revokes the wrong key.
    process.env.TREEHOUSE_API_KEY = "other-secret";
    const cfg = loadConfig(folder(FILE));
    expect(cfg.apiKey).toBe("other-secret");
    expect(cfg.keyId).toBeUndefined();
  });

  it("omits keyId entirely for a config written before it existed", () => {
    const { keyId: _drop, ...legacy } = FILE;
    expect(loadConfig(folder(legacy))).toEqual(legacy);
    expect("keyId" in loadConfig(folder(legacy))).toBe(false);
  });
});
describe("configFingerprint", () => {
  it("changes when the folder is re-keyed, so a running engine gets restarted", () => {
    const base = { apiBase: "https://api.test", workspaceId: "ws1", apiKey: "old" };
    expect(configFingerprint(base)).toBe(configFingerprint({ ...base, keyId: "irrelevant" }));
    expect(configFingerprint({ ...base, apiKey: "new" })).not.toBe(configFingerprint(base));
    expect(configFingerprint({ ...base, apiBase: "https://other" })).not.toBe(
      configFingerprint(base),
    );
    expect(configFingerprint({ ...base, workspaceId: "ws2" })).not.toBe(configFingerprint(base));
  });
});