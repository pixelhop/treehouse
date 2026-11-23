import { readFileSync, writeFileSync } from "node:fs";
import { appDir, ensureAppDir } from "./paths";

// Self-update support. Binaries are published to a public R2 bucket with a
// `latest.json` manifest (version + per-target name/url/sha256); the `update`
// command and the daemon's passive check both read it. Override the host with
// TREEHOUSE_DL_BASE for dev/self-host.

export const DL_BASE = process.env.TREEHOUSE_DL_BASE ?? "https://dl.trytree.house";

export interface LatestManifest {
  version: string;
  assets: Record<string, { name: string; url: string; sha256: string }>;
}

// Baked in by the bundler (esbuild `define`); "dev" when run from source.
declare const __TREEHOUSE_VERSION__: string;
export function currentVersion(): string {
  return typeof __TREEHOUSE_VERSION__ !== "undefined" ? __TREEHOUSE_VERSION__ : "dev";
}

/** Release asset key for this machine, e.g. "darwin-arm64" / "win32-x64". */
export function currentTarget(): string {
  return `${process.platform}-${process.arch}`;
}

/** True when `latest` is a strictly higher release than `current`. A "dev" build
 * (run from source) never self-updates. Prerelease suffixes are ignored. */
export function isNewer(latest: string, current: string): boolean {
  if (current === "dev" || !latest) return false;
  const parse = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function fetchLatest(): Promise<LatestManifest> {
  const res = await fetch(`${DL_BASE}/cli/latest/latest.json`);
  if (!res.ok) throw new Error(`update check failed: HTTP ${res.status}`);
  return (await res.json()) as LatestManifest;
}

// The daemon records the latest seen version here so `treehouse status` can
// surface "update available" without a network call of its own.
const updateStatePath = (): string => `${appDir()}/update.json`;

export function readLatestSeen(): string | undefined {
  try {
    return (JSON.parse(readFileSync(updateStatePath(), "utf8")) as { latest?: string }).latest;
  } catch {
    return undefined;
  }
}

export function writeLatestSeen(latest: string): void {
  ensureAppDir();
  writeFileSync(updateStatePath(), JSON.stringify({ latest }));
}