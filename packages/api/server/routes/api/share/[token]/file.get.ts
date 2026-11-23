import {
  createError,
  getQuery,
  getRequestHeader,
  type H3Event,
  sendNoContent,
  setResponseHeader,
  setResponseHeaders,
} from "h3";
import type { Share } from "db";
import { byteWorkerFor, handOff } from "../../../../utils/blob-worker";
import {
  attachmentDisposition,
  requestedRange,
  serveBlob,
  wantsDownload,
} from "../../../../utils/serve-blob";
import { baseContentType, isPlayableMediaType, servedContentType } from "shared";
import { effectiveAcl, listWorkspaceAcls } from "../../../../utils/acl";
import { useFileService } from "../../../../utils/files";
import { assertUnlocked, requirePublicShare } from "../../../../utils/public-share";
import { countShareBytes, countShareView } from "../../../../utils/share-usage";
import { isWithinShare } from "../../../../utils/shares";
import { fileRoute } from "../../../../utils/workspace";

// Bytes that are safe to render inline on this (cookie-holding) origin. Everything
// else — notably text/html and image/svg+xml, which can run script — is sent as a
// download so an unauthenticated public link can't execute same-origin script
// against the API session or host arbitrary pages on the API domain. The audio
// and video types the app plays are safe too: a browser only ever plays them.
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

const REVALIDATE = "private, max-age=0, must-revalidate";
const NO_STORE = "no-store";

// Lock down the response so a public link can never render as live content on the
// API origin: never sniff, never script, and only inline a safe media allowlist.
// The byte Worker sends the same set, so a link is just as inert on its origin.
// `path` names the bytes, so media synced as octet-stream is served as what it
// is (see servedContentType): under nosniff, nothing would play it otherwise.
// `?download=1` turns even a safe type into a download, which is what the
// viewer's Download button means when a video won't play in the page.
function shareHeaders(event: H3Event, storedType: string, path: string): Record<string, string> {
  const contentType = servedContentType(storedType, path);
  const inline =
    (INLINE_SAFE.has(baseContentType(contentType)) || isPlayableMediaType(contentType)) &&
    !wantsDownload(event);
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": inline ? "inline" : attachmentDisposition(path),
  };
}

function hardenShareResponse(event: H3Event, storedType: string, path: string) {
  setResponseHeaders(event, shareHeaders(event, storedType, path));
}

/**
 * A validator for the bytes this request would serve, derived WITHOUT reading
 * them. A pinned permalink is immutable, so its content pointer is the natural
 * validator; a live share tracks the node's version and content hash, which
 * costs one indexed lookup instead of a blob fetch plus a decryption.
 *
 * Null means "no validator" (the node is gone), which falls through to the
 * normal not-found handling below rather than caching anything.
 */
async function shareEtag(
  svc: ReturnType<typeof useFileService>,
  share: { kind: string; workspaceId: string; pinnedContentHash: string | null },
  requested: string,
): Promise<string | null> {
  if (share.kind === "file" && share.pinnedContentHash) return pinnedEtag(share.pinnedContentHash);
  const stat = await svc.stat(share.workspaceId, requested, "trusted");
  return stat ? liveEtag(stat) : null;
}

function pinnedEtag(contentHash: string): string {
  return `"p-${contentHash}"`;
}

/**
 * A live share's validator. The content hash rides along because a version
 * number is reused after a delete and recreate, and an If-Range resume must
 * never splice one file's bytes onto another's.
 */
function liveEtag(served: { version: number; contentHash: string }): string {
  return `"v-${served.version}-${served.contentHash}"`;
}

/**
 * The bytes a share read names: a pinned permalink's content pointer, or the
 * live node's current content. Null when the node is gone.
 */
async function shareTarget(
  svc: ReturnType<typeof useFileService>,
  share: Share,
  requested: string,
): Promise<{ contentHash: string; size?: number; contentType?: string; etag: string } | null> {
  if (share.kind === "file" && share.pinnedContentHash) {
    const contentHash = share.pinnedContentHash;
    return { contentHash, etag: pinnedEtag(contentHash) };
  }
  const node = await svc.stat(share.workspaceId, requested, "trusted");
  return (
    node && {
      contentHash: node.contentHash,
      size: node.size,
      contentType: node.contentType,
      etag: liveEtag(node),
    }
  );
}

/**
 * Send this read to the byte Worker when it is on and the client can follow
 * (see blob-worker.ts). Runs after every gate in the handler. The Worker sends
 * the same hardened headers and cache policy a direct answer would, and
 * reports the bytes it actually sent, so the link's byte ceiling keeps
 * counting. False leaves the request to the direct path below, which also
 * gives the not-found and no-longer-available answers.
 */
async function handShareOff(
  event: H3Event,
  svc: ReturnType<typeof useFileService>,
  share: Share,
  requested: string,
): Promise<boolean> {
  const worker = byteWorkerFor(event);
  if (!worker) return false;
  const target = await shareTarget(svc, share, requested);
  if (!target) return false;
  return handOff(event, worker, svc, {
    workspaceId: share.workspaceId,
    path: requested,
    contentHash: target.contentHash,
    expectedSize: target.size,
    expectedType: target.contentType,
    // A password-gated share carries no validator and is never stored.
    etag: share.passwordHash ? null : target.etag,
    meter: true,
    headers: (contentType) => ({
      ...shareHeaders(event, contentType, requested),
      "Cache-Control": share.passwordHash ? NO_STORE : REVALIDATE,
    }),
  });
}

/**
 * Conditional request: set the cache policy and validator, and say whether
 * the visitor's copy is current (a 304). This runs AFTER share re-resolution,
 * the unlock gate, the subtree check, and the privacy re-check — and must stay
 * there. Every one of those is what makes revocation beat a live cookie;
 * short-circuiting above them would let a revoked or newly-private link keep
 * answering from a validator the visitor already holds.
 *
 * `private`, never `public`: a shared cache would serve a revoked link until
 * its TTL expired, and a public link is exactly the high-fanout case where a
 * CDN would hold it longest. `max-age=0, must-revalidate` keeps every view
 * reaching this handler — the saving is the blob fetch and decryption, not
 * the request.
 */
async function conditional(
  event: H3Event,
  svc: ReturnType<typeof useFileService>,
  share: Share,
  requested: string,
): Promise<{ etag: string | null; notModified: boolean }> {
  if (share.passwordHash) {
    // A password-gated share is content someone deliberately put behind a
    // secret. `must-revalidate` would still let the browser write the body to
    // disk, so it survives on a shared machine after the tab is closed. Give up
    // the 304 saving here and store nothing.
    setResponseHeader(event, "Cache-Control", NO_STORE);
    return { etag: null, notModified: false };
  }
  const etag = await shareEtag(svc, share, requested);
  if (!etag) return { etag: null, notModified: false };
  setResponseHeader(event, "ETag", etag);
  setResponseHeader(event, "Cache-Control", REVALIDATE);
  return { etag, notModified: getRequestHeader(event, "if-none-match") === etag };
}

// Serve a shared file's bytes read-only, without login. For a file share the
// target is the share path (pinned bytes when the share pins a version); for a
// folder share the target is a `?path=` within the shared subtree.
export default fileRoute(async (event) => {
  const { token, share } = await requirePublicShare(event);
  assertUnlocked(event, token, share);

  const q = getQuery(event);
  const requested =
    share.kind === "file" ? share.path : typeof q.path === "string" ? q.path : share.path;
  if (!isWithinShare(share, requested)) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  // A share never serves a node that has since been made private. New shares on
  // a private subtree are blocked at creation, but a share minted before the
  // node was privatized must also stop serving it (re-checked per request).
  if (effectiveAcl(await listWorkspaceAcls(share.workspaceId), requested)) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  // Counted only after the unlock gate, the subtree check, and the privacy
  // re-check above — every one of which can still refuse this request. Range
  // requests count too: a Range header proves nothing about an earlier view,
  // and views are de-duplicated per visitor per day, so a seeking video costs a
  // write but is never counted twice.
  await countShareView(event, share);

  const svc = useFileService();

  // After every gate above, and it must stay there (see `conditional`).
  const { etag, notModified } = await conditional(event, svc, share, requested);
  if (notModified) return sendNoContent(event, 304);

  if (await handShareOff(event, svc, share, requested)) return;

  // Pinned file permalink: serve the exact bytes by content pointer.
  if (share.kind === "file" && share.pinnedContentHash) {
    const range = requestedRange(event, etag);
    const res = await svc.openByHash(share.workspaceId, share.pinnedContentHash, range);
    if (res.status === "blob_missing") {
      throw createError({ statusCode: 410, statusMessage: "This version is no longer available" });
    }
    hardenShareResponse(event, res.blob.contentType, requested);
    // Charged for the bytes actually sent: a cancelled or cut-off download
    // must not count against the link's ceiling as if it had completed.
    await countShareBytes(share.workspaceId, await serveBlob(event, res.blob));
    return;
  }

  // The range is chosen against the node actually opened (see the file route).
  // A password-gated share sends no ETag, so it has none an If-Range could name.
  const res = await svc.open(share.workspaceId, requested, "trusted", (served) =>
    requestedRange(event, share.passwordHash ? null : liveEtag(served)),
  );
  if (res.status === "not_found")
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  if (res.status === "blob_missing") {
    throw createError({ statusCode: 502, statusMessage: "Blob missing" });
  }
  // The ETag set above came from an earlier lookup; this request may have
  // opened a newer version, and a range of it must not carry the old
  // validator or a client could combine it with a range of the old bytes.
  if (!share.passwordHash) setResponseHeader(event, "ETag", liveEtag(res));
  hardenShareResponse(event, res.blob.contentType, requested);
  await countShareBytes(share.workspaceId, await serveBlob(event, res.blob));
});