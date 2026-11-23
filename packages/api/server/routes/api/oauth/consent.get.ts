import { usePrismaClient } from "db";
import { createError, defineEventHandler, getQuery } from "h3";
import { verifyConsentQuery } from "../../../utils/mcp-oauth";
import { requireCookieUser } from "../../../utils/workspace";

// What the consent page shows: which client is asking, and the name the user
// gave it last time, if they have connected it before (prompt=consent re-asks).
//
// Query: ?oauth_query=<the signed query from the consent page's own URL>.
export default defineEventHandler(async (event) => {
  const { userId } = await requireCookieUser(event);
  const { clientId } = await verifyConsentQuery(getQuery(event).oauth_query);

  const db = usePrismaClient();
  const client = await db.oauthClient.findFirst({
    where: { clientId, disabled: { not: true } },
    select: { name: true, icon: true, uri: true },
  });
  if (!client) throw createError({ statusCode: 404, statusMessage: "Unknown application" });
  const existing = await db.oauthConsent.findFirst({
    where: { clientId, userId },
    select: { name: true },
  });
  return { client, name: existing?.name ?? null };
});