import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the CLI (TypeScript source + the pure `shared` workspace package +
// chokidar) into a single self-contained CommonJS file that Node SEA can embed.
// CJS is required by SEA; node builtins stay external (the embedded node provides
// them). The version is baked in via `define` so the binary self-reports.

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${cliDir}package.json`, "utf8"));

await build({
  entryPoints: [`${cliDir}src/index.ts`],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: `${cliDir}dist/treehouse.cjs`,
  define: { __TREEHOUSE_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "info",
});

console.log(`bundled dist/treehouse.cjs (v${pkg.version})`);