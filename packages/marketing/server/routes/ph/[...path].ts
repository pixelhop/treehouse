import { defineEventHandler, getRequestHeaders, getRequestIP, getRequestURL } from "h3";
import {
  POSTHOG_API_HOST,
  POSTHOG_ASSET_HOST,
  posthogUpstreamUrl,
  proxyRequestHeaders,
} from "shared";
import { relayToUpstream } from "../../utils/proxy";

/**
 * /ph/** — reverse proxy for PostHog.
 *
 * Analytics served from `*.posthog.com` is blocked by essentially every tracker
 * blocker and by a good number of corporate networks. The failure is silent: the
 * app works, no error appears, and the data for that slice of users simply never
 * arrives — which is worse than no analytics, because the numbers look fine.
 * Serving PostHog from our own origin removes the thing those filters match on.
 *
 * It also means the browser never opens a cross-origin connection to a third
 * party at all: the SDK talks to this Worker, and this Worker talks to PostHog.
 *
 * This runs in the app's own Cloudflare Worker (the SPA is `ssr: false`, but its
 * server side is live — see server/routes/.well-known/treehouse.get.ts). The
 * hostnames, the header policy and the cookie-stripping live in `shared` so the
 * marketing site's identical proxy cannot drift away from this one.
 */
export default defineEventHandler((event) => {
  const path = (event.context.params?.path as string | undefined) ?? "";
  const search = getRequestURL(event).search ?? "";
  const target = posthogUpstreamUrl(path, search);

  // Which upstream we settled on decides the `host` header we must pin.
  const upstreamHost = target.startsWith(`https://${POSTHOG_ASSET_HOST}`)
    ? POSTHOG_ASSET_HOST
    : POSTHOG_API_HOST;

  const headers = proxyRequestHeaders(
    getRequestHeaders(event),
    upstreamHost,
    getRequestHeaders(event)["x-forwarded-for"] ?? getRequestIP(event),
  );

  // Body and response are passed through as raw bytes (see relayToUpstream).
  return relayToUpstream(event, target, headers);
});