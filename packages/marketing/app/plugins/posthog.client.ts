// PostHog for the marketing site — consent-gated.
//
// Different posture from the product app (packages/app/app/plugins/posthog.client.ts).
// Everyone here is an anonymous visitor who has agreed to nothing, so PostHog is
// not initialised AT ALL until they accept. The app, by contrast, initialises on
// load: those people have an account and a contract.
//
// `opt_out_capturing_by_default` is deliberately NOT used, even though it looks
// like the obvious fit. It suppresses event CAPTURE but still initialises the
// SDK, which loads posthog's bundles and calls the /flags endpoint — so a
// visitor who never answered the banner has already had their IP forwarded and
// had opt-out state written to their device. Verified in a browser: a fresh load
// with opt_out_capturing_by_default made four requests before the banner was
// touched. "No tracking until you say so" has to mean no requests.
//
// The cost of this strictness: a visitor who REJECTS is not counted at all, not
// even anonymously in aggregate (which `cookieless_mode: "on_reject"` would have
// allowed, but only by initialising). Losing that number is the honest price of
// the banner saying what it means.
//
// Client-only (.client): posthog-js is browser-only and this is an SPA.
import posthog from "posthog-js";
import { POSTHOG_UI_HOST } from "shared";

/** Where the visitor's answer is remembered. Read by CookieBanner.vue too. */
export const CONSENT_KEY = "treehouse:analytics-consent";

export type ConsentChoice = "accepted" | "rejected";

/** The stored answer, or null if they have not been asked yet. */
export function readConsent(): ConsentChoice | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === "accepted" || v === "rejected" ? v : null;
  } catch {
    // Private browsing with storage disabled. Treat as "not asked" — the banner
    // shows again, which is the harmless direction.
    return null;
  }
}

/**
 * Start PostHog. Called on first load when consent was already given, and by
 * CookieBanner.vue the moment the visitor accepts. Safe to call twice.
 */
export function startPostHog(key: string, host: string): void {
  if (!key || posthog.__loaded) return;

  posthog.init(key, {
    api_host: host,
    ui_host: POSTHOG_UI_HOST,
    defaults: "2025-05-24",
    // This site is public marketing copy — no user content, so no masking
    // contract to maintain. Autocapture stays on because knowing which CTA
    // people press is the entire point of measuring a marketing site.
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
    },
  });
}

export default defineNuxtPlugin(() => {
  const { key, host } = useRuntimeConfig().public.posthog as { key: string; host: string };
  if (!key) return;

  // Only for visitors who have already said yes. Everyone else gets nothing
  // until they answer.
  if (readConsent() === "accepted") startPostHog(key, host);
});