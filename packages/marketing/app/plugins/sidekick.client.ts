// Sidekick: Pixelhop's affiliate programme (github.com/pixelhop/sidekick).
//
// An affiliate's link lands here as `trytree.house/?via=<code>`. Sidekick's
// script records the click and keeps the referral id in the `sk_ref` cookie on
// `.trytree.house`, which the browser then sends with the app's checkout request
// to api.trytree.house. That route puts it on the Stripe Checkout Session
// (packages/api/server/utils/sidekick.ts), and Sidekick credits the affiliate
// when the payment comes through.
//
// Same posture as the analytics (plugins/posthog.client.ts): nothing is
// recorded or stored until the visitor accepts the cookie banner.
//
// - Visitors who did not arrive through an affiliate link load nothing at all.
//   Only a page whose URL carries the link parameter fetches the script.
// - The script runs in Sidekick's consent mode (`data-consent="required"`): it
//   reads the link code from the landing URL but records no click and sets no
//   cookie until `window.Sidekick.consent()` is called. CookieBanner.vue calls
//   it on accept, and the code is still credited if they browse first.
// - A visitor who has already accepted is tracked straight away
//   (`window.SidekickConsent = true` before the script loads).
//
// Rejecting loses the link attribution. An affiliate's coupon code typed at
// Stripe checkout still credits them, with no cookie involved.
//
// Off unless NUXT_PUBLIC_SIDEKICK_PROGRAMME is set, which only the production
// deploy does (.github/workflows/cloudflare.yml).
import { readConsent } from "./posthog.client";

/** Sidekick's default link parameter, the one affiliates' links use. */
const LINK_PARAM = "via";

declare global {
  interface Window {
    Sidekick?: { referral: string | null; consent: () => Promise<string | null> };
    SidekickConsent?: boolean;
  }
}

export interface SidekickConfig {
  programme: string;
  scriptUrl: string;
  portalUrl: string;
  cookieDomain: string;
}

/** The programme's public join page, or null when the programme is not configured. */
export function sidekickJoinUrl(config: SidekickConfig): string | null {
  if (!config.programme) return null;
  return `${config.portalUrl.replace(/\/+$/, "")}/p/${encodeURIComponent(config.programme)}`;
}

/** Record the click and store the referral. Called by CookieBanner.vue on accept. */
export function consentToSidekick(): void {
  // Before the script has loaded, this flag is what it checks instead.
  window.SidekickConsent = true;
  void window.Sidekick?.consent();
}

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig().public.sidekick as SidekickConfig;
  if (!config.programme) return;

  let code: string | null = null;
  try {
    code = new URL(window.location.href).searchParams.get(LINK_PARAM);
  } catch {
    return;
  }
  if (!code) return;

  // Lets the cookie banner say what accepting means for this visitor.
  useState<boolean>("sidekick-referred").value = true;
  if (readConsent() === "accepted") window.SidekickConsent = true;

  const script = document.createElement("script");
  script.async = true;
  script.src = config.scriptUrl;
  script.dataset.programme = config.programme;
  script.dataset.consent = "required";
  if (config.cookieDomain) script.dataset.domain = config.cookieDomain;
  document.head.appendChild(script);
});