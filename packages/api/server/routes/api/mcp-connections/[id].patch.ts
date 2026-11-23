import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { parseConnectionName } from "../../../utils/connection-name";
import { renameConnection } from "../../../utils/mcp-oauth";
import { requireCookieUser } from "../../../utils/workspace";

// Rename a connection. Applies to its next tool call; earlier change-feed
// entries keep the name they were made under. An empty name falls back to the
// app's own.
export default defineEventHandler(async (event) => {
  const { userId } = await requireCookieUser(event);
  const name = parseConnectionName((await readBody<{ name?: unknown }>(event))?.name);
  if (!(await renameConnection(userId, getRouterParam(event, "id") ?? "", name))) {
    throw createError({ statusCode: 404, statusMessage: "Connection not found" });
  }
  return { ok: true };
});