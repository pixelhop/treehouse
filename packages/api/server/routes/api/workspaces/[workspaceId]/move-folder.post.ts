import { createError, readBody } from "h3";
import { moveFolderMetadata } from "../../../../utils/acl";
import {
  assertWritable,
  fileRoute,
  NODE_PATH_MAX,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Re-path a folder's own ACL + metadata (icons/order) when the folder is moved
// or renamed. The UI moves a folder's *contents* as per-file moves; a file's own
// ACL rides along, but the folder's virtual-path ACL row would otherwise orphan
// and the moved subtree silently lose its privacy. The caller must be able to
// write both the source and destination (unseen paths read as 404). File bytes are
// not touched here — the client issues the per-file moves separately.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{ from?: string; to?: string }>(event);
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!from || !to) throw createError({ statusCode: 400, statusMessage: "from and to required" });
  if (from.length > NODE_PATH_MAX || to.length > NODE_PATH_MAX)
    throw createError({ statusCode: 400, statusMessage: "path too long" });

  await assertWritable(ws.id, access, from, to);

  await moveFolderMetadata(ws.id, from, to);
  return { from, to, ok: true };
});