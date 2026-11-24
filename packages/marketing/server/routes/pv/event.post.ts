import { createError, defineEventHandler, getRequestHeaders, getRequestIP } from "h3";
import { proxyRequestHeaders } from "shared";
import { PLAUSIBLE_ORIGIN, isPlausibleScriptId } from "../../../app/utils/plausible";
import { relayToUpstream, visitorIp } from "../../utils/proxy";

/**
 * /pv/event — Plausible's event endpoint, proxied.
 *
 * Plausible counts a visitor from their IP and user agent, so both must be the
 * visitor's, not this Worker's. Get the IP wrong and every event is silently
 * dropped (the API still answers 202), so it goes in both headers Plausible
 * reads: CF-Connecting-IP first, then X-Forwarded-For.
 *
 * The header policy (no cookies, `host` pinned) is the same one the PostHog
 * proxy uses (server/routes/ph/[...path].ts), from `shared`. Referer is put
 * back: that policy drops it because app URLs carry file paths, but here it is
 * a public marketing page, and Plausible asks for it to filter bots.
 */
export default defineEventHandler((event) => {
  const { scriptId } = useRuntimeConfig(event).public.plausible as { scriptId: string };
  if (!isPlausibleScriptId(scriptId)) throw createError({ statusCode: 404 });

  const incoming = getRequestHeaders(event);
  const clientIp = visitorIp(incoming, getRequestIP(event));

  const headers = proxyRequestHeaders(incoming, new URL(PLAUSIBLE_ORIGIN).host, clientIp);
  if (clientIp) headers["cf-connecting-ip"] = clientIp;
  if (incoming.referer) headers.referer = incoming.referer;

  return relayToUpstream(event, `${PLAUSIBLE_ORIGIN}/api/event`, headers);
});