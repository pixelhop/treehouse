import { defineEventHandler } from "h3";
import { listConnections } from "../../../utils/mcp-oauth";
import { requireCookieUser } from "../../../utils/workspace";

// The signed-in user's OAuth-connected agents (cookie session only, like key
// management: a connection must not be able to list or revoke its siblings).
export default defineEventHandler(async (event) => {
  const { userId } = await requireCookieUser(event);
  return { connections: await listConnections(userId) };
});