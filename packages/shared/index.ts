// Pure helpers shared by the API, the sync CLI, and the web app — one source of
// truth for file types, the conflicted-copy naming convention, and
// URL path encoding (which must match byte-for-byte across writer and reader).

// Fuzzy path search and ranking — shared so the sidebar, the REST search
// endpoint, and the MCP search tool rank identically.
export * from "./search";

// PostHog proxy hostnames, proxy header policy, and URL redaction — shared so
// the app's proxy, the marketing site's proxy, and the API's error reporting
// agree on which hosts to talk to and which parts of a URL are unsafe to log.
export * from "./analytics";

// The file-type table: extension → content type and text-ness, plus the viewer
// classification and markdown-path helpers derived from it.
export * from "./fileTypes";

// Relative references inside documents (markdown links and images, editor
// image srcs) resolved to workspace paths.
export * from "./relativeRefs";

// Links between notes: wikilink syntax and resolution. The scanner the backlink
// index is built from, and the rewrite that keeps links working after a rename,
// are server-side and imported from "shared/linkScan" (they need a markdown
// parser the app shouldn't bundle).
export * from "./links";

// Tags on notes: what counts as one, and when two are the same (case, nesting).
export * from "./tags";

// Change-feed op names — the union the API writes and every reader handles.
export * from "./changeOps";

// Recovery (trash, point-in-time restore, undo) wire types — the API's answers
// and the web app's rendering of them.
export * from "./recovery";

// Plan price formatting — shared so the app's plan picker and the marketing
// homepage quote Stripe's prices the same way.
export * from "./pricing";

// ---------------------------------------------------------------------------
// Conflicted-copy naming. The server constructs these names; the CLI and app
// detect them. Keeping the marker + builder + detector together here is what
// prevents the writer and readers from drifting.
// ---------------------------------------------------------------------------

const CONFLICT_MARKER = "conflicted copy";

/** True for a server-generated conflicted copy, e.g. "report (conflicted copy — agent — 2026-…).md". */
export function isConflictedCopy(path: string): boolean {
  return path.includes(`(${CONFLICT_MARKER} — `);
}

/**
 * Build the conflicted-copy name: "<base> (conflicted copy — <who> — <iso>).<ext>"
 * with the suffix before the extension, and a counter for collision-safety.
 */
export function conflictedCopyName(
  path: string,
  who: string,
  iso: string,
  counter: number,
): string {
  const stamp = `${CONFLICT_MARKER} — ${who} — ${iso}`;
  const suffix = counter > 1 ? ` (${counter})` : "";
  const dot = extensionDot(path);
  if (dot === -1) return `${path} (${stamp})${suffix}`;
  return `${path.slice(0, dot)} (${stamp})${suffix}${path.slice(dot)}`;
}

/**
 * Where the file name's extension starts, or -1 if it has none. Looks in the
 * name only: a dot in a directory (`acme.v1/README`) isn't an extension, and
 * treating it as one puts the copy in a different directory, outside whatever
 * folder restriction or key the original sits under.
 */
function extensionDot(path: string): number {
  const dot = path.lastIndexOf(".");
  const nameStart = path.lastIndexOf("/") + 1;
  return dot <= nameStart || dot === path.length - 1 ? -1 : dot;
}

/**
 * The fixed head and tail every conflicted copy of `path` shares, whoever wrote
 * it and whenever. Lets a store find the existing copies of ONE file without
 * re-deriving the name format at the query site (the writer and the finder
 * drifting apart is exactly what this module exists to prevent).
 */
export function conflictedCopyBounds(path: string): { prefix: string; suffix: string } {
  const dot = extensionDot(path);
  const head = dot === -1 ? path : path.slice(0, dot);
  const tail = dot === -1 ? "" : path.slice(dot);
  return { prefix: `${head} (${CONFLICT_MARKER} — `, suffix: tail };
}

/**
 * Whether this user agent belongs to the Treehouse desktop shell.
 *
 * Two signals, in order of trust:
 *
 *  1. `TreehouseDesktop/<version>` — the shell appends this itself
 *     (`shellUserAgent` in packages/desktop/src/security.ts). Ours, explicit, and
 *     it identifies THIS product rather than the runtime.
 *  2. `Electron/<version>` — Electron's default token, kept as a fallback so a
 *     shell built before signal 1 existed still behaves sanely. It matches any
 *     Electron app, which is why it is second.
 *
 * A HINT, never a credential: any client can send any user agent, so this may only
 * shape presentation or routing. It must not gate access to anything.
 */
export function isDesktopShellUserAgent(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== "string") return false;
  return /\bTreehouseDesktop\/\d/i.test(userAgent) || /\bElectron\/\d/i.test(userAgent);
}

/** Encode each path segment but keep the slashes, so writer and reader agree on the URL. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Empty-folder placeholder. The data model has no folder rows — a folder exists
// only because some file's path contains it. To let the UI create and persist an
// otherwise-empty folder, "create folder" writes a hidden `.keep` file. It is a
// presentation convention: the web tree hides it, the CLI ignores it for
// sync-noise, and MCP omits it from agent listings — but the file service still
// stores and syncs it so the folder materializes on disk.
// ---------------------------------------------------------------------------

/** The hidden placeholder file that materializes an otherwise-empty folder. */
export const KEEP_FILE = ".keep";

/** True for a `.keep` placeholder (at the root or in any folder). */
export function isKeepFile(path: string): boolean {
  return path === KEEP_FILE || path.endsWith(`/${KEEP_FILE}`);
}

/**
 * Client-side mirror of the server's path rules (see normalizePath in the file
 * service): a safe workspace-relative path has no traversal (`.`/`..` segments),
 * no backslashes (rejected, never normalized — Windows write-path safety) or
 * null bytes, and no empty/leading/trailing segments. The server is still the
 * authority; this just rejects bad input early for a cleaner UX.
 */
export function isSafeRelPath(path: string): boolean {
  if (!path || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
// ---------------------------------------------------------------------------
// Workspace icon values. `Workspace.icon` is one string carrying one of three
// kinds of icon: an emoji ("🌳"), an Iconify name ("solar:folder-bold-duotone",
// recognized by the colon), or `upload:<sha256>` pointing at an uploaded logo in
// the blob store. The API mints the `upload:` form and the app parses it back
// into a bytes URL, so the encoding lives here rather than on either side.
// ---------------------------------------------------------------------------

/** Prefix marking an uploaded image icon: `upload:<sha256>`. */
export const UPLOADED_ICON_PREFIX = "upload:";

/** The sha256 of an uploaded icon, or null for emoji/Iconify/empty values. */
export function uploadedIconHash(icon: string | null | undefined): string | null {
  if (!icon?.startsWith(UPLOADED_ICON_PREFIX)) return null;
  const hash = icon.slice(UPLOADED_ICON_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}