// The Treehouse well-known descriptor (R15): lets a client holding only an app
// origin discover the API base URL without user input. It is served from a runtime
// Nitro route (see routes/.well-known/treehouse.get.ts) reading the Worker's
// runtime `apiUrl` — NOT a build-time static asset, which would bake CI's value
// and report the wrong API base URL on every self-hosted deploy.

export interface TreehouseDescriptor {
  product: "treehouse";
  version: number;
  /** The API base URL the app talks to (no trailing slash). May include a
   * reverse-proxy subpath — it is a base, not necessarily a bare origin. */
  apiUrl: string;
}

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, "");

/**
 * Whether a configured apiUrl is usable as an API base: parseable and http(s).
 * Paths are intentionally NOT rejected — the app builds `${apiUrl}/api/...`, so
 * an API mounted on a subpath behind a reverse proxy is a valid self-hosted
 * layout and canonicalizing to the bare origin would break it.
 */
export function isHttpUrl(s: string): boolean {
  try {
    const { protocol } = new URL(s);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Build the descriptor payload for a given runtime API base URL. */
export function buildDescriptor(apiUrl: string): TreehouseDescriptor {
  return { product: "treehouse", version: 1, apiUrl: stripTrailingSlash(apiUrl) };
}

/**
 * Validate a fetched descriptor before trusting it (shell-side consumption).
 * Returns null for anything that isn't a well-formed Treehouse descriptor with
 * an https apiUrl — so a missing endpoint and a malformed/non-https one are
 * treated identically ("not a Treehouse server?"). `allowInsecure` permits
 * http://localhost for dev.
 */
export function parseDescriptor(
  raw: unknown,
  opts: { allowInsecure?: boolean } = {},
): TreehouseDescriptor | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.product !== "treehouse") return null;
  if (typeof d.apiUrl !== "string") return null;

  let url: URL;
  try {
    url = new URL(d.apiUrl);
  } catch {
    return null;
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const secure = url.protocol === "https:";
  const localDev = opts.allowInsecure === true && url.protocol === "http:" && isLocalhost;
  if (!secure && !localDev) return null;

  const version = typeof d.version === "number" ? d.version : 1;
  return { product: "treehouse", version, apiUrl: stripTrailingSlash(d.apiUrl) };
}