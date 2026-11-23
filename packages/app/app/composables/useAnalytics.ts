import type { Analytics } from "~/plugins/posthog.client";

/**
 * Product analytics, error reporting and surveys.
 *
 * Always returns a usable object: when PostHog is not configured (local dev, CI,
 * self-hosted) every method is a no-op. Callers must NOT guard with
 * `if (analytics)` or check a flag — that branch would spread through the
 * codebase one component at a time and eventually someone would get it wrong in
 * the direction that throws.
 *
 * Two rules for anything captured through this:
 *   1. No file names, paths, or file contents in event names or properties.
 *      Send an extension, a byte count, a boolean or a result count instead.
 *   2. No search queries, share tokens or invite tokens, for the same reason.
 *
 * See app/plugins/posthog.client.ts for the privacy configuration this sits on.
 */
export function useAnalytics(): Analytics {
  const { $analytics } = useNuxtApp();
  return $analytics as Analytics;
}