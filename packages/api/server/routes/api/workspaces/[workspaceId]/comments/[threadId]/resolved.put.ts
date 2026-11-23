import { createError, readBody, setResponseStatus } from "h3";
import { setResolved } from "../../../../../../utils/comments";
import { fileRoute, requireThreadFromRoute } from "../../../../../../utils/workspace";

// Set a thread's resolution state (resolve and reopen through one boolean —
// there is deliberately no delete). Idempotent: a thread already in the target
// state returns success with `changed: false` and emits no event.
export default fileRoute(async (event) => {
  const { ws, threadId, actor } = await requireThreadFromRoute(event);
  const body = await readBody<{ resolved?: boolean }>(event);
  if (typeof body?.resolved !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "resolved (boolean) is required" });
  }

  const res = await setResolved({
    workspaceId: ws.id,
    actor,
    threadId,
    resolved: body.resolved,
  });
  if (res.status === "read_only") {
    setResponseStatus(event, 402);
    return { error: "workspace_read_only" };
  }
  if (res.status === "not_found") {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  return {
    resolved: res.resolved,
    resolvedAt: res.resolvedAt,
    resolvedAtVersion: res.resolvedAtVersion,
    resolvedBy: res.resolvedBy,
    changed: res.changed,
  };
});