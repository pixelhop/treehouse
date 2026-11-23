import { createError, getQuery } from "h3";
import { listTrash } from "../../../../utils/recovery";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Deleted files, newest deletion first: ?prefix= limits to a folder, ?limit=
// (default 100, max 500), and ?before=<nextBefore> pages. Only files the caller
// can see are listed. Restore them with POST /recovery/apply { kind: "trash" }.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const q = getQuery(event);
  const int = (v: unknown, name: string) => {
    if (typeof v !== "string") return undefined;
    if (!/^\d+$/.test(v))
      throw createError({ statusCode: 400, statusMessage: `Invalid '${name}'` });
    return Number(v);
  };
  return listTrash({
    workspaceId: ws.id,
    subject: access,
    prefix: typeof q.prefix === "string" && q.prefix ? q.prefix : undefined,
    limit: int(q.limit, "limit"),
    before: int(q.before, "before"),
  });
});