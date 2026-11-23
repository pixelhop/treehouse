import {
  createError,
  getRequestHeader,
  getRouterParam,
  sendNoContent,
  setResponseHeader,
} from "h3";
import { servedContentType } from "shared";
import { byteWorkerFor, handOff } from "../../../../../utils/blob-worker";
import { useFileService } from "../../../../../utils/files";
import {
  attachmentDisposition,
  fileEtag,
  keepInert,
  requestedRange,
  serveBlob,
  wantsDownload,
} from "../../../../../utils/serve-blob";
import {
  assertInKeyFolder,
  fileRoute,
  requireWorkspaceFromRoute,
} from "../../../../../utils/workspace";

const REVALIDATE = "private, max-age=0, must-revalidate";

// Read a single file's bytes. Returns ETag (the version) so clients can do
// optimistic-concurrency writes. 404 unknown path, 502 if the blob is missing.
// Streams, and honours a single `Range` (206/416), which media seeking and
// resumed downloads rely on.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const path = getRouterParam(event, "path") ?? "";
  assertInKeyFolder(access, path);
  const svc = useFileService();

  // Resolve the version first and answer a conditional request before touching
  // the blob store. This route serves every image in the file browser and every
  // embed in a rendered markdown document, so a document with twenty images
  // otherwise costs twenty blob fetches AND twenty decryptions per render.
  // `stat` applies the same private-node gate as `read`, so an unauthorized
  // path still resolves to 404 here rather than leaking existence via a 304.
  const stat = await svc.stat(ws.id, path, access);
  if (!stat) throw createError({ statusCode: 404, statusMessage: "Not found" });
  const etag = fileEtag(stat);
  setResponseHeader(event, "ETag", etag);
  // `?download=1` asks for a save rather than a view (see wantsDownload). Set
  // before the 304 return below: `?download=1` is its own cache entry, and a
  // revalidation must carry the same disposition.
  const disposition = wantsDownload(event) ? attachmentDisposition(path) : null;
  if (disposition) setResponseHeader(event, "Content-Disposition", disposition);
  // Always revalidate: a stale cached copy of a file that has since been made
  // private, or whose workspace membership has been revoked, must not be
  // served from the browser cache. The saving here is the blob read, not the
  // request.
  setResponseHeader(event, "Cache-Control", REVALIDATE);
  if (getRequestHeader(event, "if-none-match") === etag) return sendNoContent(event, 304);

  // Bytes from the Worker, when it is configured and this client can follow
  // there (see blob-worker.ts). Every rule above has already run; the Worker
  // only moves bytes. The grant names the bytes `stat` resolved, which are
  // content-addressed, so its ETag and body can never disagree.
  const byteWorker = byteWorkerFor(event);
  if (byteWorker) {
    const handed = await handOff(event, byteWorker, svc, {
      workspaceId: ws.id,
      path,
      contentHash: stat.contentHash,
      expectedSize: stat.size,
      expectedType: stat.contentType,
      etag,
      meter: false,
      headers: (contentType) => ({
        "content-type": servedContentType(contentType, path),
        "cache-control": REVALIDATE,
        "x-treehouse-version": String(stat.version),
        "x-treehouse-content-hash": stat.contentHash,
        ...(disposition ? { "content-disposition": disposition } : {}),
      }),
    });
    if (handed) return;
  }

  // The range is chosen against the node actually opened, not `stat` above: a
  // write landing in between must turn an If-Range resume into the whole file.
  const res = await svc.open(ws.id, path, access, (served) =>
    requestedRange(event, fileEtag(served)),
  );
  if (res.status === "not_found")
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  if (res.status === "blob_missing") {
    throw createError({ statusCode: 502, statusMessage: "Blob missing for file metadata" });
  }
  setResponseHeader(event, "ETag", fileEtag(res));
  // The same version under a name no proxy claims ownership of. ETag is CDN
  // territory: a compressing/transforming edge may weaken it to W/"n" or drop it
  // outright (Cloudflare in front of this API strips it entirely), and a client
  // that can only learn the version from the ETag then can't read a single file —
  // every pull fails and the folder never syncs. Clients prefer this header and
  // keep the ETag fallback for older servers.
  setResponseHeader(event, "X-Treehouse-Version", String(res.version));
  // The identity of the bytes in THIS response. A version number is reused when
  // a path is deleted and recreated, so a client that must name what it was
  // actually shown — before pinning a public link to it, say — cannot do that
  // with a version alone.
  setResponseHeader(event, "X-Treehouse-Content-Hash", res.contentHash);
  keepInert(event);
  setResponseHeader(event, "Content-Type", servedContentType(res.blob.contentType, path));
  await serveBlob(event, res.blob);
});