// Dynamic client registration defaults for MCP clients.
//
// RFC 7591 says a client that omits `application_type` is a "web" client, and
// better-auth enforces the consequence: web clients may only use https redirect
// URIs on public hosts. But almost every MCP client is a local app that
// receives its authorization code on a loopback port (http://127.0.0.1:PORT/
// callback) and omits `application_type` — the official MCP SDK never sends it.
// Taken literally, the spec would turn away Claude Code, Cursor and the rest.
//
// So when the field is missing, infer it from the redirect URIs, as later
// better-auth releases do with `clientRegistrationDefaultApplicationType:
// "infer"`: only loopback http or private-use schemes means a native app.
// Anything else stays "web", with web's rules. Remove this once that option is
// available here.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function looksNative(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  // A private-use scheme (com.example.app:/callback) can only be a native app.
  return url.protocol !== "https:";
}

/**
 * The registration body with `application_type` filled in, or the body
 * unchanged when it already has one or its redirect URIs are those of a web
 * client. Never weakens validation: better-auth still applies native-client
 * rules (exact loopback hosts, well-formed private-use schemes) to the result.
 */
export function withInferredApplicationType<T extends Record<string, unknown>>(
  body: T,
): T & { application_type?: unknown } {
  if (body.application_type !== undefined) return body;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return body;
  if (!uris.every((u) => typeof u === "string" && looksNative(u))) return body;
  return { ...body, application_type: "native" };
}