import { createError, defineEventHandler, getRouterParam } from "h3";
import { auth } from "../../../utils/auth";
import { requireCookieUser, webHeaders } from "../../../utils/workspace";

// Revoke (delete) an API key the current user owns. Cookie session only — an API
// key must not be able to revoke the owner's other keys.
export default defineEventHandler(async (event) => {
  await requireCookieUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Missing key id" });
  await auth.api.deleteApiKey({
    headers: webHeaders(event),
    body: { keyId: id },
  });
  return { ok: true };
});