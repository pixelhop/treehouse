import { readFileSync } from "node:fs";

// Build the auto-update manifest (latest.json) from a SHA256SUMS file produced by
// the release workflow. Usage: node scripts/make-latest-json.mjs <version> <SHA256SUMS path>
// Prints JSON to stdout. Each line of SHA256SUMS is "<sha256>  treehouse-<target>[.exe]".

const [version, sumsPath] = process.argv.slice(2);
if (!version || !sumsPath) {
  console.error("usage: make-latest-json.mjs <version> <SHA256SUMS path>");
  process.exit(1);
}

// Asset URLs point at the public R2 download domain (the repo is private, so
// GitHub release URLs aren't anonymously fetchable). Versioned path so the
// manifest references immutable artifacts. Override base via DL_BASE_URL.
const dlBase = process.env.DL_BASE_URL ?? "https://dl.trytree.house";
const base = `${dlBase}/cli/v${version}`;

const assets = {};
for (const line of readFileSync(sumsPath, "utf8").split("\n")) {
  const m = line.trim().match(/^([0-9a-f]{64})\s+(treehouse-([a-z0-9-]+?)(?:\.exe)?)$/i);
  if (!m) continue;
  const [, sha256, name, target] = m;
  assets[target] = { name, url: `${base}/${name}`, sha256 };
}

process.stdout.write(`${JSON.stringify({ version, assets }, null, 2)}\n`);