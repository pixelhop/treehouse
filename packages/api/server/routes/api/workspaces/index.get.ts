import { defineEventHandler } from "h3";
import { requireCookieUser, workspacesForUser } from "../../../utils/workspace";

// Every workspace the caller is a member of, oldest first. Cookie session only —
// an API key is scoped to a single workspace and can't enumerate siblings.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const rows = await workspacesForUser(ctx.userId);
  const workspaces = rows.map((w) => ({
    id: w.id,
    name: w.name,
    icon: w.icon,
    color: w.color,
    theme: w.theme,
    themeCss: w.themeCss,
  }));
  return { workspaces };
});