import { createError, readBody, setResponseStatus } from "h3";
import { useFileService } from "../../../../utils/files";
import {
  actorFor,
  fileRoute,
  readOnlyError,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Restore a prior version's bytes as a new head version. Body: { path, targetVersion }.
// Sibling route (not under the [...path] catch-all) so the action name isn't
// captured as part of the file path — mirrors move.post.ts.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{ path?: string; targetVersion?: number }>(event);
  if (!body?.path || typeof body.targetVersion !== "number") {
    throw createError({ statusCode: 400, statusMessage: "path and targetVersion are required" });
  }

  const result = await useFileService().restore({
    workspaceId: ws.id,
    path: body.path,
    targetVersion: body.targetVersion,
    actor: actorFor(ctx, access),
    nowIso: new Date().toISOString(),
  });

  if (result.status === "not_found")
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  if (result.status === "denied") throw readOnlyError(result.denial);
  if (result.status === "version_not_found")
    throw createError({ statusCode: 404, statusMessage: "Version not found or not restorable" });
  if (result.status === "blob_missing")
    throw createError({ statusCode: 502, statusMessage: "Blob missing for version" });
  if (result.status === "conflict") {
    // Sustained contention kept the restore as a conflicted copy (never clobbered).
    setResponseStatus(event, 409);
    return {
      error: "restore_conflicted",
      current_version: result.currentVersion,
      conflict_copy_path: result.conflictCopyPath,
    };
  }
  return { path: body.path, version: result.version, restoredFrom: result.restoredFrom };
});