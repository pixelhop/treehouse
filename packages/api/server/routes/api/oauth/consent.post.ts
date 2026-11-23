import { defineEventHandler, readBody } from "h3";
import { parseConsentBody } from "../../../utils/connection-name";
import { nameConnection, submitConsent, verifyConsentQuery } from "../../../utils/mcp-oauth";
import { requireCookieUser, webHeaders } from "../../../utils/workspace";

// The consent page's Allow / Cancel. Wraps better-auth's own consent endpoint so
// that the name the user typed is saved with the consent in the same request:
// the client gets its authorization code only after the name is stored, so its
// very first tool call is already attributed to it.
//
// Body: { oauth_query, accept, name? } — `oauth_query` is the signed query the
// authorization server put on the consent page's URL.
export default defineEventHandler(async (event) => {
  const { userId } = await requireCookieUser(event);
  const { accept, name, oauthQuery: raw } = parseConsentBody(await readBody(event));
  const { oauthQuery, clientId } = await verifyConsentQuery(raw);

  const result = await submitConsent(webHeaders(event), oauthQuery, accept);
  if (accept) await nameConnection(userId, clientId, name);
  return result;
});