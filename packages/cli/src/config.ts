import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  apiBase: string;
  apiKey: string;
  workspaceId: string;
  /** The minted key's id (the revocation handle). Optional — absent on configs
   * written before the device flow returned it, or by older CLIs. */
  keyId?: string;
}

/**
 * Resolve config from `<root>/.treehouse/config.json` with env-var overrides
 * (TREEHOUSE_API_BASE / TREEHOUSE_API_KEY / TREEHOUSE_WORKSPACE_ID). The key is
 * a workspace-scoped API key minted in the web app.
 */
export function loadConfig(root: string): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(
      readFileSync(join(root, ".treehouse", "config.json"), "utf8"),
    ) as Partial<Config>;
  } catch {
    // no config file is fine if env vars are set
  }

  const apiBase = process.env.TREEHOUSE_API_BASE ?? file.apiBase;
  const apiKey = process.env.TREEHOUSE_API_KEY ?? file.apiKey;
  const workspaceId = process.env.TREEHOUSE_WORKSPACE_ID ?? file.workspaceId;

  if (!apiBase || !apiKey || !workspaceId) {
    throw new Error(
      "Missing config. Set TREEHOUSE_API_BASE, TREEHOUSE_API_KEY, TREEHOUSE_WORKSPACE_ID " +
        "or create .treehouse/config.json with { apiBase, apiKey, workspaceId }.",
    );
  }
  // Carry the revocation handle through only when the effective key is the one
  // the file recorded it for. If TREEHOUSE_API_KEY overrode the secret, the
  // file's keyId belongs to a different key — pairing them would hand a caller a
  // handle that revokes the wrong key.
  const keyId = process.env.TREEHOUSE_API_KEY ? undefined : file.keyId;
  return { apiBase, apiKey, workspaceId, ...(keyId ? { keyId } : {}) };
}

/**
 * Identity of the credential an engine is running with. A running engine holds
 * the key it was constructed with for the life of the process, so after a
 * re-auth (which mints a NEW key into the folder and revokes the old one) the
 * daemon must notice and restart that engine — otherwise it keeps authenticating
 * with a revoked key and 401s forever while every other client, using the new
 * key from the same file, works fine. Compared as a string so a caller can hold
 * it without holding the secret itself.
 */
export function configFingerprint(cfg: Config): string {
  return [cfg.apiBase, cfg.workspaceId, cfg.apiKey].join("|");
}