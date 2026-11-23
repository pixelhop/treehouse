import {
  defineEventHandler,
  getRequestHeaders,
  getRequestIP,
  getRequestURL,
  readRawBody,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import {
  POSTHOG_API_HOST,
  POSTHOG_ASSET_HOST,
  isForwardableResponseHeader,
  posthogUpstreamUrl,
  proxyRequestHeaders,
} from "shared";

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
export default defineEventHandler(async (event) => {
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

  // Read the body as raw bytes, never as text. posthog-js gzips its event
  // payloads; decoding to a string and re-encoding would corrupt them, and the
  // resulting 400s from the ingestion endpoint are opaque to debug.
  // `readRawBody(event, false)` yields a Node Buffer, whose backing store is
  // typed as ArrayBufferLike; fetch's BodyInit requires a Uint8Array over a real
  // ArrayBuffer. Copying into a fresh one satisfies that and costs nothing that
  // matters here — PostHog event payloads are kilobytes, not megabytes.
  const raw =
    event.method === "GET" || event.method === "HEAD" ? undefined : await readRawBody(event, false);
  const body = raw ? new Uint8Array(raw) : undefined;

  const response = await fetch(target, { method: event.method, headers, body });

  for (const [key, value] of response.headers.entries()) {
    if (isForwardableResponseHeader(key)) setResponseHeader(event, key, value);
  }
  setResponseStatus(event, response.status);

  // Hand back the bytes untouched, for the same reason we read them untouched.
  return new Uint8Array(await response.arrayBuffer());
});