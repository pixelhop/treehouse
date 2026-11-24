import { createError, defineEventHandler, setResponseHeader } from "h3";
import { PLAUSIBLE_ORIGIN, isPlausibleScriptId } from "../../../app/utils/plausible";

/**
 * /pv/script.js — Plausible's tracking script, served from our own origin.
 *
 * Only ever fetches the one configured site script: the id comes from runtime
 * config, never from the request, so this is not an open proxy to plausible.io.
 * See plugins/plausible.client.ts for why the script is proxied at all.
 */
export default defineEventHandler(async (event) => {
  const { scriptId } = useRuntimeConfig(event).public.plausible as { scriptId: string };
  if (!isPlausibleScriptId(scriptId)) throw createError({ statusCode: 404 });

  const response = await fetch(`${PLAUSIBLE_ORIGIN}/js/${scriptId}.js`);
  if (!response.ok) throw createError({ statusCode: 502 });

  setResponseHeader(event, "content-type", "application/javascript; charset=utf-8");
  // Plausible ships config changes (outbound links, file downloads...) in this
  // file, so keep it short-lived; an hour is plenty to spare the upstream.
  setResponseHeader(event, "cache-control", "public, max-age=3600");
  return await response.text();
});