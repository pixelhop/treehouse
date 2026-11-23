import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { defineEventHandler, getRequestHeader, sendWebResponse, toWebRequest } from "h3";
import { buildMcpServer, buildUserMcpServer } from "../../../utils/mcp";
import { withMcpOAuth } from "../../../utils/mcp-oauth";
import {
  actorFor,
  authenticate,
  authorizeWorkspace,
  type RequestPrincipal,
} from "../../../utils/workspace";

// MCP endpoint for agents. Two credentials reach it:
//
// - An API key in `x-api-key` (pasted into the agent's config). A user-scoped
//   key gets the multi-workspace tools (workspaceId per call + list/create
//   workspaces); a legacy workspace-scoped key gets the single-workspace server.
// - An OAuth access token in `Authorization: Bearer`, which an MCP client gets
//   by itself: it calls this endpoint with no credential, follows the 401's
//   `WWW-Authenticate` to the authorization server, and the user signs in and
//   names the connection in the browser. OAuth connections are user-scoped and
//   always act as agents. See utils/mcp-oauth.ts.
//
// Either way the request is served by a stateless streamable-HTTP transport.
// The API key is read with getRequestHeaders (inside `authenticate`), NOT
// toWebRequest, which would lock the body the transport needs; the OAuth path
// only reads headers off the web Request before the transport takes it.
export default defineEventHandler(async (event) => {
  if (getRequestHeader(event, "x-api-key")) {
    const ctx = await authenticate(event);
    const response = await serve(ctx, toWebRequest(event));
    return sendWebResponse(event, response);
  }
  return sendWebResponse(event, await oauthMcp(toWebRequest(event)));
});

const oauthMcp = withMcpOAuth((request, ctx) => serve(ctx, request));

async function serve(ctx: RequestPrincipal, request: Request): Promise<Response> {
  // Built per workspace: the actor carries the access every check is evaluated
  // against (role and key scope), which differs between workspaces.
  let server;
  if (ctx.keyWorkspaceId) {
    const ws = await authorizeWorkspace(ctx, ctx.keyWorkspaceId);
    server = buildMcpServer(ws.id, actorFor(ctx, ws.access));
  } else {
    server = buildUserMcpServer(ctx);
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — fits horizontally-scaled hosting
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}