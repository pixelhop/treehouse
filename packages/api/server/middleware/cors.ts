import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from "h3";

// Browsers send the `Origin` header without a trailing slash, so normalise any
// configured value to avoid a silent mismatch (e.g. APP_URL="https://app.com/").
function normalizeOrigin(url?: string): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

// Allowed front-end origins. APP_URL is the deployed app (e.g. Cloudflare) and
// may be a comma-separated list (prod + Cloudflare preview URLs); localhost is
// kept for development.
const allowedOrigins = new Set(
  [...(process.env.APP_URL ?? "").split(","), "http://localhost:3000"]
    .map(normalizeOrigin)
    .filter(Boolean) as string[],
);

// Public, cookie-free reads that any site may make. The marketing site
// (trytree.house) shows the same live prices checkout charges, but it is not an
// app origin and must not become one: listing it in APP_URL would let it send
// the session cookie to every route. A wildcard without credentials lets it read
// the price list and nothing else.
const PUBLIC_READ_PATHS = new Set(["/api/plans"]);

// The OAuth + MCP surface a browser-based MCP client (MCP Inspector, a web IDE)
// calls from its own origin: discovery, client registration, token exchange
// and the MCP endpoint itself. Every one of them is authenticated by what the
// request carries (a client id, a code, a bearer token), never by the session
// cookie, so they get a wildcard origin WITHOUT credentials — the browser then
// refuses to attach the cookie. Desktop and server-side clients ignore CORS.
const OAUTH_PUBLIC_PATHS = new Set([
  "/api/mcp",
  "/api/auth/jwks",
  "/api/auth/oauth2/register",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
]);
function isOAuthPublicPath(path: string): boolean {
  return OAUTH_PUBLIC_PATHS.has(path) || path.startsWith("/.well-known/");
}

// Credentialed CORS: the session cookie only travels cross-origin when the
// response echoes the specific request origin (never "*") and allows credentials.
export default defineEventHandler((event) => {
  const origin = getRequestHeader(event, "origin");

  if (origin && allowedOrigins.has(origin)) {
    setResponseHeader(event, "Access-Control-Allow-Origin", origin);
    setResponseHeader(event, "Access-Control-Allow-Credentials", "true");
    setResponseHeader(event, "Vary", "Origin");
    setResponseHeader(event, "Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    setResponseHeader(
      event,
      "Access-Control-Allow-Headers",
      // Range / If-Range: a single plain `bytes=a-b` range is CORS-safelisted,
      // but a suffix range or a conditional one needs a preflight that allows it.
      "Content-Type, Authorization, If-Match, If-None-Match, Range, If-Range, x-api-key",
    );
    // Optimistic concurrency: browser clients must be able to read the file
    // version off responses, which requires explicitly exposing both version
    // headers — ETag (legacy) and X-Treehouse-Version (the one that survives a
    // CDN; see the file GET route). Content-Range and Accept-Ranges let a
    // script reading a partial response (a media player, a resumable download)
    // learn which bytes it got and the file's full size.
    setResponseHeader(
      event,
      "Access-Control-Expose-Headers",
      "ETag, X-Treehouse-Version, X-Treehouse-Content-Hash, Content-Range, Accept-Ranges",
    );
  } else if (origin && isOAuthPublicPath(event.path.split("?")[0]!)) {
    setResponseHeader(event, "Access-Control-Allow-Origin", "*");
    setResponseHeader(event, "Vary", "Origin");
    setResponseHeader(event, "Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    setResponseHeader(
      event,
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, DPoP, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    );
    // WWW-Authenticate carries the 401's pointer to the authorization server —
    // the one thing a browser client needs to read to start OAuth.
    setResponseHeader(
      event,
      "Access-Control-Expose-Headers",
      "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, DPoP-Nonce",
    );
  } else if (origin && event.method === "GET" && PUBLIC_READ_PATHS.has(event.path.split("?")[0]!)) {
    setResponseHeader(event, "Access-Control-Allow-Origin", "*");
    setResponseHeader(event, "Vary", "Origin");
  }

  // Let non-preflight requests continue to their route handler.
  if (event.method !== "OPTIONS") {
    return;
  }

  // Short-circuit preflight requests with an empty 204.
  setResponseStatus(event, 204);
  return "";
});