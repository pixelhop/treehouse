// The forwarding half of this site's analytics proxies: PostHog at /ph
// (routes/ph/[...path].ts) and Plausible at /pv (routes/pv/). Which headers go
// upstream is decided in `shared` (proxyRequestHeaders); this moves the bytes.
import { type H3Event, readRawBody, setResponseHeader, setResponseStatus } from "h3";
import { isForwardableResponseHeader } from "shared";

/**
 * Send this request's body to `target` and hand the upstream's answer back,
 * status and headers included (minus the ones `shared` refuses to forward).
 *
 * The body is read and returned as raw bytes, never as text. posthog-js gzips
 * its event payloads; decoding to a string and re-encoding would corrupt them,
 * and the resulting 400s from the ingestion endpoint are opaque to debug.
 * `readRawBody(event, false)` yields a Node Buffer, whose backing store is typed
 * as ArrayBufferLike; fetch's BodyInit requires a Uint8Array over a real
 * ArrayBuffer. Copying into a fresh one satisfies that and costs nothing that
 * matters here: analytics payloads are kilobytes, not megabytes.
 */
export async function relayToUpstream(
  event: H3Event,
  target: string,
  headers: Record<string, string>,
): Promise<Uint8Array> {
  const raw =
    event.method === "GET" || event.method === "HEAD" ? undefined : await readRawBody(event, false);
  const body = raw ? new Uint8Array(raw) : undefined;

  const response = await fetch(target, { method: event.method, headers, body });

  for (const [key, value] of response.headers.entries()) {
    if (isForwardableResponseHeader(key)) setResponseHeader(event, key, value);
  }
  setResponseStatus(event, response.status);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The visitor's IP as Cloudflare reports it: CF-Connecting-IP, else the first
 * X-Forwarded-For hop, else whatever the runtime saw (`fallback`, which is the
 * only source under `nuxt dev`).
 */
export function visitorIp(
  headers: Record<string, string | undefined>,
  fallback?: string,
): string | undefined {
  const forwarded = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  return headers["cf-connecting-ip"] || forwarded || fallback;
}