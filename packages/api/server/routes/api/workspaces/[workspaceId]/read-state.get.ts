import { defineEventHandler } from "h3";
import { getReadState, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// The caller's last-seen position in this workspace's change feed, or null if
// they've never marked anything seen. Drives the activity feed's unread badge
// and "new since you were here" divider. `seq` is BigInt → serialized as a
// JS number (safe < 2^53), matching the changes route.
export default defineEventHandler(async (event) => {
  const { ctx, workspaceId } = await requireWorkspaceFromRoute(event);
  const lastSeenSeq = await getReadState(workspaceId, ctx.userId);
  return { lastSeenSeq: lastSeenSeq == null ? null : Number(lastSeenSeq) };
});