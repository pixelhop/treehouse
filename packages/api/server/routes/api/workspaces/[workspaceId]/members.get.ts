import { listWorkspaceMembers } from "../../../../utils/members";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// The workspace's members, for the members panel, for resolving a change
// event's actorId (a user id) to a display name + avatar in the activity
// timeline, and for the board's assignee picker. See utils/members.ts for what
// is (and deliberately isn't) returned.
export default fileRoute(async (event) => {
  const { ws } = await requireWorkspaceFromRoute(event);
  return { members: await listWorkspaceMembers(ws.organizationId) };
});