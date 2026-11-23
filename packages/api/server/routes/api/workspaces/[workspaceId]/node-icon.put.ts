import { createError, defineEventHandler, readBody } from "h3";
import {
  assertWritable,
  NODE_ICON_MAX,
  nodePathFrom,
  requireWorkspaceFromRoute,
  setNodeIcon,
} from "../../../../utils/workspace";

// Set (or clear) the display icon for a file or folder path. An empty/absent
// icon clears it (the viewer falls back to a default icon).
export default defineEventHandler(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{ path?: string; icon?: string | null }>(event);
  const path = nodePathFrom(body);

  const icon = typeof body?.icon === "string" && body.icon ? body.icon : null;
  if (icon && icon.length > NODE_ICON_MAX)
    throw createError({ statusCode: 400, statusMessage: "icon too long" });

  // An icon is shared display metadata on the node, so it takes write access to
  // it — and a node the caller can't see stays not-found.
  await assertWritable(ws.id, access, path);
  await setNodeIcon(ws.id, path, icon);
  return { path, icon };
});