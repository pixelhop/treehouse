import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type H3Event, getQuery, getRequestHeader, setResponseHeader, setResponseStatus } from "h3";
import { conditionalRange, contentRange, type RangeRequest } from "blob-io/byte-range";
import type { OpenedBlob } from "./storage";

/**
 * The ETag for a file's bytes: its version, then its content hash. The version
 * leads so clients that read the version from an ETag (older CLIs and the app,
 * as a fallback) still parse it. The hash is what makes it a sound validator:
 * a version number is reused when a path is deleted and recreated, so an
 * If-Range built on the number alone could splice two different files together.
 */
export function fileEtag(served: { version: number; contentHash: string }): string {
  return `"${served.version}-${served.contentHash}"`;
}

/**
 * Keep an uploaded file inert on the API's origin, as the byte Worker keeps it
 * on its own (see `harden` in packages/blob-worker). The API serves member
 * files on the origin its session cookie belongs to, so an uploaded HTML page
 * opened from its raw URL would otherwise run with that session: `sandbox`
 * (no allow-same-origin) gives it an opaque origin and no scripts. nosniff
 * keeps a browser from treating bytes as a type they were not served as.
 * Images, media and downloads are unaffected, and the app renders HTML from
 * the text into a sandbox of its own, not from this URL.
 */
export function keepInert(event: H3Event): void {
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
  setResponseHeader(event, "Content-Security-Policy", "sandbox");
}

/**
 * Whether the request asks for a save rather than a view. The app and API sit
 * on different origins, and an anchor's `download` attribute is ignored
 * cross-origin, so the server saying `attachment` is the only signal browsers
 * honour everywhere. Exactly "1", nothing looser: `?download=0` stays a view.
 */
export function wantsDownload(event: H3Event): boolean {
  return getQuery(event).download === "1";
}

/**
 * A `Content-Disposition: attachment` value naming the file at `path` by its
 * last segment. The ASCII `filename` is the legacy fallback; `filename*`
 * carries the real name.
 */
export function attachmentDisposition(path: string): string {
  // `||`, not `??`: a trailing slash or empty path yields "", which would make
  // an empty filename.
  const name = path.split("/").pop() || "file";
  const ascii = name.replaceAll(/[^ -~]/g, "_").replaceAll('"', "'");
  // encodeURIComponent leaves ' ( ) * literal, but they are not RFC 5987
  // attr-chars — a strict client rejects the UTF-8 name over any of them and
  // falls back to the lossy ASCII one. Percent-encode the stragglers.
  const utf8 = encodeURIComponent(name).replaceAll(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * The byte range a request asks for, if any. `If-Range` makes the range
 * conditional on the file not having changed: when it names a different
 * version than `etag`, the client's partial copy is stale and it gets the whole
 * file instead (RFC 9110 §13.1.5).
 */
export function requestedRange(event: H3Event, etag: string | null): RangeRequest | undefined {
  return conditionalRange(
    getRequestHeader(event, "range"),
    getRequestHeader(event, "if-range"),
    etag,
  );
}

/**
 * Answer with a blob opened by the file service: 200 for the whole file, 206
 * for a range, 416 for a range past the end. The body streams, so memory stays
 * flat whatever the file size. Content-Type and any caller-specific headers
 * must be set before calling. Resolves to the number of body bytes actually
 * sent, which is less than planned when the client leaves early or the stream
 * fails part way: that is what metered usage should be charged.
 */
export async function serveBlob(event: H3Event, blob: OpenedBlob): Promise<number> {
  setResponseHeader(event, "Accept-Ranges", "bytes");
  if (blob.range === "unsatisfiable") {
    setResponseStatus(event, 416);
    setResponseHeader(event, "Content-Range", contentRange(null, blob.size));
    setResponseHeader(event, "Content-Length", 0);
    blob.close?.();
    event.node.res.end();
    return 0;
  }
  if (blob.range) {
    setResponseStatus(event, 206);
    setResponseHeader(event, "Content-Range", contentRange(blob.range, blob.size));
    setResponseHeader(event, "Content-Length", blob.range.end - blob.range.start + 1);
  } else {
    setResponseHeader(event, "Content-Length", blob.size);
  }
  let sent = 0;
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const piece of blob.body) {
      yield piece;
      sent += piece.byteLength;
    }
  }
  try {
    await sendBody(event, counted());
  } finally {
    // Always, read or not: see OpenedBlob.close.
    blob.close?.();
  }
  return sent;
}

/**
 * Stream a body to the client with `pipeline`, which (unlike h3's sendStream)
 * destroys the source when the client disconnects and the response when the
 * source fails — so a reader leaving half way through a 2 GB download releases
 * its storage connection, and a chunk that fails authentication part way
 * through cuts the response off instead of leaving it hanging.
 */
async function sendBody(event: H3Event, body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await pipeline(Readable.from(body), event.node.res);
  } catch (err) {
    // Nothing sent yet: an error response can still be written, so let the
    // route's error handling answer (a decrypt failure on the first chunk).
    if (!event.node.res.headersSent) throw err;
    // The client went away. Routine for media seeking and cancelled downloads.
    if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") return;
    // Mid-stream failure: the response has already been cut off, which the
    // client sees as a truncated transfer. The storage layer logged the cause.
    console.error("[serve-blob] response aborted part way through", err);
  }
}