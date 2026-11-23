import { createError, readBody } from "h3";
import { MAX_RECOVERY_ACTIONS } from "shared";
import { applyPlan } from "../../../../../utils/recovery";
import { planFromBody } from "../../../../../utils/recovery-request";
import {
  actorFor,
  fileRoute,
  requireWorkspaceFromRoute,
  requireWriter,
} from "../../../../../utils/workspace";

// Run a recovery. Same body as /recovery/preview. The plan is worked out again
// here rather than trusted from the client, and every change is checked against
// the version it was planned from, so nothing that moved on since is touched.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  requireWriter(access);
  const { plan, meta } = await planFromBody(ws.id, ctx, access, await readBody(event));
  if (plan.actions.length > MAX_RECOVERY_ACTIONS) {
    throw createError({
      statusCode: 413,
      statusMessage: `More than ${MAX_RECOVERY_ACTIONS} changes; restore one folder at a time`,
    });
  }
  return applyPlan({ workspaceId: ws.id, plan, actor: actorFor(ctx, access), meta });
});