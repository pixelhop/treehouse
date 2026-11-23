import { createError, type H3Event, readBody, setResponseHeader, setResponseStatus } from "h3";
import { moveWithLinks } from "../../../../utils/links";
import {
  actorFor,
  fileRoute,
  readOnlyError,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Move/rename a file (delete + create in one transaction).
// Body: { from, to, baseVersion?, updateLinks? }.
//
// `updateLinks: true` also rewrites the [[wikilinks]] and relative markdown
// links that reached the file, in every note the caller can write, and the
// moved note's own relative links (see moveWithLinks). Off by default: a sync
// client mirroring a rename made in a local editor gets that editor's own link
// updates as ordinary writes, and a second rewrite here would race them.
// Every outcome that isn't a move, as the HTTP error it becomes.
const REFUSALS = {
  not_found: { statusCode: 404, statusMessage: "Source not found" },
  dest_exists: { statusCode: 409, statusMessage: "Destination exists" },
  // Nothing moved. Older notes are still being indexed, and moving now could
  // leave one of them linking to the old path unseen. The indexing done so far
  // is kept, so a retry gets further.
  links_pending: { statusCode: 503, statusMessage: "Still indexing links; try again" },
} as const;

type Refused = Exclude<Awaited<ReturnType<typeof moveWithLinks>>, { status: "ok" | "conflict" }>;

function refuse(event: H3Event, result: Refused): never {
  if (result.status === "denied") throw readOnlyError(result.denial);
  if (result.status === "links_pending") setResponseHeader(event, "Retry-After", 5);
  throw createError(REFUSALS[result.status]);
}

export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{
    from?: string;
    to?: string;
    baseVersion?: number;
    updateLinks?: boolean;
  }>(event);
  if (!body?.from || !body?.to) {
    throw createError({ statusCode: 400, statusMessage: "from and to are required" });
  }

  const result = await moveWithLinks({
    workspaceId: ws.id,
    from: body.from,
    to: body.to,
    baseVersion: body.baseVersion,
    actor: actorFor(ctx, access),
    updateLinks: body.updateLinks === true,
  });
  if (result.status === "conflict") {
    setResponseStatus(event, 412);
    return { error: "version_conflict", current_version: result.currentVersion };
  }
  if (result.status !== "ok") refuse(event, result);
  return { path: body.to, version: result.version, ...(result.links && { links: result.links }) };
});