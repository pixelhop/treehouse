import { createError, getHeader, getRouterParam, type H3Event, setResponseStatus } from "h3";
import { useFileService } from "../../../../../utils/files";
import {
  actorFor,
  fileRoute,
  readOnlyError,
  requireWorkspaceFromRoute,
} from "../../../../../utils/workspace";

/** The version the delete was based on, from If-Match. */
function baseVersionFrom(event: H3Event): number {
  const ifMatch = getHeader(event, "if-match");
  if (!ifMatch)
    throw createError({ statusCode: 428, statusMessage: "If-Match required for delete" });
  const baseVersion = Number.parseInt(ifMatch.replace(/"/g, ""), 10);
  if (Number.isNaN(baseVersion))
    throw createError({ statusCode: 400, statusMessage: "Invalid If-Match" });
  return baseVersion;
}

// Delete a file. Requires If-Match (the base version). A stale delete loses to
// a concurrent edit (resurrection over loss) and returns 412.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const path = getRouterParam(event, "path") ?? "";
  const baseVersion = baseVersionFrom(event);

  const result = await useFileService().remove({
    workspaceId: ws.id,
    path,
    baseVersion,
    actor: actorFor(ctx, access),
  });
  if (result.status === "not_found")
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  if (result.status === "denied") throw readOnlyError(result.denial);
  if (result.status === "conflict") {
    setResponseStatus(event, 412);
    return { error: "version_conflict", current_version: result.currentVersion };
  }
  setResponseStatus(event, 204);
  return "";
});