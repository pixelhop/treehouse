import { createError, getRouterParam } from "h3";
import {
  assertInKeyFolder,
  fileRoute,
  requireWorkspaceFromRoute,
  requireWriter,
} from "../../../../../utils/workspace";
import { getShare, revokeShare } from "../../../../../utils/shares";

// Revoke a share (soft delete). Scoped to the workspace so a key/cookie can only
// revoke shares in workspaces it can access.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  requireWriter(access);
  const shareId = getRouterParam(event, "shareId");
  if (!shareId) throw createError({ statusCode: 400, statusMessage: "Missing shareId" });
  const share = await getShare(ws.id, shareId);
  if (share) assertInKeyFolder(access, share.path);
  const revoked = await revokeShare(ws.id, shareId);
  if (!revoked) throw createError({ statusCode: 404, statusMessage: "Share not found" });
  return { ok: true };
});