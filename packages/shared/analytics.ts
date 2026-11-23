// PostHog wiring that must agree across surfaces. The web app and the marketing
// site each run their own reverse proxy for PostHog (see the `ph/[...path]`
// server routes); the API redacts the same URLs the browser does. Keeping the
// hostnames, the header policy and the redaction rules here is what stops the
// two proxies from drifting into "works on marketing, silently drops events on
// the app" — and stops one surface from redacting a path the other leaks.
//
// This module is deliberately dependency-free (no h3, no posthog-js) so it can
// be imported by the Cloudflare Worker, the Node API, and the CLI alike.

/** PostHog EU Cloud ingestion host. Events, flags, replay snapshots. */
export const POSTHOG_API_HOST = "eu.i.posthog.com";

/** PostHog EU Cloud asset host. The SDK bundles under /static/ and /array/. */
export const POSTHOG_ASSET_HOST = "eu-assets.i.posthog.com";

/**
 * The human-facing PostHog app. Passed to the SDK as `ui_host` so the toolbar
 * and "view in PostHog" links resolve to the real product rather than to our
 * proxy path, which serves the API and would 404 for a UI route.
 */
export const POSTHOG_UI_HOST = "https://eu.posthog.com";

/**
 * Build the upstream URL for a proxied PostHog request.
 *
 * Asset paths go to the CDN host and everything else to the ingestion host —
 * they are different origins, and sending `/static/array.js` to the ingestion
 * host returns a 404 that manifests as "PostHog never loads" with no clue why.
 *
 * `path` is the portion AFTER our proxy prefix, with no leading slash;
 * `search` is the query string including its leading `?`, or an empty string.
 */
export function posthogUpstreamUrl(path: string, search = ""): string {
  const clean = path.replace(/^\/+/, "");
  const isAsset = clean.startsWith("static/") || clean.startsWith("array/");
  const host = isAsset ? POSTHOG_ASSET_HOST : POSTHOG_API_HOST;
  return `https://${host}/${clean}${search}`;
}

// Hop-by-hop and encoding headers must not be forwarded: `host` would point the
// upstream at our own domain, `content-length` goes stale if the body is
// re-encoded, and forwarding `accept-encoding` invites a compressed response
// that we would then have to decompress to re-emit correctly.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  // Our better-auth session cookie has no business reaching an analytics
  // vendor. PostHog does not need it and cannot use it; sending it would be
  // handing a third party a live credential for our own API.
  "cookie",
  // The Referer carries the FULL page URL — which in this app is the user's
  // file path. Serving PostHog same-origin is what creates this: browsers send
  // the complete URL as Referer for same-origin requests (the default
  // `strict-origin-when-cross-origin` policy only trims it when the origin
  // differs). So the proxy, which exists partly FOR privacy, is precisely what
  // put `/w/:id/Finances/2026 Tax Return.md` on every request to PostHog —
  // events, flags and replay alike.
  //
  // Invisible from the payload, so no amount of `before_send` redaction closes
  // it. Dropped rather than redacted: PostHog has no use for it, and it derives
  // `$referrer` from the event body, which is redacted already.
  "referer",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  // The upstream must not be able to set cookies on OUR origin. Proxying puts
  // PostHog on our domain, so an upstream Set-Cookie would become a
  // first-party cookie we never asked for.
  "set-cookie",
]);

/**
 * The headers to send upstream: the client's headers minus the ones above, with
 * `host` pinned to the upstream and the caller's IP forwarded so PostHog can do
 * its own geo-lookup. Without the forwarded IP every event would be attributed
 * to the edge location that proxied it.
 */
export function proxyRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
  upstreamHost: string,
  clientIp?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  out.host = upstreamHost;
  if (clientIp) out["x-forwarded-for"] = clientIp;
  return out;
}

/** True when a response header from PostHog may be passed back to the browser. */
export function isForwardableResponseHeader(name: string): boolean {
  return !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// URL redaction
// ---------------------------------------------------------------------------

/**
 * The placeholder substituted for a redacted path segment. A constant rather
 * than a bare string so tests and dashboards can match on it exactly.
 */
export const REDACTED = "<redacted>";

/**
 * Rewrite a URL so it carries no user content, no file names, and no bearer
 * tokens — then hand it to analytics.
 *
 * This is not belt-and-braces on top of DOM masking; it is the only thing
 * standing between PostHog and every file name in the product. Treehouse puts
 * the file path IN the URL (`/w/:workspaceId/Finances/2026 Tax Return.md`), and
 * posthog-js attaches `$current_url` to EVERY event — pageviews, autocapture,
 * exceptions, replay metadata — so masking the DOM alone would have leaked the
 * names anyway, on every click, in a property nobody thinks to look at.
 *
 * What survives redaction:
 *   - the route shape, so funnels and page breakdowns still work
 *   - opaque server-generated ids (a workspace id identifies a workspace, not
 *     a person or a document, and grouping by it is the whole point)
 *
 * What does not:
 *   - anything a user named (file and folder paths)
 *   - share and invite tokens, which are bearer credentials: whoever holds one
 *     can read the shared content, so a token in an analytics log is a leak
 *     even when the log is private
 *   - the query string and hash, wholesale — nothing in this app puts anything
 *     there that is worth the risk of an allow-list we might get wrong
 *
 * Accepts absolute or relative URLs. Never throws: unparseable input returns a
 * marker rather than propagating an error into an analytics hot path, because
 * an exception thrown inside `before_send` would take out the capture call that
 * triggered it.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    // The base only matters for relative inputs; it is stripped again below
    // whenever the caller gave us a relative URL.
    parsed = new URL(url, "http://redacted.invalid");
  } catch {
    return REDACTED;
  }

  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  // A byte-Worker grant is a bearer credential wherever it appears: under the
  // Worker's /b/ route (below), or in any other position a future route or a
  // proxy prefix might put it. Recognised by its shape, so this does not
  // depend on knowing the Worker's host.
  const redacted = redactSegments(segments).map((s) => (isGrantShaped(s) ? REDACTED : s));
  const path = `/${redacted.join("/")}`;

  // Preserve the caller's shape: a relative URL in, a relative URL out.
  if (parsed.origin === "http://redacted.invalid" && !/^https?:\/\//i.test(url)) {
    return path;
  }
  return `${parsed.origin}${path}`;
}

/**
 * Per-route redaction rules, keyed on the first path segment. Anything not
 * listed passes through untouched — the app's other routes (`/dashboard`,
 * `/organizations`, `/connect/...`) are static and carry no user data.
 *
 * The `/w/` rule keeps the workspace id and drops everything after it; the
 * token routes drop the token but keep the route so we can still count share
 * and invite views.
 */
function redactSegments(segments: string[]): string[] {
  const [head, ...rest] = segments;
  if (head === undefined) return [];

  switch (head) {
    // /w/:workspaceId/:filePath... — keep the id, redact the user's path.
    case "w":
      if (rest.length <= 1) return segments;
      return [head, rest[0]!, REDACTED];
    // /s/:token and /invite/:token — the token is a credential. So is the byte
    // Worker's /b/:grant: it opens one file's bytes for hours, and a grant URL
    // can reach the replay through a network request or an <img src> pasted
    // into a document.
    case "s":
    case "invite":
    case "b":
      if (rest.length === 0) return segments;
      return [head, REDACTED];
    // The API's own routes, which the browser also emits: session replay
    // captures network request URLs, and a file download link's href points
    // straight at /api/workspaces/:id/files/<the user's path>.
    case "api":
      return ["api", ...redactApiSegments(rest)];
    default:
      return segments;
  }
}

/**
 * A byte-Worker grant: `<keyId>.<base64url sealed body>` (see blob-io's
 * blob-grant.ts). The body is hundreds of characters even for the smallest
 * grant, so a long base64url run after a short dotted prefix is unmistakable.
 * Over-matching only ever redacts more.
 */
function isGrantShaped(segment: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{100,}$/.test(segment);
}

/** Redaction for the segments AFTER `/api`. Split out so the `/api` case above
 * stays readable; see `redactSegments` for the rules that apply to app routes. */
function redactApiSegments(segments: string[]): string[] {
  const [head, ...rest] = segments;
  if (head === undefined) return [];

  // /api/workspaces/:id/{files,list,search}/:path... — keep the route, drop the path.
  if (head === "workspaces" && rest.length >= 2) {
    const [workspaceId, route, ...tail] = rest;
    const PATH_BEARING = new Set(["files", "list", "search"]);
    if (PATH_BEARING.has(route!) && tail.length > 0) {
      return [head, workspaceId!, route!, REDACTED];
    }
    return segments;
  }

  // /api/share/:token/... and /api/invites/:token/... — bearer credentials.
  if ((head === "share" || head === "invites") && rest.length > 0) {
    return [head, REDACTED];
  }

  return segments;
}
/**
 * Whether an event property carries a URL or a path, and so must be redacted.
 *
 * Matched by NAME SHAPE rather than an exact list, and that is deliberate.
 * posthog-js stamps ~90 properties onto an event and keeps adding more; an
 * exact list is fail-OPEN, because a URL-bearing property added by a future SDK
 * version sails straight through. That is not hypothetical — the original list
 * here missed `$session_entry_url` and `$session_entry_pathname`, which carry
 * the page a session STARTED on. Anyone deep-linking, bookmarking or simply
 * refreshing while a file is open put that file's full path on every event for
 * the rest of the session.
 *
 * The rule catches `$current_url`, `$pathname`, `$initial_current_url`,
 * `$initial_pathname`, `$referrer`, `$initial_referrer`, `$session_entry_url`,
 * `$session_entry_pathname`, `$session_entry_referrer` — and whatever
 * `$..._url` PostHog invents next.
 *
 * It deliberately does NOT match `$referring_domain`,
 * `$session_entry_referring_domain`, `$session_entry_utm_*` or
 * `$session_entry_gclid`. Those are a bare domain and campaign tags: they carry
 * no path, and they are exactly how "where did this person come from" is
 * answered. Redacting them would buy no privacy and cost all our attribution.
 */
function isUrlBearingProperty(key: string): boolean {
  return /(?:url|pathname|referrer)$/i.test(key);
}

/**
 * Redact every URL-bearing property on an outgoing analytics event, in place.
 *
 * Mutates and returns the same object because it runs inside posthog-js's
 * `before_send` on every single event, where allocating a copy per event buys
 * nothing.
 *
 * `$referrer` is special-cased: posthog-js uses the literal `"$direct"` to mean
 * "no referrer", and putting that through a URL parser would turn a meaningful
 * value into the redaction marker and quietly destroy direct-traffic reporting.
 */
export function redactEventProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!properties) return properties;
  for (const key of Object.keys(properties)) {
    if (!isUrlBearingProperty(key)) continue;
    const value = properties[key];
    // posthog-js uses the literal "$direct" to mean "no referrer"; putting it
    // through a URL parser would turn a meaningful value into the redaction
    // marker and quietly destroy direct-traffic reporting.
    if (typeof value !== "string" || value === "" || value === "$direct") continue;
    properties[key] = redactUrl(value);
  }
  return properties;
}

/**
 * Whether session replay may run on this route.
 *
 * `/s/:token` is a PUBLIC share. Whoever is looking at it is often not a
 * Treehouse user at all, has agreed to nothing, and is reading a document that
 * belongs to someone else — simultaneously the most sensitive and the least
 * useful thing we could record. Events still capture (redacted); only the
 * replay stops.
 */
export function isReplayableRoute(path: string): boolean {
  return !path.startsWith("/s/");
}
/**
 * File extensions we are willing to report to analytics.
 *
 * An ALLOW-list, deliberately. The previous rule — "accept anything short and
 * alphanumeric" — was a deny-list in disguise, and therefore fail-open: it
 * happily forwarded `Diagnosis.HIV` as "hiv", `Client.Acme` as "acme" and
 * `Salary.Bob` as "bob". A dot in a filename does not mean what follows it is a
 * file TYPE; it is user-authored text like the rest of the name.
 *
 * Anything unrecognised is reported as "other", which is all the fidelity this
 * needs: the question analytics answers is "what kinds of file do people keep
 * here", and a long tail bucketed as "other" answers it just as well as their
 * names would.
 *
 * Adding to this list is fine — a file format is not information about a
 * person. Just make sure what you add is genuinely a format, and not something
 * a user might plausibly have typed after a dot.
 */
const KNOWN_EXTENSIONS = new Set([
  // Documents
  "md",
  "markdown",
  "txt",
  "rtf",
  "pdf",
  "doc",
  "docx",
  "odt",
  "pages",
  "epub",
  "tex",
  // Structured data
  "json",
  "jsonl",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "parquet",
  "xls",
  "xlsx",
  "ods",
  "numbers",
  "sqlite",
  "db",
  // Presentations
  "ppt",
  "pptx",
  "odp",
  "key",
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "tif",
  "ico",
  "heic",
  "heif",
  "avif",
  "psd",
  "ai",
  "sketch",
  "fig",
  "xcf",
  // Audio
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "oga",
  "m4a",
  "aiff",
  "opus",
  // Video
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
  "ogv",
  "wmv",
  "mpg",
  "mpeg",
  // Archives and disk images
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "dmg",
  "iso",
  // Web
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  // Code
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "vue",
  "svelte",
  "astro",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "m",
  "mm",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "sql",
  "r",
  "lua",
  "pl",
  "scala",
  "clj",
  "ex",
  "exs",
  "erl",
  "hs",
  "dart",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  // Fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // Misc
  "log",
  "lock",
  "conf",
  "cfg",
  "env",
  "bak",
  "keep",
  "ics",
  "vcf",
  "torrent",
]);

/**
 * The file extension to report to analytics, or a safe placeholder.
 *
 * Deceptively easy to get wrong, and getting it wrong leaks the exact thing
 * this module exists to protect. The naive `path.lastIndexOf(".")` searches the
 * WHOLE PATH, so:
 *
 *   "Private.secret/Tax Return"    -> "secret/tax return"   (folder AND file name)
 *   "Report v1.2 final"            -> "2 final"             (no folder needed)
 *   "a.b.c/d"                      -> "c/d"
 *
 * Two defences, because either alone still leaks:
 *
 *  1. Look only at the BASENAME, so a dot in a folder name cannot reach in.
 *  2. Require the tail to LOOK like an extension — short and alphanumeric.
 *     "Report v1.2 final" has its dot inside the basename, so rule 1 does not
 *     save it; rule 2 does.
 *  3. Require it to be a KNOWN extension. Rules 1 and 2 still passed
 *     "Diagnosis.HIV", "Client.Acme" and "Salary.Bob" straight through — a
 *     short alphanumeric tail is not evidence of a file type, and those are
 *     somebody's diagnosis, client and colleague.
 *
 * Returns "none" when there is no extension (including dotfiles like `.env`,
 * which have none by convention) and "other" when there is something after a
 * dot but it does not look like an extension. Those are deliberately different
 * values: "other" says "we refused to send this", which is useful signal, while
 * still disclosing nothing.
 */
export function fileExtension(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  // dot <= 0 covers both "no dot at all" and a leading-dot dotfile.
  if (dot <= 0 || dot === basename.length - 1) return "none";
  const ext = basename.slice(dot + 1).toLowerCase();
  // Cheap shape check first, then the allow-list. The shape check alone is a
  // deny-list in disguise, and therefore fail-open — see KNOWN_EXTENSIONS.
  if (!/^[a-z0-9]{1,12}$/.test(ext)) return "other";
  return KNOWN_EXTENSIONS.has(ext) ? ext : "other";
}