import { createError, getQuery } from "h3";
import { listThreads } from "../../../../utils/comments";
import { actorFor, fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// List comment threads. Filters: ?path= (one file), ?threadId= (one thread,
// 404 if missing/denied), ?status=open|resolved, ?anchorStatus=, ?author=,
// ?limit/?offset for threads and ?entriesLimit/?entriesOffset for the replies
// within each one. The service gates access (fail-as-404) — no gate here.
//
// Both pages are capped, so the response has to say how to get the rest:
// `total` plus `nextOffset` (null on the last page) page the threads, and
// each thread's `entryCount`/`hasMoreEntries` page its replies via
// ?threadId=&entriesOffset=. `truncated` is true only for ?anchorStatus=,
// which can't page in SQL and therefore counts a bounded scan.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const q = getQuery(event);

  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const int = (v: unknown, name: string): number | undefined => {
    if (typeof v !== "string" || v === "") return undefined;
    if (!/^\d+$/.test(v)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid '${name}'` });
    }
    return Number.parseInt(v, 10);
  };

  const status = str(q.status);
  if (status !== undefined && status !== "open" && status !== "resolved") {
    throw createError({ statusCode: 400, statusMessage: "Invalid 'status'" });
  }
  const anchorStatus = str(q.anchorStatus);
  if (
    anchorStatus !== undefined &&
    anchorStatus !== "anchored" &&
    anchorStatus !== "ambiguous" &&
    anchorStatus !== "outdated"
  ) {
    throw createError({ statusCode: 400, statusMessage: "Invalid 'anchorStatus'" });
  }

  const res = await listThreads({
    workspaceId: ws.id,
    actor: actorFor(ctx, access),
    path: str(q.path),
    threadId: str(q.threadId),
    status,
    anchorStatus,
    author: str(q.author),
    limit: int(q.limit, "limit"),
    offset: int(q.offset, "offset"),
    entriesLimit: int(q.entriesLimit, "entriesLimit"),
    entriesOffset: int(q.entriesOffset, "entriesOffset"),
  });
  if (res.status === "not_found") {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  return {
    threads: res.threads,
    total: res.total,
    nextOffset: res.nextOffset,
    truncated: res.truncated,
  };
});