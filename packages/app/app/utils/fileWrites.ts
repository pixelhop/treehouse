// Pure helpers for the file write/delete path: build the conditional-request
// headers and map the server's status+body into typed results. Kept separate
// from useTreehouseApi's $fetch wiring so the version-CAS / conflict logic — the
// part that's easy to get subtly wrong — is unit-testable without a network.
//
// Contract (see packages/api/.../files/[...path].{put,delete}.ts):
//   PUT  If-None-Match: *   -> create-only        (201 created, 200 updated)
//        If-Match: "<n>"    -> compare-and-swap    (412 on stale)
//        412 body: { current_version, conflict_copy_path }
//   DELETE If-Match: "<n>"  (required)             (204 ok, 412 stale, 404 gone)
import { contentTypeFor } from "shared";

export interface WriteOk {
  ok: true;
  version: number;
  /** 201 (new file) vs 200 (updated existing). */
  created: boolean;
}
export interface WriteConflict {
  ok: false;
  conflict: true;
  currentVersion: number | null;
  /** Where the server stashed the rejected bytes (never lost). */
  conflictCopyPath?: string;
}
export type WriteResult = WriteOk | WriteConflict;

export interface DeleteOk {
  ok: true;
}
export interface DeleteConflict {
  ok: false;
  conflict: true;
  currentVersion: number | null;
}
export interface DeleteNotFound {
  ok: false;
  notFound: true;
}
export type DeleteResult = DeleteOk | DeleteConflict | DeleteNotFound;

interface WriteResponseBody {
  version?: number;
  current_version?: number | null;
  conflict_copy_path?: string;
}

export interface WriteHeaderOpts {
  path: string;
  /** Create-only (If-None-Match: *). Mutually exclusive with baseVersion. */
  create?: boolean;
  /** Compare-and-swap against this version (If-Match). */
  baseVersion?: number;
  /** Override the content-type; defaults to the extension mapping. */
  contentType?: string;
}

/**
 * Build the headers for a conditional PUT. `create` sends If-None-Match:* so the
 * write only succeeds if the path is new; otherwise a defined `baseVersion`
 * sends If-Match for compare-and-swap. With neither, no conditional header is
 * sent and the server returns 428 if the path already exists.
 */
export function writeHeaders(opts: WriteHeaderOpts): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType || contentTypeFor(opts.path),
  };
  if (opts.create) {
    headers["if-none-match"] = "*";
  } else if (opts.baseVersion !== undefined) {
    headers["if-match"] = `"${opts.baseVersion}"`;
  }
  return headers;
}

/** Map a PUT response (status + parsed body) into a typed write result. */
export function parseWriteResponse(status: number, body: WriteResponseBody | null): WriteResult {
  if (status === 200 || status === 201) {
    return { ok: true, version: body?.version ?? 0, created: status === 201 };
  }
  if (status === 412) {
    return {
      ok: false,
      conflict: true,
      currentVersion: body?.current_version ?? null,
      conflictCopyPath: body?.conflict_copy_path,
    };
  }
  throw new Error(`Unexpected write status ${status}`);
}

/** Map a DELETE response (status + parsed body) into a typed delete result. */
export function parseDeleteResponse(status: number, body: WriteResponseBody | null): DeleteResult {
  if (status === 204) return { ok: true };
  if (status === 412) {
    return { ok: false, conflict: true, currentVersion: body?.current_version ?? null };
  }
  if (status === 404) return { ok: false, notFound: true };
  throw new Error(`Unexpected delete status ${status}`);
}