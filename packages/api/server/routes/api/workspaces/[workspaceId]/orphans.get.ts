import { createError, defineEventHandler } from "h3";
import { listOrphans } from "../../../../utils/acl";
import { memberIdsOf } from "../../../../utils/members";
import { requireCookieWorkspaceFromRoute } from "../../../../utils/workspace";

// Restricted items no remaining member can reach, by name only. COOKIE SESSION,
// OWNERS ONLY: the one exception to owners having no view of a restricted node,
// and it stops at the name. See orphans-claim.post.ts for what they can do next.
export default defineEventHandler(async (event) => {
  const { ws } = await requireCookieWorkspaceFromRoute(event);
  if (ws.access.role !== "owner") {
    throw createError({ statusCode: 403, statusMessage: "Only a workspace owner can see this" });
  }
  return { orphans: await listOrphans(ws.id, await memberIdsOf(ws.organizationId)) };
});