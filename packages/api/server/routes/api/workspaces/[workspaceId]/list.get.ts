import { createError, getQuery } from "h3";
import { usePrismaClient } from "db";
import { canRead, isPrivateTo, listWorkspaceAcls, restrictionsFor } from "../../../../utils/acl";
import { withFileDetails } from "../../../../utils/file-details";
import { useFileService } from "../../../../utils/files";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

const isCount = (raw: unknown) => typeof raw !== "string" || /^\d+$/.test(raw);

// Validate the reserved pagination params so a bad value fails now (400) rather
// than silently misbehaving when pagination is implemented.
function assertPageParams(query: { limit?: unknown; cursor?: unknown }): void {
  if (!isCount(query.limit)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid 'limit'" });
  }
  if (query.cursor !== undefined && typeof query.cursor !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Invalid 'cursor'" });
  }
}

/** Custom icons and orders by path. One on a hidden node would name that node. */
async function visibleMeta(workspaceId: string, acls: AclRow[], access: AccessSubject) {
  const metas = await usePrismaClient().nodeMeta.findMany({
    where: { workspaceId },
    select: { path: true, icon: true, order: true },
  });
  const visible = metas.filter((m) => canRead(acls, m.path, access));
  return {
    icons: Object.fromEntries(visible.flatMap((m) => (m.icon ? [[m.path, m.icon]] : []))),
    orders: Object.fromEntries(
      visible.flatMap((m) => (m.order != null ? [[m.path, m.order]] : [])),
    ),
  };
}

// List file entries under an optional ?prefix, plus a path→icon map of custom
// file/folder icons so the tree can render them (default icon when absent).
// Restricted nodes the caller holds no grant on are filtered out of `entries`;
// `privatePaths` carries the caller's OWN private node paths (files and folders)
// so the UI can render a lock on them.
//
// `?details=1` adds each entry's created/updated times, who last changed it,
// and whether it is new to the caller (see utils/file-details.ts). Opt-in: the
// web app asks for it, the sync clients don't.
//
// Pagination contract (reserved, R3): `limit`/`cursor` are accepted and
// validated but currently no-ops — the whole listing is returned in one page.
// `nextCursor` is always null for now; clients MUST iterate until it is null so
// they keep working once real pagination lands (a breaking change otherwise).
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const query = getQuery(event);
  const prefix = typeof query.prefix === "string" ? query.prefix : "";

  assertPageParams(query);

  // Fetch ACLs once and reuse them for both the entry filter (inside the service)
  // and the caller's own `privatePaths` — a single query, not two.
  const acls = await listWorkspaceAcls(ws.id);
  const listed = await useFileService().list(ws.id, prefix, access, acls);
  const entries = await withFileDetails(listed, ws.id, ctx.userId, query.details === "1");

  const { icons, orders } = await visibleMeta(ws.id, acls, access);

  const privatePaths = acls
    .filter((a) => isPrivateTo(a, ctx.userId) && canRead(acls, a.path, access))
    .map((a) => a.path);

  return {
    entries,
    icons,
    orders,
    privatePaths,
    restrictions: restrictionsFor(acls, access),
    nextCursor: null,
  };
});