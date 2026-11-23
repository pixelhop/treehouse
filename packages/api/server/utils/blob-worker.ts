import {
  type BlobGrant,
  GrantTooLargeError,
  grantExpiry,
  grantKeyRing,
  mintGrant,
} from "blob-io/blob-grant";
import type { KeyRing } from "blob-io/key-ring";
import {
  getRequestHeader,
  type H3Event,
  removeResponseHeader,
  sendRedirect,
  setResponseHeader,
} from "h3";
import { isDesktopShellUserAgent, viewerKind } from "shared";
import type { FileService } from "./files";
import { storesInR2, useBlobStore } from "./storage";

// ---------------------------------------------------------------------------
// The byte Worker: file bytes served from Cloudflare instead of from here.
//
// Every byte this API streams leaves Railway as metered egress. A Worker
// reading R2 through a binding pays none. So for the routes that hand file
// bytes to clients, this API keeps every rule (authentication, the private-path
// gate, versions, share links and their limits, view counting) and then, rather
// than streaming, answers 307 to the Worker with a grant: an encrypted token
// carrying the one per-blob key that opens those bytes (see blob-io/blob-grant).
// The Worker never holds the KEK or a workspace DEK.
//
// On only when BLOB_WORKER_URL and a valid BLOB_WORKER_TOKEN_KEY are both set.
// Any other combination serves every byte from here, exactly as before, and
// never fails a request: self-hosters and local dev set neither, and a rollout
// or rollback passes through "key set, URL not" on purpose (the URL is the
// switch; see docs/solutions/developer-experience/blob-worker-byte-path.md).
// ---------------------------------------------------------------------------

export interface BlobWorkerConfig {
  /** The Worker's origin, without a trailing slash. */
  url: string;
  ring: KeyRing;
}

export interface BlobWorkerSettings {
  /** Where to redirect byte reads, or null to serve them here. */
  worker: BlobWorkerConfig | null;
  /**
   * The grant key ring, kept even with no URL: grants issued before the URL
   * was removed still report the bytes they send until they expire.
   */
  ring: KeyRing | null;
  /** Why a configuration that looks meant to be on is off, for the log. */
  problem: string | null;
}

/** The grant key ring, or why it could not be read. */
function ringFrom(env: NodeJS.ProcessEnv): { ring: KeyRing | null; problem: string | null } {
  try {
    return {
      ring: grantKeyRing(env.BLOB_WORKER_TOKEN_KEY, env.BLOB_WORKER_TOKEN_KEY_RETIRED),
      problem: null,
    };
  } catch (err) {
    return { ring: null, problem: (err as Error).message };
  }
}

/** Why `url` cannot be redirected to from this deployment, or null if it can. */
function urlProblem(url: string, env: NodeJS.ProcessEnv): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `BLOB_WORKER_URL is not a URL: ${JSON.stringify(url)}`;
  }
  if (env.NODE_ENV !== "production") return null;
  // Grants carry key material in the URL, so never over plain HTTP. And the
  // Worker reads R2 only, so with any other store every redirect would 404.
  if (parsed.protocol !== "https:") return "BLOB_WORKER_URL must be https";
  return inR2() ? null : "BLOB_WORKER_URL is set but blob storage is not R2 (set the R2_* vars)";
}

function inR2(): boolean {
  try {
    return storesInR2(useBlobStore());
  } catch {
    // A store that cannot even be resolved fails the read on its own; this
    // only has to not make things worse.
    return false;
  }
}

/**
 * Read the byte-Worker settings. Never throws: anything short of a complete,
 * valid configuration turns redirects off, and `problem` says why when the
 * configuration looks like an attempt to turn them on.
 */
export function resolveBlobWorker(env: NodeJS.ProcessEnv = process.env): BlobWorkerSettings {
  const url = env.BLOB_WORKER_URL?.trim().replace(/\/+$/, "");
  const { ring, problem } = ringFrom(env);
  if (!url) return { worker: null, ring, problem };
  if (!ring) {
    return {
      worker: null,
      ring,
      problem: problem ?? "BLOB_WORKER_URL is set but BLOB_WORKER_TOKEN_KEY is not",
    };
  }
  const bad = urlProblem(url, env);
  return bad
    ? { worker: null, ring, problem: bad }
    : { worker: { url, ring }, ring, problem: null };
}

let settings: BlobWorkerSettings | undefined;

/** Memoized `resolveBlobWorker`, logging once when a configuration is unusable. */
function useBlobWorkerSettings(): BlobWorkerSettings {
  if (!settings) {
    settings = resolveBlobWorker();
    if (settings.problem) {
      console.error(
        `[blob-worker] byte Worker is OFF, serving file bytes from the API: ${settings.problem}`,
      );
    }
  }
  return settings;
}

/** The Worker to redirect byte reads to, or null to serve them here. */
export function useBlobWorker(): BlobWorkerConfig | null {
  return useBlobWorkerSettings().worker;
}

/** The grant key ring, for opening usage reports; null when no key is set. */
export function useGrantRing(): KeyRing | null {
  return useBlobWorkerSettings().ring;
}

/** Test seam: force a config (or none); `undefined` re-reads the environment. */
export function setBlobWorkerForTesting(config: BlobWorkerConfig | null | undefined): void {
  settings =
    config === undefined
      ? undefined
      : { worker: config, ring: config?.ring ?? null, problem: null };
}

/** Opt-in for API clients that follow the redirect WITHOUT sending their key on. */
export const BYTE_REDIRECT_HEADER = "x-treehouse-byte-redirect";

/**
 * Whether this client can be sent to the Worker. Only clients known to cope:
 *
 *  - a browser loading the bytes as an image, a video, a download or a page
 *    (Sec-Fetch-Dest other than "empty"). The redirect carries no cookie
 *    across, and none is needed: the grant is the credential.
 *  - an API client that asks with `x-treehouse-byte-redirect: 1`, which
 *    promises to follow the redirect without its API key. Fetch forwards custom
 *    headers like `x-api-key` across a cross-origin redirect (it only strips
 *    Authorization), so a client that has not promised that is never sent.
 *
 * Everything else is served here as before: script reads (the app's `fetch`
 * of text and version headers, which a cross-origin redirect would complicate
 * for little saving), MCP (which reads in-process anyway), older CLIs, curl.
 */
export function wantsByteRedirect(event: H3Event): boolean {
  if (getRequestHeader(event, BYTE_REDIRECT_HEADER) === "1") return true;
  if (getRequestHeader(event, "x-api-key") || getRequestHeader(event, "authorization")) {
    return false;
  }
  const dest = getRequestHeader(event, "sec-fetch-dest");
  if (!dest || dest === "empty") return false;
  // The desktop shell lets its window navigate (main frame or iframe) only to
  // the app and API origins, and refuses a redirect anywhere else, so a
  // download or a file opened as a page would be blocked on the way to the
  // Worker. Its images and video (subresources) are not navigations and still
  // go to the Worker.
  // A spoofed user agent only gets the bytes served from here, as before.
  return !(NAVIGATIONS.has(dest) && isDesktopShellUserAgent(getRequestHeader(event, "user-agent")));
}

/** Sec-Fetch-Dest values for a document a frame navigates to. */
const NAVIGATIONS = new Set(["document", "iframe", "frame", "embed", "object"]);

/**
 * The Worker this request may be handed to, or null to serve it here. The
 * client is judged first, so a request that would never be redirected does not
 * even read the configuration.
 */
export function byteWorkerFor(event: H3Event): BlobWorkerConfig | null {
  return wantsByteRedirect(event) ? useBlobWorker() : null;
}

export interface Handoff {
  workspaceId: string;
  /** The path the bytes are served as: with the stored type, it says whether they are media. */
  path: string;
  contentHash: string;
  /** The plaintext size the metadata records, when the route knows it. */
  expectedSize?: number;
  /** The content type the metadata records, when the route knows it. */
  expectedType?: string;
  /** The validator the API would send; null for none (a password-gated share). */
  etag: string | null;
  /** The headers the API would send with these bytes, given their content type. */
  headers: (contentType: string) => Record<string, string>;
  /** Report the bytes sent back to the API (public share links). */
  meter: boolean;
}

/**
 * The grant, or null when it would be too long for the Worker to accept (a
 * very long file name, which a download's Content-Disposition carries twice).
 * Those few reads are served directly rather than redirected to a 403.
 */
function mintOrNull(config: BlobWorkerConfig, grant: BlobGrant): string | null {
  try {
    return mintGrant(config.ring, grant);
  } catch (err) {
    if (err instanceof GrantTooLargeError) return null;
    throw err;
  }
}

/**
 * Below this size, a file that is not video or audio is served by the API.
 *
 * A redirect costs the client one more round trip, and the Worker's own first
 * byte (its R2 read) takes about as long as the API serving a small file
 * whole: measured on staging, a small image took ~540 ms through the Worker
 * against ~256 ms from the API. That only pays off where the browser makes
 * many requests for one file (video and audio: every seek after the first
 * goes straight to the Worker), or where a single download is long enough
 * that the hop vanishes in it and taking it off the API matters.
 */
export const HANDOFF_MIN_BYTES = 32 * 1024 * 1024;

/**
 * Whether a file of this size, type and path should go to the Worker. Media
 * means what the app plays, judged as the app judges it (`viewerKind`): the
 * type, then the extension when the type alone says nothing, so an `.m4a`
 * uploaded as audio/x-m4a still counts.
 */
export function worthHandingOff(size: number, contentType: string, path: string): boolean {
  const kind = viewerKind(contentType, path);
  return kind === "video" || kind === "audio" || size >= HANDOFF_MIN_BYTES;
}

/**
 * Send this read to the Worker: a 307 to it with a grant for exactly these
 * bytes. Resolves false, having changed nothing, when the blob has to be
 * served here instead (not encrypted, legacy plaintext, or damaged).
 */
export async function handOff(
  event: H3Event,
  config: BlobWorkerConfig,
  svc: Pick<FileService, "sealedBlob">,
  h: Handoff,
): Promise<boolean> {
  // The decision uses the file's own type when the route knows it, because
  // that is what the app picks its viewer from, so only files it plays go to
  // the Worker. Then a small file that isn't media is served here before
  // anything is read from R2, so it pays no more than it did before the
  // Worker existed. (The blob's type can differ: identical bytes share one
  // blob, typed by their latest upload.) A version or pinned share knows only
  // the blob, so the blob's type decides there.
  if (
    h.expectedSize !== undefined &&
    h.expectedType !== undefined &&
    !worthHandingOff(h.expectedSize, h.expectedType, h.path)
  ) {
    return false;
  }
  const sealed = await svc.sealedBlob(h.workspaceId, h.contentHash, h.expectedSize);
  if (!sealed) return false;
  if (!worthHandingOff(sealed.size, h.expectedType ?? sealed.contentType, h.path)) return false;
  const headers = Object.fromEntries(
    Object.entries(h.headers(sealed.contentType)).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const token = mintOrNull(config, {
    workspaceId: h.workspaceId,
    contentHash: h.contentHash,
    size: sealed.size,
    header: sealed.header,
    key: sealed.key,
    etag: h.etag,
    headers,
    expiresAt: grantExpiry(Math.floor(Date.now() / 1000)),
    meter: h.meter,
  });
  if (!token) return false;
  // The redirect itself must never be cached: every read has to come back
  // here, so a revoked member or link stops getting new grants at once. The
  // validators the route set for a direct answer belong on the Worker's
  // response now, not on this one.
  for (const name of ["etag", "content-disposition", "content-type"]) {
    removeResponseHeader(event, name);
  }
  setResponseHeader(event, "Cache-Control", "no-store");
  // Marks this redirect as a byte-Worker handoff, the one redirect an API
  // client should follow with no credentials. Any other redirect (a proxy
  // sending clients to a canonical API URL) keeps the client's usual rules.
  setResponseHeader(event, "X-Treehouse-Byte-Handoff", "1");
  // 307, not 302: a HEAD stays a HEAD.
  await sendRedirect(event, `${config.url}/b/${token}`, 307);
  return true;
}