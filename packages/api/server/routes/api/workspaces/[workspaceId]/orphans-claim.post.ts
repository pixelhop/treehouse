import { createError, readBody } from "h3";
import { claimOrphan } from "../../../../utils/acl";
import {
  actorFor,
  fileRoute,
  nodePathFrom,
  requireCookieWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Take over a restricted item no remaining member can reach. COOKIE SESSION,
// OWNERS ONLY. Makes the caller its only editor and records it in the activity
// feed: this is the one way past a restriction, so it is never a quiet one. The
// claim is re-checked in its transaction, so if a grantee has rejoined it fails
// rather than taking the item from them.
export default fileRoute(async (event) => {
  const { ctx, ws } = await requireCookieWorkspaceFromRoute(event);
  if (ws.access.role !== "owner") {
    throw createError({ statusCode: 403, statusMessage: "Only a workspace owner can claim" });
  }
  const path = nodePathFrom(await readBody<{ path?: unknown }>(event));
  const claimed = await claimOrphan({
    workspaceId: ws.id,
    organizationId: ws.organizationId,
    path,
    userId: ctx.userId,
    actor: actorFor(ctx, ws.access),
  });
  if (!claimed) throw createError({ statusCode: 404, statusMessage: "Nothing to claim there" });
  return { path, claimed: true };
});