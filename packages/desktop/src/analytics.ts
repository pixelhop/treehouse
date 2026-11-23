import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, ensureAppDir } from "cli/src/paths";
import { PostHog } from "posthog-node";

// Analytics for the SHELL ONLY.
//
// The workspace window renders the remote web app, which runs its own PostHog
// (packages/app/app/plugins/posthog.client.ts) — everything the user does inside
// the workspace is already covered and must NOT be double-counted here. What is
// otherwise completely invisible is the native shell around it: onboarding that
// dies at the device-grant step, a sync daemon that crashes on launch, an update
// that never installs. Those are the events this file exists for.
//
// Three rules, in descending order of how badly it goes if they are broken:
//
//  1. NEVER send a filesystem path. The user's sync folder is under
//     /Users/<their real name>/, so a single path property leaks the operator's
//     name to an analytics vendor. Send a boolean, a count, or nothing.
//  2. NEVER send secrets. This process handles session cookies, device codes and
//     a minted API key. Same discipline as the onboarding journal
//     (src/onboarding/journal.ts), which documents why at length.
//  3. NEVER break the thing it measures. Every call here is wrapped and
//     swallowed. A telemetry failure must not take down onboarding.
//
// Inert unless a key was baked at build time (scripts/build.mjs), so dev runs
// and self-built shells send nothing.

/** Baked by esbuild's `define` at bundle time — a Finder-launched packaged app
 * inherits no env vars, so an un-baked value would silently disable this in
 * exactly the builds we most want to hear from. */
const POSTHOG_KEY = process.env.TREEHOUSE_POSTHOG_KEY || "";
const POSTHOG_HOST = process.env.TREEHOUSE_POSTHOG_HOST || "https://eu.i.posthog.com";
// PostHog defaults shutdown to 30 seconds. The shell's quit path awaits this
// call, so keep the best-effort flush brief rather than making a user wait for
// an analytics service to release the process.
const SHUTDOWN_TIMEOUT_MS = 1_000;

/** Where the anonymous install id lives. Beside the onboarding journal, under
 * `appDir()` — which honours TREEHOUSE_HOME, so dev runs stay isolated. */
const idPath = (): string => join(appDir(), "analytics.json");

let cachedId: string | null = null;

/**
 * A stable, random, per-INSTALL identifier.
 *
 * Not the machine id, not the hostname, not the username — all of which
 * identify a person rather than an installation. This is a random UUID that
 * means nothing outside our own analytics, and once the user signs in it is
 * aliased to their real user id so the desktop and web sessions join up.
 */
export function installId(): string {
  if (cachedId) return cachedId;
  try {
    ensureAppDir();
    const raw = JSON.parse(readFileSync(idPath(), "utf8")) as { installId?: string };
    if (typeof raw.installId === "string" && raw.installId) {
      cachedId = raw.installId;
      return cachedId;
    }
  } catch {
    // No file yet, or unreadable — fall through and mint one.
  }
  const id = randomUUID();
  try {
    ensureAppDir();
    writeFileSync(idPath(), JSON.stringify({ installId: id }), "utf8");
  } catch {
    // Unwritable disk: use the id for this session and mint a new one next time.
    // Slightly noisier data beats refusing to run.
  }
  cachedId = id;
  return id;
}

let client: PostHog | null = null;
let started = false;

function getClient(): PostHog | null {
  if (started) return client;
  started = true;
  if (!POSTHOG_KEY) return null;
  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // The shell is short-lived and low-volume; flushing promptly matters more
      // than batching, because a crash we never hear about is the failure mode.
      flushAt: 1,
      flushInterval: 5_000,
    });
  } catch {
    client = null;
  }
  return client;
}

/** Properties attached to every shell event. Version and platform only — enough
 * to tell "broken on 0.1.3 / macOS arm64" from "broken everywhere". */
function baseProperties(): Record<string, unknown> {
  return {
    $app_version: process.env.TREEHOUSE_APP_VERSION || "0.0.0",
    platform: process.platform,
    arch: process.arch,
    surface: "desktop",
  };
}

/** Capture a shell event. Silent when analytics is off or anything goes wrong. */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  try {
    getClient()?.capture({
      distinctId: installId(),
      event,
      properties: { ...baseProperties(), ...properties },
    });
  } catch {
    // See rule 3.
  }
}

/**
 * Join this install to the signed-in user, so the desktop funnel and the web
 * session are one person rather than two.
 */
export function identifyUser(userId: string): void {
  try {
    getClient()?.alias({ distinctId: userId, alias: installId() });
  } catch {
    // See rule 3.
  }
}

/** Flush buffered events before the process exits. */
export async function shutdownAnalytics(): Promise<void> {
  try {
    await getClient()?.shutdown(SHUTDOWN_TIMEOUT_MS);
  } catch {
    // See rule 3.
  }
}