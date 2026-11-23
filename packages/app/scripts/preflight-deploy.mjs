// Refuse to deploy a build that still has the local-dev API URL baked in.
//
// `nuxt build` takes NUXT_PUBLIC_API_URL from the environment and, because this
// is an SSR-less SPA, BAKES it into the bundle. The script is a plain
// `nuxt build`, so a deploy run as `build && deploy` with no env var produces a
// Worker that points the whole app at http://localhost:3010 — and it fails
// silently: the Worker serves 200s, only the browser's API calls die. The
// runtime `vars` entry in wrangler.jsonc does NOT cover this; it feeds the
// /.well-known/treehouse route, and the two MUST agree — the prerendered shell
// (.output/public/index.html) freezes the build-time value and the service
// worker serves that shell for every navigation. verify-pwa-build.mjs (chained
// into `pnpm build`) fails a build whose shell disagrees with the vars entry;
// this preflight catches the one value that check waves through: the dev
// default.
//
// Guarding on the dev default rather than on a specific production host keeps
// this correct for previews and self-hosted deploys too.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEV_API_URL = "localhost:3010";
const OUTPUT_DIR = new URL("../.output/", import.meta.url).pathname;

// Both halves of the build, because which one carries the value is an
// implementation detail of the Nitro preset. Today it lands in the server
// chunk (runtime-rendered routes ship public runtime config in the injected
// payload) AND in public/index.html (the prerendered PWA shell freezes the same
// payload at build time). Scanning only one half would make this guard
// silently useless the day the split changes.
const SCAN_DIRS = ["server", "public"].map((d) => join(OUTPUT_DIR, d));

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

// An absent half is legitimate (a static-only preset emits no server dir), so
// it is checked for explicitly rather than inferred from a thrown error. Every
// other failure — EACCES, EIO, a file vanishing mid-walk — propagates and takes
// the deploy down with it. Swallowing those would let a half-scanned build read
// as clean, which is the exact silent pass this guard exists to prevent.
const built = SCAN_DIRS.flatMap((dir) => (existsSync(dir) ? [...walk(dir)] : []));

if (built.length === 0) {
  console.error("\n✗ No .output — build before deploying.\n");
  process.exit(1);
}

const offenders = built.filter((f) => readFileSync(f, "utf8").includes(DEV_API_URL));

if (offenders.length > 0) {
  console.error(
    `\n✗ This build has the dev API URL (${DEV_API_URL}) baked in — deploying it would\n` +
      `  point production at localhost. NUXT_PUBLIC_API_URL was unset at BUILD time.\n\n` +
      `  Rebuild with it set, then deploy:\n` +
      `    NUXT_PUBLIC_API_URL=https://api.trytree.house vp run app#build\n\n` +
      `  Found in: ${offenders.map((f) => f.replace(OUTPUT_DIR, "")).join(", ")}\n`,
  );
  process.exit(1);
}