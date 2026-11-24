import { defineEventHandler, getRequestHeaders, getRequestIP } from "h3";
import { proxyRequestHeaders } from "shared";
import { PLAUSIBLE_ORIGIN } from "../../../app/utils/plausible";
import { relayToUpstream, visitorIp } from "../../utils/proxy";

/**
 * /pv/event — Plausible's event endpoint, proxied.
 *
 * Plausible counts a visitor from their IP and user agent, so both must be the
 * visitor's, not this Worker's. Get the IP wrong and every event is silently
 * dropped (the API still answers 202), so it goes in both headers Plausible
 * reads: CF-Connecting-IP first, then X-Forwarded-For.
 *
 * The header policy (no cookies, no Referer, `host` pinned) is the same one the
 * PostHog proxy uses (server/routes/ph/[...path].ts), from `shared`.
 */
export default defineEventHandler((event) => {
  const incoming = getRequestHeaders(event);
  const clientIp = visitorIp(incoming, getRequestIP(event));

  const headers = proxyRequestHeaders(incoming, new URL(PLAUSIBLE_ORIGIN).host, clientIp);
  if (clientIp) headers["cf-connecting-ip"] = clientIp;

  return relayToUpstream(event, `${PLAUSIBLE_ORIGIN}/api/event`, headers);
});