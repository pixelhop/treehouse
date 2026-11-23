// HTTP byte ranges (RFC 9110 §14) for serving file bytes. Only single ranges
// are supported: a request for several falls back to the whole file, which the
// RFC allows and which is all a media element or a resumed download asks for.

/** A range as asked for, before the file's size is known. */
export type RangeRequest = { start: number; end?: number } | { suffix: number };

/** A satisfiable range, inclusive at both ends. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a `Range` header. Returns null when it should be ignored — absent, a
 * unit other than bytes, several ranges, or syntax the RFC says to ignore — in
 * which case the whole file is served with 200.
 */
export function parseRangeHeader(header: string | undefined | null): RangeRequest | null {
  if (!header) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;
  if (first === "") return { suffix: Number(last) };
  const start = Number(first);
  if (last === "") return { start };
  const end = Number(last);
  if (end < start) return null;
  return { start, end };
}

/**
 * The range to serve given a request's `Range` and `If-Range` headers. When
 * `If-Range` names a different validator than `etag`, the client's partial copy
 * is stale and it gets the whole file instead (RFC 9110 §13.1.5). A null etag
 * (a response that carries none) matches no If-Range at all.
 */
export function conditionalRange(
  rangeHeader: string | undefined | null,
  ifRange: string | undefined | null,
  etag: string | null,
): RangeRequest | undefined {
  const range = parseRangeHeader(rangeHeader);
  if (!range) return undefined;
  if (ifRange && ifRange !== etag) return undefined;
  return range;
}

/** Resolve a range against a file's size, or say it can't be satisfied (416). */
export function resolveRange(req: RangeRequest, size: number): ByteRange | "unsatisfiable" {
  if ("suffix" in req) {
    if (req.suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - req.suffix), end: size - 1 };
  }
  if (req.start >= size) return "unsatisfiable";
  return { start: req.start, end: Math.min(req.end ?? size - 1, size - 1) };
}

/** The `Range` header for a request to an S3-compatible store. */
export function rangeHeaderFor(req: RangeRequest): string {
  if ("suffix" in req) return `bytes=-${req.suffix}`;
  return `bytes=${req.start}-${req.end ?? ""}`;
}

/** The `Content-Range` value for a 206, or for a 416 when `range` is null. */
export function contentRange(range: ByteRange | null, size: number): string {
  return range ? `bytes ${range.start}-${range.end}/${size}` : `bytes */${size}`;
}