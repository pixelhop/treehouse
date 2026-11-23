import { createError, getQuery, setResponseHeader } from "h3";
import { servedContentType } from "shared";
import { byteWorkerFor, handOff } from "../../../../utils/blob-worker";
import { useFileService } from "../../../../utils/files";
import {
  attachmentDisposition,
  fileEtag,
  keepInert,
  requestedRange,
  serveBlob,
  wantsDownload,
} from "../../../../utils/serve-blob";
import {
  assertInKeyFolder,
  fileRoute,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Read the bytes of a prior version. Query: ?path=<path>&version=<n>, plus
// `download=1` to save rather than view. Sibling
// route (the path travels as a query param) so it doesn't collide with the
// [...path] catch-all read route.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const q = getQuery(event);
  const path = typeof q.path === "string" ? q.path : "";
  const version = typeof q.version === "string" ? Number.parseInt(q.version, 10) : Number.NaN;
  if (!path || Number.isNaN(version)) {
    throw createError({ statusCode: 400, statusMessage: "path and version are required" });
  }
  assertInKeyFolder(access, path);

  const svc = useFileService();
  // Bytes from the Worker when it is configured and this client can follow
  // there (see blob-worker.ts), after the same gate `openVersion` applies.
  const byteWorker = byteWorkerFor(event);
  if (byteWorker) {
    const at = await svc.versionHash({ workspaceId: ws.id, path, version, viewer: access });
    if (at.status === "not_found")
      throw createError({ statusCode: 404, statusMessage: "Not found" });
    if (at.status === "version_not_found")
      throw createError({ statusCode: 404, statusMessage: "Version not available" });
    const handed = await handOff(event, byteWorker, svc, {
      workspaceId: ws.id,
      path,
      contentHash: at.contentHash,
      etag: fileEtag({ version, contentHash: at.contentHash }),
      meter: false,
      headers: (contentType) => ({
        "content-type": servedContentType(contentType, path),
        ...(wantsDownload(event) ? { "content-disposition": attachmentDisposition(path) } : {}),
      }),
    });
    if (handed) return;
  }

  // The ETag carries the content hash: a version number is reused after a
  // delete and recreate, so on its own it can't vouch for an If-Range resume.
  const res = await svc.openVersion({
    workspaceId: ws.id,
    path,
    version,
    viewer: access,
    rangeFor: (served) => requestedRange(event, fileEtag(served)),
  });
  if (res.status === "not_found")
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  if (res.status === "version_not_found")
    throw createError({ statusCode: 404, statusMessage: "Version not available" });
  if (res.status === "blob_missing")
    throw createError({ statusCode: 502, statusMessage: "Blob missing for version" });

  setResponseHeader(event, "ETag", fileEtag(res));
  keepInert(event);
  setResponseHeader(event, "Content-Type", servedContentType(res.blob.contentType, path));
  if (wantsDownload(event)) {
    setResponseHeader(event, "Content-Disposition", attachmentDisposition(path));
  }
  await serveBlob(event, res.blob);
});