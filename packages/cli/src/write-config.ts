import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config";

function configPath(root: string): string {
  return join(root, ".treehouse", "config.json");
}

/**
 * Write `<root>/.treehouse/config.json` with mode 0600. Refuses to overwrite an
 * existing config unless `force` (re-link safety) — the error names the workspace
 * the directory is already linked to.
 */
export function saveConfig(root: string, cfg: Config, force = false): void {
  const path = configPath(root);
  if (existsSync(path) && !force) {
    let current = "";
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
      if (existing.workspaceId) current = ` (linked to workspace ${existing.workspaceId})`;
    } catch {
      // ignore an unreadable existing file; the path in the message is enough
    }
    throw new Error(
      `config already exists at ${path}${current} — re-run with --force to replace it`,
    );
  }
  // Atomic write (temp + rename, like index-store/cursor-store): a crash mid-
  // write must not leave a truncated config that then blocks a no-force re-link.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}