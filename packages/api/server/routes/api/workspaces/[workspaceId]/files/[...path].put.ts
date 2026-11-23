import { createError, getHeader, getRouterParam, setResponseHeader, setResponseStatus } from "h3";
import { spoolBodyCapped } from "../../../../../utils/body";
import { useFileService } from "../../../../../utils/files";
import { limitsForWorkspace } from "../../../../../utils/quota";
import {
  actorFor,
  assertWritable,
  fileRoute,
  readOnlyError,
  requireWorkspaceFromRoute,
} from "../../../../../utils/workspace";

// 413 with the byte ceiling, so the CLI/MCP can report the limit. Thrown from the
// mid-stream reader and the Content-Length precheck alike.
function tooLarge(limit: number) {
  return createError({
    statusCode: 413,
    statusMessage: "Payload Too Large",
    data: { error: "file_too_large", limit_bytes: limit },
  });
}

// Write a file with optimistic concurrency:
//   If-None-Match: *  -> create-only
//   If-Match: "<n>"   -> compare-and-swap against version n
//   (neither)         -> 428 if the path exists, create if it doesn't
// On a stale write the server keeps a conflicted copy and returns 412.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const path = getRouterParam(event, "path") ?? "";
  const svc = useFileService();
  // The workspace's plan ceiling, not the instance-wide one, so an oversized
  // upload aborts mid-stream at the limit the caller is actually held to.
  const limit = (await limitsForWorkspace(ws.id)).maxFileBytes;

  // Reject an oversized upload before reading a byte when the client declares its
  // size; the capped read below is the backstop for chunked/undeclared bodies.
  const declared = getHeader(event, "content-length");
  if (declared) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > limit) throw tooLarge(limit);
  }

  // Preconditions first: they don't depend on the body, so a write that can
  // only fail is refused before a large upload is read and spooled. Access
  // leads, so a read-only sync client doesn't push a whole file to be told no.
  // The service re-checks: this is the early answer, not the enforcement.
  await assertWritable(ws.id, access, path);
  const contentType = getHeader(event, "content-type");
  const ifMatch = getHeader(event, "if-match");
  const ifNoneMatch = getHeader(event, "if-none-match");

  let baseVersion: number | undefined;
  let creating = false;
  if (ifNoneMatch === "*") {
    creating = true;
  } else if (ifMatch) {
    baseVersion = Number.parseInt(ifMatch.replace(/"/g, ""), 10);
    if (Number.isNaN(baseVersion)) {
      throw createError({ statusCode: 400, statusMessage: "Invalid If-Match" });
    }
  } else {
    const existing = await svc.stat(ws.id, path, access);
    if (existing) {
      throw createError({ statusCode: 428, statusMessage: "If-Match required for existing file" });
    }
    creating = true;
  }

  // Spooled rather than buffered: memory stays flat however large the file,
  // and the hash the blob is keyed by is computed on the way in.
  const body = await spoolBodyCapped(event, limit, tooLarge);
  let result: Awaited<ReturnType<typeof svc.write>>;
  try {
    // Reject an absent body: a truncated/aborted upload must not silently commit
    // a 0-byte file that then overwrites real content when clients pull it back.
    if (body.size === 0) {
      throw createError({ statusCode: 400, statusMessage: "Empty request body" });
    }
    result = await svc.write({
      workspaceId: ws.id,
      path,
      body,
      contentType,
      baseVersion: creating ? undefined : baseVersion,
      actor: actorFor(ctx, access),
      nowIso: new Date().toISOString(),
    });
  } finally {
    await body.dispose();
  }

  // Limit rejections are also `!ok` — they MUST be checked before the version
  // conflict branch below, which would otherwise mislabel them. Each carries a
  // distinct discriminator so the CLI, agents, and the UI can tell which limit
  // was hit and offer the right next step.
  if (result.quotaExceeded) {
    // 507 Insufficient Storage is the apt status for the byte limit.
    setResponseStatus(event, 507);
    return {
      error: "quota_exceeded",
      used_bytes: result.usage?.usedBytes ?? null,
      limit_bytes: result.usage?.limitBytes ?? null,
    };
  }

  if (result.readOnly) {
    setResponseStatus(event, 402);
    return { error: "workspace_read_only" };
  }

  if (result.fileCountExceeded) {
    // Also 507: the workspace is out of a storage resource, just a countable
    // one rather than bytes.
    setResponseStatus(event, 507);
    return {
      error: "file_count_exceeded",
      used_files: result.fileUsage?.usedFiles ?? null,
      limit_files: result.fileUsage?.limitFiles ?? null,
    };
  }

  // Reachable when the body arrived within the declared Content-Length but the
  // plan ceiling is lower than the stream cap that was applied.
  if (result.fileTooLarge) {
    throw tooLarge(result.sizeLimit?.limitBytes ?? limit);
  }

  // Writing to (or under) a restricted path the caller can't see is forbidden —
  // return 404 so the node is indistinguishable from a non-existent one.
  if (result.forbidden) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }

  // Visible but not writable (a viewer, or a view-only grant): 409 read_only.
  if (result.denied) throw readOnlyError(result.denied);

  if (!result.ok) {
    setResponseStatus(event, 412);
    return {
      error: "version_conflict",
      current_version: result.conflict?.currentVersion ?? null,
      conflict_copy_path: result.conflict?.conflictCopyPath,
    };
  }

  setResponseHeader(event, "ETag", `"${result.version}"`);
  setResponseStatus(event, creating ? 201 : 200);
  return { path, version: result.version };
});