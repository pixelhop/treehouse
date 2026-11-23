import { defineEventHandler } from "h3";
import { authenticate, authorizeWorkspace, currentWorkspaceForUser } from "../../utils/workspace";

// The caller's workspace. API keys resolve to their scoped workspace; cookie
// sessions resolve (and auto-create) the active org's workspace.
export default defineEventHandler(async (event) => {
  const ctx = await authenticate(event);
  const ws = ctx.keyWorkspaceId
    ? await authorizeWorkspace(ctx, ctx.keyWorkspaceId)
    : await currentWorkspaceForUser(ctx);
  return { id: ws.id, name: ws.name };
});