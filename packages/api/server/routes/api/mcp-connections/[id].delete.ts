import { createError, defineEventHandler, getRouterParam } from "h3";
import { disconnectConnection } from "../../../utils/mcp-oauth";
import { requireCookieUser } from "../../../utils/workspace";

// Disconnect an agent: its tokens stop working on the next request.
export default defineEventHandler(async (event) => {
  const { userId } = await requireCookieUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing connection id" });
  if (!(await disconnectConnection(userId, id))) {
    throw createError({ statusCode: 404, statusMessage: "Connection not found" });
  }
  return { ok: true };
});