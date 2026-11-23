import { createError, defineEventHandler, readBody } from "h3";
import { requireWorkspaceFromRoute, requireWorkspaceWriter } from "../../../../utils/workspace";
import { assertSettableIcon, commitIconChange } from "../../../../utils/workspaceIcon";

const MAX_NAME = 100;

// Update a workspace's name / display icon / colour. Authorized like the GET.
export default defineEventHandler(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  requireWorkspaceWriter(access);
  const raw = (await readBody(event)) as Record<string, unknown> | null;
  const body = raw && typeof raw === "object" ? raw : {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);

  const data: {
    name?: string;
    icon?: string | null;
    color?: string | null;
    theme?: string | null;
    themeCss?: string | null;
  } = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) throw createError({ statusCode: 400, statusMessage: "Name cannot be empty" });
    if (name.length > MAX_NAME)
      throw createError({ statusCode: 400, statusMessage: `Name too long (max ${MAX_NAME})` });
    data.name = name;
  }
  // The `upload:` check happens under the lock below, against a fresh read.
  if ("icon" in body) data.icon = str(body.icon);
  if ("color" in body) data.color = str(body.color);
  if ("theme" in body) data.theme = str(body.theme);
  if ("themeCss" in body) data.themeCss = str(body.themeCss);

  // `ws.icon` was read before the lock, so both the "may not invent an upload:
  // pointer" check and the cleanup of what this replaces work off the icon read
  // inside it. Cleanup of the replaced bytes happens after this commits — see
  // commitIconChange.
  return commitIconChange(ws.id, async (tx, currentIcon) => {
    if (data.icon !== undefined) assertSettableIcon(data.icon, currentIcon);
    return tx.workspace.update({
      where: { id: ws.id },
      data,
      select: { id: true, name: true, icon: true, color: true, theme: true, themeCss: true },
    });
  });
});