import { getCookie, type H3Event } from "h3";

// Sidekick: Pixelhop's affiliate programme service (github.com/pixelhop/sidekick).
//
// Sidekick's script on the marketing site records an affiliate click and keeps
// the referral id it gets back in the `sk_ref` cookie, set on `.trytree.house`
// (see packages/marketing/app/plugins/sidekick.client.ts). The browser sends
// that cookie along with the app's credentialed checkout request to
// api.trytree.house, so the checkout route can read it here without the app
// ever handling it.
//
// Sidekick normally expects the referral as the Checkout Session's
// `client_reference_id`, but the better-auth Stripe plugin owns that field (it
// holds the organization id, and the plugin strips any override). So it goes
// in the session's metadata as `sidekick_referral`, which Sidekick reads first.
//
// With no cookie (no affiliate link, no consent, a self-hosted deployment, the
// desktop app's separate cookie jar) nothing is sent and checkout is unchanged.

/** The cookie Sidekick's tracking script stores the referral id in. */
export const SIDEKICK_REFERRAL_COOKIE = "sk_ref";

/** The Checkout Session metadata key Sidekick reads the referral from. */
export const SIDEKICK_REFERRAL_METADATA_KEY = "sidekick_referral";

// Sidekick's referral ids are cuids. The check is looser than that on purpose,
// so a change of id format there does not silently drop referrals here; it
// only has to keep an arbitrary cookie value out of Stripe metadata.
const REFERRAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A referral id fit to send to Stripe, or null for anything else. */
export function sidekickReferral(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  return value && REFERRAL_ID.test(value) ? value : null;
}

/** Checkout Session metadata crediting the visitor's affiliate, if they have one. */
export function sidekickCheckoutMetadata(event: H3Event): Record<string, string> | undefined {
  const referral = sidekickReferral(getCookie(event, SIDEKICK_REFERRAL_COOKIE));
  return referral ? { [SIDEKICK_REFERRAL_METADATA_KEY]: referral } : undefined;
}