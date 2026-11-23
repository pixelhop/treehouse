import { readFileSync } from "node:fs";
import { join } from "node:path";

// One reader for a folder's `.treehouse/config.json`, shared by the onboarding
// resume logic (run.ts) and the real effects (effects.ts) so the partial-tolerant
// parse lives in exactly one place. Unlike cli's `loadConfig` (which requires every
// field and throws), this tolerates a partial/half-written config and never throws —
// resume needs to read `keyId`/`workspaceId` out of a config that may predate a crash.

export interface FolderConfig {
  keyId?: string;
  workspaceId?: string;
  apiBase?: string;
}

/**
 * Read a folder's `.treehouse/config.json` (partial-tolerant), or null if it is
 * absent/unreadable/not JSON. Only the fields the shell reasons about are surfaced.
 */
export function readFolderConfig(root: string): FolderConfig | null {
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".treehouse", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      keyId: typeof cfg.keyId === "string" ? cfg.keyId : undefined,
      workspaceId: typeof cfg.workspaceId === "string" ? cfg.workspaceId : undefined,
      apiBase: typeof cfg.apiBase === "string" ? cfg.apiBase : undefined,
    };
  } catch {
    return null;
  }
}