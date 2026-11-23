import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { defineEventHandler, toWebRequest } from "h3";
import { auth } from "../../utils/auth";

// OAuth discovery documents that live at the root of this origin rather than
// under /api/auth, where every other better-auth route is mounted:
//
// - /.well-known/oauth-protected-resource[/api/mcp] (RFC 9728): how an MCP
//   client learns which authorization server guards /api/mcp.
// - /.well-known/oauth-authorization-server/api/auth (RFC 8414): the
//   authorization server's endpoints. The issuer is `<api>/api/auth`, so the
//   spec location inserts that path after the well-known segment.
//
// better-auth serves those from plugin request hooks that match on the path,
// before its own routing, so the request is handed over untouched; any other
// /.well-known path falls through to its 404.
//
// The two documents below are not where the specs put them for this issuer,
// but clients look there anyway: MCP clients written to the 2025-03 spec go
// straight to the origin's root metadata, and some OIDC clients append the
// issuer path to openid-configuration instead of the other way round.
const serverMetadata = oauthProviderAuthServerMetadata(auth);
const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth);

export default defineEventHandler((event) => {
  const request = toWebRequest(event);
  const path = event.path.split("?")[0];
  if (path === "/.well-known/oauth-authorization-server") return serverMetadata(request);
  if (path === "/.well-known/openid-configuration/api/auth") return openIdMetadata(request);
  return auth.handler(request);
});