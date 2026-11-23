import { createError, readBody, setResponseStatus } from "h3";
import { replyToThread } from "../../../../../../utils/comments";
import { fileRoute, requireThreadFromRoute } from "../../../../../../utils/workspace";

// Reply to a thread. `dedupeKey` makes agent retries idempotent: a duplicate
// returns the surviving entry as success (deduped: true) and emits no second
// event. Thread lookup + ACL live in the service (fail-as-404).
export default fileRoute(async (event) => {
  const { ws, threadId, actor } = await requireThreadFromRoute(event);
  const body = await readBody<{ body?: string; dedupeKey?: string }>(event);
  if (typeof body?.body !== "string" || !body.body) {
    throw createError({ statusCode: 400, statusMessage: "body is required" });
  }

  const res = await replyToThread({
    workspaceId: ws.id,
    actor,
    threadId,
    body: body.body,
    dedupeKey: typeof body.dedupeKey === "string" && body.dedupeKey ? body.dedupeKey : undefined,
  });

  if (res.status === "read_only") {
    setResponseStatus(event, 402);
    return { error: "workspace_read_only" };
  }
  if (res.status === "not_found") {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  if (res.status === "invalid") {
    setResponseStatus(event, 400);
    return { error: res.error };
  }
  setResponseStatus(event, 201);
  return { entry: res.entry, deduped: res.deduped };
});