#!/usr/bin/env node
// Verify the PWA invariants of a finished app build (.output/public).
//
// Chained after `nuxt build` (see package.json) so the canonical build path
// fails closed. Catches the failure modes that neither the typecheck nor unit
// tests can see, because they only exist in the generated artifacts:
//   - the navigation fallback missing or unbound (the SW then throws
//     `non-precached-url` on every offline navigation, or never serves the
//     shell at all);
//   - the worker regenerated with immediate activation (skipWaiting outside
//     the SKIP_WAITING message listener would reload tabs over unsaved edits)
//     or with NO activation handler (the plugin's SKIP_WAITING message could
//     never activate an update);
//   - clientsClaim dropped (a deliberately activated worker would not take
//     over open tabs, so the activation reload never fires);
//   - a missing/renamed manifest or icon breaking installability;
//   - the prerendered shell pointing the browser at a DIFFERENT API than the
//     Worker's runtime var (see apiUrlFailures — this one took production
//     sign-in down once, silently).
//
// The check functions are exported for the unit tests in
// test/verifyPwaBuild.test.ts, which run them against synthetic good and bad
// workers — including the false-pass fixtures from PR #74's review.
//
// Usage: node scripts/verify-pwa-build.mjs  (from packages/app, after a build)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The nuxt.config default for public.apiUrl — a dev build, never deployable. */
const DEV_API_URL = "http://localhost:3010";

/** Failures in a generated service worker's text. Pure; exported for tests. */
export function swFailures(sw) {
  const failures = [];
  if (!/url:"\/"/.test(sw)) {
    failures.push('precache manifest has no entry for "/" — offline navigation fallback is broken');
  }
  // The precache entry alone proves nothing: a navigation route must actually
  // be BOUND to it, or offline navigations never serve the shell.
  if (!/createHandlerBoundToURL\("\/"\)/.test(sw)) {
    failures.push(
      'no navigation fallback handler bound to "/" (createHandlerBoundToURL) — offline navigations would not serve the shell',
    );
  }
  // Prompt-style activation: EXACTLY ONE skipWaiting call, and it must sit
  // inside the SKIP_WAITING message listener. Zero handlers means the
  // plugin's SKIP_WAITING message can never activate an update; an
  // unconditional call reloads tabs over unsaved edits.
  const calls = sw.match(/self\.skipWaiting\(\)/g) ?? [];
  const gated = sw.match(/SKIP_WAITING[^}]*self\.skipWaiting\(\)/g) ?? [];
  if (gated.length !== 1 || calls.length !== 1) {
    failures.push(
      `expected exactly one skipWaiting call, gated behind the SKIP_WAITING message (found ${calls.length} call(s), ${gated.length} gated) — ` +
        (calls.length === 0
          ? "with none, updates can never be activated"
          : "an ungated call activates immediately and reloads tabs over unsaved edits"),
    );
  }
  if (!/clientsClaim\(\)/.test(sw)) {
    failures.push(
      "sw.js never calls clientsClaim() — a deliberately activated worker would not take over open tabs, so the activation reload never fires",
    );
  }
  return failures;
}

/** Failures in the parsed web manifest. Pure; exported for tests. */
export function manifestFailures(m) {
  const failures = [];
  if (m.name !== "Treehouse") failures.push(`manifest name is ${JSON.stringify(m.name)}`);
  if (m.display !== "standalone") failures.push(`manifest display is ${JSON.stringify(m.display)}`);
  const purposes = new Set((m.icons ?? []).map((i) => i.purpose ?? "any"));
  if (!purposes.has("any") || !purposes.has("maskable")) {
    failures.push("manifest icons must include both an ordinary and a maskable icon");
  }
  return failures;
}

/** Failures in the built shell HTML. Pure; exported for tests. */
export function htmlFailures(html) {
  const failures = [];
  if (!html.includes('rel="manifest"')) failures.push("index.html has no manifest link");
  if (!html.includes('name="theme-color"')) failures.push("index.html has no theme-color meta");
  return failures;
}

/**
 * The public.apiUrl frozen into the prerendered shell's runtime-config
 * payload (`window.__NUXT__.config={public:{apiUrl:"…"`), or null when the
 * payload is absent. Pure; exported for tests.
 */
export function bakedApiUrl(html) {
  const m = html.match(/window\.__NUXT__\.config=\{.*?apiUrl:"([^"]*)"/s);
  return m ? m[1] : null;
}

/**
 * Failures from the shell's baked API origin disagreeing with the Worker's
 * runtime var. Pure; exported for tests.
 *
 * Prerendering "/" (needed so the service worker can precache the shell)
 * FREEZES `NUXT_PUBLIC_API_URL` as it was at BUILD time — and, because the
 * worker serves that shell for every navigation, that frozen value is the
 * API the whole app talks to. Before prerendering, the Worker rendered the
 * shell per request and its runtime var quietly overrode a stale build-time
 * value; prerendering removed that mask, and production shipped a shell
 * pointing at a retired API host. The API's session cookie is scoped to the
 * current domain, so sign-in "succeeded" and the browser dropped the cookie:
 * nothing happened after clicking the button.
 *
 * Both values must therefore agree, and the build — not the deploy — is where
 * a disagreement is caught, so git-connected builds fail closed too. A dev
 * build (the nuxt.config default) is allowed through here; preflight-deploy
 * refuses to ship it.
 */
export function apiUrlFailures({ baked, expected }) {
  if (baked === null) {
    return [
      "index.html has no window.__NUXT__.config payload — the shell was not prerendered, so the service worker cannot precache it",
    ];
  }
  if (baked === DEV_API_URL || expected === undefined) return [];
  if (baked === expected) return [];
  return [
    `index.html bakes public.apiUrl=${baked} but wrangler.jsonc vars.NUXT_PUBLIC_API_URL=${expected} — ` +
      "the prerendered shell would send the browser to a different API than the one this deployment declares. " +
      "Set the BUILD-time NUXT_PUBLIC_API_URL (Cloudflare Workers Builds → Settings → Build → Variables, " +
      "or the shell env for a local build) to match wrangler.jsonc, then rebuild.",
  ];
}

/**
 * The API origin a deployment declares, for the wrangler environment it targets.
 * Pure; exported for tests.
 *
 * `cfEnv` is CLOUDFLARE_ENV, the same variable wrangler reads to pick an
 * environment, so the build is checked against what will actually deploy.
 * A wrangler environment does not inherit `vars`, so a staging build must be
 * compared with `env.staging.vars`, never the top-level (production) ones.
 * Naming an environment wrangler.jsonc does not define is a failure in itself.
 */
export function wranglerApiUrl(wrangler, cfEnv) {
  if (!cfEnv) return { expected: wrangler.vars?.NUXT_PUBLIC_API_URL, failures: [] };
  const env = wrangler.env?.[cfEnv];
  if (!env) {
    return {
      expected: undefined,
      failures: [`CLOUDFLARE_ENV=${cfEnv} has no env.${cfEnv} block in wrangler.jsonc`],
    };
  }
  return { expected: env.vars?.NUXT_PUBLIC_API_URL, failures: [] };
}

/**
 * Minimal JSONC reader for wrangler.jsonc: strips // and /* *\/ comments
 * outside strings and trailing commas, then JSON.parses. Pure; exported for
 * tests. Deliberately dependency-free — this script runs before anything is
 * installed for it beyond Node itself.
 */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      // Copy a string verbatim, honouring escapes.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function main() {
  const out = join(process.cwd(), ".output/public");
  const failures = [];

  async function read(name) {
    try {
      return await readFile(join(out, name), "utf8");
    } catch {
      failures.push(`missing build artifact: ${name}`);
      return null;
    }
  }

  const sw = await read("sw.js");
  if (sw) failures.push(...swFailures(sw));

  const manifest = await read("manifest.webmanifest");
  if (manifest) {
    const m = JSON.parse(manifest);
    failures.push(...manifestFailures(m));
    for (const icon of m.icons ?? []) await read(icon.src.replace(/^\//, ""));
  }

  const html = await read("index.html");
  if (html) {
    failures.push(...htmlFailures(html));
    // wrangler.jsonc is read from the package root, not the build output.
    const wrangler = parseJsonc(await readFile(join(process.cwd(), "wrangler.jsonc"), "utf8"));
    const target = wranglerApiUrl(wrangler, process.env.CLOUDFLARE_ENV);
    failures.push(...target.failures);
    failures.push(...apiUrlFailures({ baked: bakedApiUrl(html), expected: target.expected }));
  }

  if (failures.length > 0) {
    console.error("PWA build verification FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    "PWA build verification passed: precached shell, prompt-style worker, valid manifest, " +
      `shell API origin ${bakedApiUrl(html)}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}