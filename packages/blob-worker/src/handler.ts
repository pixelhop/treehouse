import {
  type EncryptedLayout,
  type FrameSpan,
  frameSpan,
  openFrames,
  sealedLayout,
} from "blob-io/blob-crypto";
import { type BlobGrant, grantKeyRing, openGrant, sealUsageReport } from "blob-io/blob-grant";
import { type ByteRange, conditionalRange, contentRange, resolveRange } from "blob-io/byte-range";
import { primed, sliceStream } from "blob-io/byte-stream";
import type { KeyRing } from "blob-io/key-ring";
import { meteredBody } from "./body";
import type { Env, ExecutionContextLike } from "./env";

// ---------------------------------------------------------------------------
// GET/HEAD /b/<grant>: the bytes of one blob, exactly as the API would serve
// them, decrypted here under the per-blob key the grant carries.
//
// The API has already authorised the read; this Worker only moves bytes. It
// holds no KEK and no workspace DEK, so the most a leaked grant opens is the
// one blob it names, until it expires. Ranges decrypt only the chunks that
// cover them, and every chunk is authenticated before any of its bytes are
// sent, so the 128 MB memory cap holds whatever the file size.
//
// Fails closed: an expired, forged, tampered or wrong-key grant gets a bare
// 403, and a blob that will not authenticate gets a bare 502. Neither says why.
// ---------------------------------------------------------------------------

/** Base64url plus the dot between the key id and the sealed body. */
const GRANT_PATH = /^\/b\/([A-Za-z0-9_.-]+)$/;

// Mirrors the API's CORS (packages/api/server/middleware/cors.ts): the same
// request headers allowed and the same response headers exposed, so a script
// reading the bytes here learns the same things it would from the API.
const ALLOW_HEADERS =
  "Content-Type, Authorization, If-Match, If-None-Match, Range, If-Range, x-api-key";
const EXPOSE_HEADERS =
  "ETag, X-Treehouse-Version, X-Treehouse-Content-Hash, Content-Range, Accept-Ranges";

export interface HandlerOptions {
  /** Milliseconds since the epoch. A seam for the tests. */
  now?: () => number;
  /** Used to report share-link bytes. A seam for the tests. */
  fetch?: typeof fetch;
}

/**
 * CORS for any origin, credentials included. The API keeps an allowlist
 * because its responses depend on a cookie; nothing here does. The grant in
 * the URL is the only credential, and whoever holds it can read the bytes with
 * curl anyway. It also has to be this open: a credentialed request the API
 * redirects here arrives with `Origin: null` (the Fetch spec taints the origin
 * across a cross-origin redirect), which no allowlist could name.
 */
function corsHeaders(request: Request): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("origin");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  }
  return headers;
}

/** A response that says nothing beyond its status. */
function bare(request: Request, status: number, extra: Record<string, string> = {}): Response {
  const headers = harden(corsHeaders(request));
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(null, { status, headers });
}

function preflight(request: Request): Response {
  const headers = corsHeaders(request);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
  return new Response(null, { status: 204, headers });
}

let ringCache: { active?: string; retired?: string; ring: KeyRing | null } | undefined;

/** The grant key ring, parsed once per isolate. Null when unset or malformed. */
function ringOf(env: Env): KeyRing | null {
  const active = env.BLOB_WORKER_TOKEN_KEY;
  const retired = env.BLOB_WORKER_TOKEN_KEY_RETIRED;
  if (ringCache && ringCache.active === active && ringCache.retired === retired) {
    return ringCache.ring;
  }
  let ring: KeyRing | null = null;
  try {
    ring = grantKeyRing(active, retired);
  } catch (err) {
    console.error("[blob-worker] BLOB_WORKER_TOKEN_KEY is malformed", err);
  }
  ringCache = { active, retired, ring };
  return ring;
}

export async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  opts: HandlerOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return bare(request, 405, { Allow: "GET, HEAD, OPTIONS" });
  }
  // Before the grant is even looked at: no grant, however valid, may be run as
  // a worker on this origin (see isWorkerScriptFetch).
  if (isWorkerScriptFetch(request)) return bare(request, 403);
  const match = GRANT_PATH.exec(new URL(request.url).pathname);
  if (!match) return bare(request, 404);
  const ring = ringOf(env);
  if (!ring) return bare(request, 503);
  const now = opts.now ?? Date.now;
  const grant = openGrant(ring, match[1]!, Math.floor(now() / 1000));
  if (!grant) return bare(request, 403);
  try {
    return await serve(request, env, grant, () => meter(env, ctx, ring, grant, opts));
  } catch (err) {
    console.error("[blob-worker] failed to serve a grant", err);
    return bare(request, 502);
  }
}

/**
 * A browser fetching a grant URL to run it as a service worker (or a shared or
 * dedicated worker). Every grant is served from this one origin, whichever
 * workspace it belongs to. A service worker registered here from an uploaded
 * script would control the whole origin's grant URLs, intercepting other
 * workspaces' later downloads and outliving the grant that installed it. So a
 * worker script is never served, whatever the grant. Browsers mark the fetch
 * with `Service-Worker: script` and a worker Sec-Fetch-Dest.
 */
function isWorkerScriptFetch(request: Request): boolean {
  if (request.headers.has("service-worker")) return true;
  const dest = request.headers.get("sec-fetch-dest");
  return dest === "serviceworker" || dest === "sharedworker" || dest === "worker";
}

/**
 * Keep uploaded content inert on this origin. `sandbox` (with no
 * allow-same-origin) gives any document served here an opaque origin and no
 * scripts, so an uploaded HTML page can neither register a service worker nor
 * touch this origin's storage, and it is sent as a policy of its own so it
 * holds whatever policy a grant also carries (share links send a stricter one).
 * Images, video and downloads are unaffected: a CSP on those responses is not
 * applied. nosniff keeps a browser from treating bytes as a type they were not
 * served as. The defence does not depend on the Worker's domain, because every
 * grant shares the one origin.
 */
function harden(headers: Headers): Headers {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.append("Content-Security-Policy", "sandbox");
  return headers;
}

/** The headers every answer for this grant carries. */
function grantHeaders(request: Request, grant: BlobGrant): Headers {
  const headers = corsHeaders(request);
  for (const [name, value] of Object.entries(grant.headers)) headers.set(name, value);
  harden(headers);
  if (grant.etag) headers.set("ETag", grant.etag);
  headers.set("Accept-Ranges", "bytes");
  // The grant is in this URL. A served page (an inline PDF, say) must never
  // pass it on in a Referer to whatever it links to.
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

async function serve(
  request: Request,
  env: Env,
  grant: BlobGrant,
  startMeter: () => (sent: number) => void,
): Promise<Response> {
  const headers = grantHeaders(request, grant);
  if (isCurrent(request, grant)) return new Response(null, { status: 304, headers });
  const layout = sealedLayout(grant.header, grant.size);
  if (!layout) return bare(request, 502);

  const range = requestedRange(request, grant);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", contentRange(null, grant.size));
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  setLength(headers, range, grant.size);
  const reply = { status: range ? 206 : 200, headers };
  if (request.method === "HEAD") return headResponse(request, env, grant, reply);
  const body = await decryptedBody(env, grant, layout, frameSpan(layout, range));
  if (typeof body === "number") return bare(request, body);
  return new Response(meteredBody(body.stream, body.length, startMeter()), reply);
}

/** Whether the client already holds these bytes (If-None-Match). */
function isCurrent(request: Request, grant: BlobGrant): boolean {
  return !!grant.etag && request.headers.get("if-none-match") === grant.etag;
}

/** The byte range to serve: null for the whole blob, as the API decides it. */
function requestedRange(request: Request, grant: BlobGrant): ByteRange | "unsatisfiable" | null {
  const asked = conditionalRange(
    request.headers.get("range"),
    request.headers.get("if-range"),
    grant.etag,
  );
  return asked ? resolveRange(asked, grant.size) : null;
}

/** HEAD: the headers a GET would send, once the object is known to exist. */
async function headResponse(
  request: Request,
  env: Env,
  grant: BlobGrant,
  reply: ResponseInit,
): Promise<Response> {
  const exists = await env.BLOBS.head(`${grant.workspaceId}/${grant.contentHash}`);
  return exists ? new Response(null, reply) : bare(request, 404);
}

/**
 * The plaintext of one span, read from R2 and decrypted, with its first chunk
 * already authenticated, so a blob that will not open gets an error status
 * rather than a 200 that stops after the headers. A number is that status.
 */
async function decryptedBody(
  env: Env,
  grant: BlobGrant,
  layout: EncryptedLayout,
  span: FrameSpan,
): Promise<{ stream: AsyncIterable<Uint8Array>; length: number } | number> {
  const key = `${grant.workspaceId}/${grant.contentHash}`;
  const object = await env.BLOBS.get(key, {
    range: { offset: span.storedStart, length: span.storedEnd - span.storedStart + 1 },
  });
  if (!object) return 404;
  if (object.size !== layout.storedSize) {
    // Replaced since the grant was issued. A re-seal of the same bytes keeps
    // the size but changes the salt, and fails authentication below instead.
    await object.body.cancel().catch(() => {});
    return 502;
  }
  const frames = chunksOf(object.body);
  const plain = sliceStream(
    openFrames(grant.header, layout, span.first, span.last, frames, grant.key),
    span.skip,
    span.take,
  );
  try {
    return { stream: await primed(plain), length: span.take };
  } catch (err) {
    console.error(`[blob-worker] blob ${key} failed authentication`, err);
    return 502;
  }
}

function setLength(headers: Headers, range: ByteRange | null, size: number): void {
  if (range) {
    headers.set("Content-Range", contentRange(range, size));
    headers.set("Content-Length", String(range.end - range.start + 1));
  } else {
    headers.set("Content-Length", String(size));
  }
}

/** A ReadableStream body as the byte stream blob-io reads, cancelled if left early. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
  }
}

/**
 * For a metered grant (a public share link), report the bytes sent once the
 * body is finished, however it finished. `waitUntil` keeps the Worker alive for
 * the report after the response has gone. A failed report is logged and lost:
 * the ceiling is an abuse backstop, and serving must never wait on it.
 */
function meter(
  env: Env,
  ctx: ExecutionContextLike,
  ring: KeyRing,
  grant: BlobGrant,
  opts: HandlerOptions,
): (sent: number) => void {
  const url = env.USAGE_REPORT_URL;
  if (!grant.meter || !url) return () => {};
  let settle: (sent: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const send = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  ctx.waitUntil(
    finished.then(async (bytes) => {
      if (bytes <= 0) return;
      const body = sealUsageReport(ring, {
        workspaceId: grant.workspaceId,
        bytes,
        at: Math.floor(now() / 1000),
      });
      try {
        const res = await send(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        });
        if (!res.ok) console.error(`[blob-worker] usage report refused: ${res.status}`);
      } catch (err) {
        console.error("[blob-worker] usage report failed", err);
      }
    }),
  );
  return settle;
}