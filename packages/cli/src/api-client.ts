import { type ChangeOp, type CommentOp, encodePath } from "shared";
import type { Config } from "./config";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { type ByteStream, once } from "./streams";

/**
 * A 401/403 from the API: the workspace key is invalid, revoked, or expired.
 * Thrown (rather than surfaced as a bare `... failed: 401` message) so the engine
 * can distinguish a terminal auth loss from a transient network failure by type,
 * never by string-matching a message. Drives the daemon's `auth-lost` state.
 */
export class AuthError extends Error {
  readonly status: number;
  /** The API's machine-readable reason (e.g. KEY_NOT_FOUND), when it sent one. */
  readonly reason?: string;
  constructor(what: string, status: number, reason?: string) {
    super(reason ? `${what}: ${status} (${reason})` : `${what}: ${status}`);
    this.name = "AuthError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Throw AuthError for a 401/403 response; a no-op otherwise. Reads the API's
 * `reason` code off the body when present so the log says WHY the key was
 * refused (key deleted vs expired vs usage cap) instead of a bare 401. The body
 * read is best-effort: a proxy-generated 401 has no JSON to parse.
 */
/**
 * How long a streamed upload may go without any progress before it is
 * abandoned. Matches fetch's default header/body timeouts; node:http has none
 * of its own, so without this a server that stalls would hang the engine.
 * TREEHOUSE_UPLOAD_IDLE_MS overrides it (tests use a short one).
 */
function uploadIdleMs(): number {
  const raw = Number(process.env.TREEHOUSE_UPLOAD_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/**
 * PUT a streamed body with node:http rather than fetch. Node's fetch does not
 * apply backpressure to a streamed request body: it reads the source far ahead
 * of the network, so uploading a 1 GiB file peaked at ~700 MB. A piped
 * http.request is held back by the socket and stays flat (~115 MB). The reply
 * is handed back as a standard Response so callers treat both paths alike.
 */
function streamingPut(
  url: string,
  headers: Record<string, string>,
  body: ByteStream,
): Promise<Response> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const source = Readable.from(body);
    let settled = false;
    let answered = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      done();
    };
    const fail = (err: unknown) =>
      settle(() => {
        source.destroy();
        req.destroy();
        reject(err);
      });
    const req = send(target, { method: "PUT", headers }, (res) => {
      answered = true;
      const status = res.statusCode ?? 0;
      // Refused before taking the whole body (an early 401, 403 or 413): stop
      // sending, and end the request cleanly so the reply can still be read.
      if (status >= 400) {
        source.unpipe(req);
        source.destroy();
        req.end();
      }
      const parts: Buffer[] = [];
      const finish = () => settle(() => resolve(toResponse(status, res.headers, parts)));
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", finish);
      // A reply cut off part way still carries its status, which is what the
      // caller classifies on (an AuthError for a 401); keep it rather than
      // reporting the bare socket error underneath.
      res.on("error", finish);
      res.on("close", finish);
    });
    req.setTimeout(uploadIdleMs(), () =>
      fail(new Error(`upload stalled: no progress for ${uploadIdleMs() / 1000}s`)),
    );
    req.on("error", (err) => {
      // Once there is an answer, its handlers settle. Before one, a write error
      // can still be followed by the server's reply (it refused part way and
      // closed), so give that a moment before reporting the error.
      if (answered) return;
      setTimeout(() => (answered ? undefined : fail(err)), 1000);
    });
    source.on("error", fail);
    source.pipe(req);
  });
}

/** A node:http reply as a standard Response. */
function toResponse(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  parts: Buffer[],
): Response {
  const nullBody = status === 204 || status === 304;
  return new Response(nullBody ? null : Buffer.concat(parts), {
    status,
    headers: Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]],
    ),
  });
}

/**
 * The server's "you can see this but can't change it": a 409 carrying
 * `read_only` or `outside_key_folder`, or undefined for anything else. Not a 403 on purpose,
 * since that means signed out and stops the whole folder, and not the 412 version
 * conflict: nothing was stored, so there is no conflicted copy to mirror.
 */
async function readOnlyReason(res: Response): Promise<string | undefined> {
  if (res.status !== 409) return undefined;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { data?: { error?: string; reason?: string } } | null;
  if (body?.data?.error === "outside_key_folder") return "key_folder";
  if (body?.data?.error !== "read_only") return undefined;
  return body.data.reason ?? "unknown";
}

// Two different limits arrive as 507. Naming which one matters: freeing bytes
// will never unblock a workspace that is out of FILES, and a user told the wrong
// thing deletes the wrong content.
async function storageLimitError(path: string, res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    used_bytes?: number;
    limit_bytes?: number;
    used_files?: number;
    limit_files?: number;
  };
  if (body.error === "file_count_exceeded") {
    const detail =
      body.limit_files != null ? ` (${body.used_files ?? "?"} of ${body.limit_files} files)` : "";
    return new Error(
      `put ${path} failed: workspace file limit reached${detail} — delete files or upgrade the plan`,
    );
  }
  const detail =
    body.limit_bytes != null
      ? ` (using ${body.used_bytes ?? "?"} of ${body.limit_bytes} bytes)`
      : "";
  return new Error(`put ${path} failed: workspace storage limit reached${detail}`);
}

async function assertAuthed(res: Response, what: string): Promise<void> {
  if (res.status !== 401 && res.status !== 403) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { reason?: string; data?: { reason?: string } } | null;
  throw new AuthError(what, res.status, body?.reason ?? body?.data?.reason);
}

export interface RemoteEntry {
  path: string;
  version: number;
  size: number;
  contentType: string;
}

/** One row of the workspace change feed (the fields the engine consumes). */
export interface RemoteChange {
  path: string;
  // Every op except comment traffic: the engine never opts into `comment_*`
  // events (see the change feed's `includeComments`).
  op: Exclude<ChangeOp, CommentOp>;
  version: number | null;
  seq: number;
}

export interface ChangesPage {
  changes: RemoteChange[];
  /** Workspace's current max seq; the client is caught up when its cursor === head. */
  head: number;
  /**
   * Last *scanned* seq (before the server's per-requester ACL filter), so the
   * cursor advances past a page fully filtered out for this caller instead of
   * livelocking on it. Present on the `?sinceSeq` path; absent from a server
   * that predates the field (the engine falls back to the last visible event).
   */
  nextSeq?: number;
}

export interface PutOk {
  ok: true;
  version: number;
}
export interface PutConflict {
  ok: false;
  conflict: true;
  currentVersion: number | null;
  conflictCopyPath: string;
}
// The write target is private to another member: the server returns 404 (no
// existence disclosure). The caller treats this as access-lost, not an error.
export interface PutForbidden {
  ok: false;
  forbidden: true;
}
// The caller can see the path but not change it (a viewer, or a view-only
// grant). `refused` is the server's reason. Nothing was stored.
export interface PutRefused {
  ok: false;
  refused: string;
}

/** Set by the API on (only) a redirect to the byte Worker. */
const HANDOFF_HEADER = "x-treehouse-byte-handoff";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** As many hops as fetch itself would follow. */
const MAX_REDIRECTS = 20;

/**
 * A hop off the API (a byte-Worker grant URL, or another origin) may carry a
 * bearer credential in its URL. Its failures are rethrown with neither the URL
 * nor the underlying error attached, so the CLI's and the desktop app's logs
 * can never record a grant. Hops to the API keep their usual errors.
 */
async function fetchQuietly(
  url: URL,
  headers: Record<string, string>,
  onApi: boolean,
): Promise<Response> {
  if (onApi) return fetch(url, { headers, redirect: "manual" });
  try {
    return await fetch(url, { headers, redirect: "manual" });
  } catch {
    throw new Error("download from the file host failed (network error)");
  }
}

/** The next hop, without echoing an unparseable Location into an error. */
function nextUrl(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch {
    throw new Error("the server sent a redirect that is not a valid URL");
  }
}

/**
 * GET `url` following redirects by hand, deciding per hop where the API key
 * may go. fetch would carry `x-api-key` across origins (it strips only
 * Authorization), so it cannot be left to fetch:
 *
 *  - a byte-Worker handoff (marked by the API with x-treehouse-byte-handoff)
 *    is followed with NO credentials: the grant in its URL is the credential;
 *  - any other redirect (a proxy sending the API to its canonical URL, say) is
 *    followed with the key only while it stays on the API's own origin, and
 *    without it anywhere else.
 *
 * `fromApi` says whether the final answer came from the API's origin, so its
 * 404s and 401s can be read as the API's verdicts and nobody else's.
 */
async function getFollowing(
  url: string,
  apiOrigin: string,
  headers: Record<string, string>,
): Promise<{ res: Response; fromApi: boolean }> {
  let current = new URL(url);
  let sendKey = true;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res: Response = await fetchQuietly(current, sendKey ? headers : {}, sendKey);
    const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
    if (!location) return { res, fromApi: sendKey && current.origin === apiOrigin };
    const handoff: boolean = res.headers.get(HANDOFF_HEADER) === "1";
    await res.body?.cancel();
    current = nextUrl(location, current);
    sendKey = !handoff && sendKey && current.origin === apiOrigin;
  }
  throw new Error(`too many redirects fetching ${url}`);
}

export class ApiClient {
  #cfg: Config;
  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  #url(path: string): string {
    return `${this.#cfg.apiBase}/api/workspaces/${this.#cfg.workspaceId}/${path}`;
  }
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "x-api-key": this.#cfg.apiKey, ...extra };
  }

  async list(): Promise<RemoteEntry[]> {
    // Iterate until the server stops handing back a cursor. Pagination is a
    // reserved no-op today (`nextCursor` is always null), but looping now means
    // the CLI keeps working unchanged once the server paginates for real.
    const entries: RemoteEntry[] = [];
    let cursor: string | undefined;
    // Guard against a server bug handing back a repeated cursor, which would
    // otherwise hang the daemon in an infinite fetch loop.
    const seen = new Set<string>();
    do {
      if (cursor) {
        if (seen.has(cursor)) throw new Error(`list pagination cursor repeated: ${cursor}`);
        seen.add(cursor);
      }
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await fetch(`${this.#url("list")}${qs}`, { headers: this.#headers() });
      await assertAuthed(res, "list failed");
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const body = (await res.json()) as { entries: RemoteEntry[]; nextCursor?: string | null };
      entries.push(...body.entries);
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
    return entries;
  }

  /**
   * Incremental change feed: events with seq > sinceSeq (ascending), plus the
   * workspace `head` so the caller knows when it is caught up. Pass sinceSeq=0
   * to read from the beginning.
   */
  async changes(sinceSeq: number, limit?: number): Promise<ChangesPage> {
    const qs = new URLSearchParams({ sinceSeq: String(sinceSeq) });
    if (limit !== undefined) qs.set("limit", String(limit));
    const res = await fetch(`${this.#url("changes")}?${qs}`, { headers: this.#headers() });
    await assertAuthed(res, "changes failed");
    if (!res.ok) throw new Error(`changes failed: ${res.status}`);
    return (await res.json()) as ChangesPage;
  }

  /**
   * A file's current version and its contents as a stream, so a large file is
   * written to disk as it arrives rather than held in memory first.
   */
  async get(path: string): Promise<{ body: ByteStream; version: number } | null> {
    // Opt in to downloading from the byte Worker. The server then answers 307
    // with a self-contained grant URL, followed without the API key.
    const { res, fromApi } = await getFollowing(
      this.#url(`files/${encodePath(path)}`),
      new URL(this.#cfg.apiBase).origin,
      this.#headers({ "x-treehouse-byte-redirect": "1" }),
    );
    // Not-found and auth failures are the API's verdicts. From anywhere else
    // (the Worker, with a blob gone missing) they are errors, never "the file
    // was deleted" or "the key was revoked".
    if (fromApi && res.status === 404) return null;
    if (fromApi) await assertAuthed(res, `get ${path} failed`);
    if (!res.ok) throw new Error(`get ${path} failed: ${res.status}`);
    // Prefer the explicit version header: a CDN in front of the API may weaken
    // the ETag to W/"1" (handled below) or strip it altogether — Cloudflare does
    // — and a stripped ETag fails EVERY pull, so the folder never syncs. The
    // ETag path stays as the fallback for servers that predate the header.
    const explicit = res.headers.get("x-treehouse-version");
    const etag = res.headers.get("etag");
    const raw = explicit ?? etag?.replace(/^W\//, "").replace(/"/g, "");
    const version = raw !== undefined && raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
    // A missing/unparseable version must not silently become 0, which would
    // poison the index and make every later push 412 forever.
    if (!Number.isInteger(version) || version < 1) {
      await res.body?.cancel();
      throw new Error(
        `get ${path}: no usable version header (x-treehouse-version: ${explicit ?? "none"}, ` +
          `etag: ${etag ?? "none"}) — a proxy in front of the API may be stripping them`,
      );
    }
    return { body: (res.body ?? once(new Uint8Array(0))) as ByteStream, version };
  }

  /**
   * Write a file. `body` is bytes in memory or a stream; a stream is sent as it
   * is read (chunked), so uploading a large file holds one piece at a time.
   */
  async put(
    path: string,
    content: Uint8Array | ByteStream,
    opts: { create: true } | { baseVersion: number },
    contentType: string,
  ): Promise<PutOk | PutConflict | PutForbidden | PutRefused> {
    const precondition: Record<string, string> =
      "create" in opts ? { "if-none-match": "*" } : { "if-match": `"${opts.baseVersion}"` };
    const url = this.#url(`files/${encodePath(path)}`);
    const headers = this.#headers({ "content-type": contentType, ...precondition });
    const res =
      content instanceof Uint8Array
        ? await fetch(url, { method: "PUT", headers, body: content as unknown as BodyInit })
        : await streamingPut(url, headers, content);
    // 404 on a write means the path is private to another member (no existence
    // disclosure). Surface it as a typed forbidden result so the sync drops the
    // local copy instead of throwing and aborting the whole pass.
    if (res.status === 404) return { ok: false, forbidden: true };
    const refused = await readOnlyReason(res);
    if (refused) return { ok: false, refused };
    await assertAuthed(res, `put ${path} failed`);
    if (res.status === 412) {
      const body = (await res.json()) as {
        current_version: number | null;
        conflict_copy_path: string;
      };
      return {
        ok: false,
        conflict: true,
        currentVersion: body.current_version,
        conflictCopyPath: body.conflict_copy_path,
      };
    }
    if (res.status === 507) throw await storageLimitError(path, res);
    if (!res.ok) throw new Error(`put ${path} failed: ${res.status}`);
    const body = (await res.json()) as { version: number };
    return { ok: true, version: body.version };
  }

  async delete(
    path: string,
    baseVersion: number,
  ): Promise<"ok" | "conflict" | "not_found" | PutRefused> {
    const res = await fetch(this.#url(`files/${encodePath(path)}`), {
      method: "DELETE",
      headers: this.#headers({ "if-match": `"${baseVersion}"` }),
    });
    if (res.status === 404) return "not_found";
    if (res.status === 412) return "conflict";
    const refused = await readOnlyReason(res);
    if (refused) return { ok: false, refused };
    await assertAuthed(res, `delete ${path} failed`);
    if (!res.ok) throw new Error(`delete ${path} failed: ${res.status}`);
    return "ok";
  }
}