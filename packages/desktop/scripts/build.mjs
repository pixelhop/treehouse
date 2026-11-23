import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the Electron MAIN process (TypeScript source + the raw-TS `cli` modules
// it drives + their deps like chokidar) into a single CommonJS file. Electron's
// main process is CJS; `electron` itself is provided by the runtime so it stays
// external. Bundling to one file sidesteps pnpm's symlinked node_modules layout
// inside the packaged .app (the renderer loads the remote SPA — near-zero local UI).

const dir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf8"));

/**
 * esbuild options for the main-process bundle. The Apple Team ID is BAKED IN at
 * bundle time via `define` — `EXPECTED_TEAM_ID` reads `process.env.TREEHOUSE_TEAM_ID`,
 * and a Finder-launched packaged app inherits no such env var, so without this define
 * the shipped app would run with the `UNSET_TEAM_ID` placeholder and refuse every
 * daemon swap. Empty ⇒ the placeholder survives (fail-closed AND detectable by CI).
 */
export function buildOptions({
  teamId = process.env.TREEHOUSE_TEAM_ID ?? "",
  allowAdhocDaemon = process.env.TREEHOUSE_ALLOW_ADHOC_DAEMON ?? "",
  write = true,
} = {}) {
  return {
    entryPoints: [`${dir}src/main.ts`],
    bundle: true,
    platform: "node",
    // Electron 45 runs Node 24.22 (and Chromium 156 for the preload, below). Keep
    // both targets in step with the `electron` version in package.json.
    target: "node24",
    format: "cjs",
    outfile: `${dir}dist/main.cjs`,
    external: ["electron"],
    legalComments: "none",
    logLevel: "info",
    write,
    define: {
      "process.env.TREEHOUSE_TEAM_ID": JSON.stringify(teamId),
      // Alpha escape hatch (see ALLOW_ADHOC_DAEMON in src/daemon.ts). Baked for the
      // same reason as the Team ID: a Finder-launched app inherits no env vars, so
      // an un-baked value would leave an unsigned build refusing its own daemon.
      "process.env.TREEHOUSE_ALLOW_ADHOC_DAEMON": JSON.stringify(allowAdhocDaemon),
      // The app's OWN version. `app.getVersion()` reads the app's package.json when
      // Electron can find it, and falls back to the Electron RUNTIME version when it
      // can't — which is what happens here, because the dev shell is launched
      // against an entry file rather than an app directory. That made a dev run
      // advertise itself as TreehouseDesktop/33.x, misleading in any log that
      // records a user agent. Baking the value removes the dependence on how the
      // shell happened to be launched.
      "process.env.TREEHOUSE_APP_VERSION": JSON.stringify(pkg.version),
      // PostHog for the shell (src/analytics.ts). Baked for the same reason as
      // the Team ID: a Finder-launched packaged app inherits no env vars, so an
      // un-baked key would leave analytics silently off in exactly the builds
      // we most want to hear from. Absent → analytics is inert, which is what
      // dev runs and self-built shells get.
      "process.env.TREEHOUSE_POSTHOG_KEY": JSON.stringify(process.env.TREEHOUSE_POSTHOG_KEY ?? ""),
      "process.env.TREEHOUSE_POSTHOG_HOST": JSON.stringify(
        process.env.TREEHOUSE_POSTHOG_HOST ?? "https://eu.i.posthog.com",
      ),
    },
  };
}

// Only build when invoked directly (`node scripts/build.mjs`), not when a test
// imports `buildOptions` to assert the bake.
/** The preload bundle. A SEPARATE entry: it runs in the sandboxed renderer, not
 * the main process, and must not drag main-process code in with it. The app
 * origin is NOT baked: the shell injects it per window (see APP_ORIGIN_ARG), so
 * self-hosted and dev origins work too. */
export function preloadOptions({ write = true } = {}) {
  return {
    entryPoints: [`${dir}src/preload.ts`],
    bundle: true,
    platform: "browser",
    target: "chrome156",
    format: "cjs",
    outfile: `${dir}dist/preload.cjs`,
    external: ["electron"],
    legalComments: "none",
    logLevel: "info",
    write,
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await build(buildOptions());
  await build(preloadOptions());
  console.log(`bundled dist/main.cjs (v${pkg.version})`);
}