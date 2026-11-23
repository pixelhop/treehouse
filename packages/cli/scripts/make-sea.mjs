import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inject } from "postject";

// Produce a single-file `treehouse` binary from the bundle (run build.mjs first).
// SEA cannot cross-compile: this builds for THIS platform/arch using the node
// that runs the script (pin it to the project's node for release fidelity).
//
// macOS specifics (per the Node SEA docs): the existing signature must be
// stripped before injection and an ad-hoc signature re-applied after, or the
// arm64 binary won't launch at all. The macho segment name must match what the
// SEA loader reads (NODE_SEA).

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const out = `${cliDir}dist/treehouse${process.platform === "win32" ? ".exe" : ""}`;
const isMac = process.platform === "darwin";
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

mkdirSync(`${cliDir}dist`, { recursive: true });

// 1. Generate the SEA blob with the running node.
execFileSync(process.execPath, ["--experimental-sea-config", `${cliDir}sea-config.json`], {
  cwd: cliDir,
  stdio: "inherit",
});

// 2. Copy the node binary as the base executable.
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);

// 3. macOS: strip the inherited signature before injecting.
if (isMac) execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });

// 4. Inject the blob.
await inject(out, "NODE_SEA_BLOB", readFileSync(`${cliDir}dist/sea-prep.blob`), {
  sentinelFuse: SENTINEL,
  machoSegmentName: isMac ? "NODE_SEA" : undefined,
});

// 5. macOS: ad-hoc re-sign so it launches.
if (isMac) execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

console.log(`\n✓ built ${out} (${process.platform}/${process.arch}, node ${process.version})`);