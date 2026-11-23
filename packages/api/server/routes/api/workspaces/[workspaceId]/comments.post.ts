import { createError, readBody, setResponseStatus } from "h3";
import { createThread } from "../../../../utils/comments";
import { actorFor, fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Create a comment thread anchored to text in a markdown file (R15). Anchor
// failures return structured 409 data — never a thread at a guessed position —
// so the client can retry with an occurrence index or more context while
// keeping the drafted body. Attribution is by credential via actorFor.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{
    path?: string;
    body?: string;
    quote?: string;
    contextBefore?: string;
    contextAfter?: string;
    occurrence?: number;
    kind?: string;
    baseVersion?: number;
  }>(event);

  if (!body?.path || typeof body.body !== "string" || !body.body) {
    throw createError({ statusCode: 400, statusMessage: "path and body are required" });
  }
  if (body.kind !== "range" && body.kind !== "point") {
    throw createError({ statusCode: 400, statusMessage: "kind must be range or point" });
  }

  const res = await createThread({
    workspaceId: ws.id,
    actor: actorFor(ctx, access),
    path: body.path,
    body: body.body,
    quote: body.quote,
    contextBefore: body.contextBefore,
    contextAfter: body.contextAfter,
    occurrence: typeof body.occurrence === "number" ? body.occurrence : undefined,
    kind: body.kind,
    baseVersion: typeof body.baseVersion === "number" ? body.baseVersion : undefined,
  });

  switch (res.status) {
    case "created":
      setResponseStatus(event, 201);
      return { thread: res.thread };
    case "read_only":
      // Same shape a blocked file write returns: the workspace is paused by
      // billing, not broken, and commenting is a write.
      setResponseStatus(event, 402);
      return { error: "workspace_read_only" };
    case "not_found":
      throw createError({ statusCode: 404, statusMessage: "Not found" });
    case "not_markdown":
      setResponseStatus(event, 400);
      return { error: "not_markdown" };
    case "invalid":
      setResponseStatus(event, 400);
      return { error: res.error };
    case "content_unavailable":
      throw createError({ statusCode: 502, statusMessage: "File content unavailable" });
    case "ambiguous":
      setResponseStatus(event, 409);
      return { error: "anchor_ambiguous", occurrences: res.occurrences };
    case "anchor_not_found":
      setResponseStatus(event, 409);
      return { error: "anchor_not_found" };
    case "conflict":
      setResponseStatus(event, 409);
      return {
        error: "base_version_conflict",
        base_version: res.baseVersion,
        current_version: res.currentVersion,
        reason: res.reason,
      };
  }
});