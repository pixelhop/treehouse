import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { HEADER_BYTES } from "./blob-crypto";
import { buildKeyRing, type KeyRing } from "./key-ring";

// ---------------------------------------------------------------------------
// Grants: how the API hands one blob to the byte Worker.
//
// The API authorises a read, derives the per-blob key itself, and sends the
// client to the Worker with a grant in the URL. The Worker holds no KEK and no
// workspace DEK; the grant carries the one key that opens the one blob. So the
// grant is ENCRYPTED and authenticated (AES-256-GCM under a secret only the API
// and the Worker share), not merely signed: it travels in a URL, and a leaked
// grant must expose one blob until it expires, never a workspace.
//
// Wire format: `<keyId>.<base64url(nonce || ciphertext || tag)>`. The key id
// says which ring entry sealed it, so the secret can be rotated (see
// docs/solutions/developer-experience/blob-worker-byte-path.md).
//
// Grants are DETERMINISTIC: the nonce is an HMAC of the payload under a key of
// its own, so the same file asked for within one expiry step yields the same
// URL. That is what lets a browser's cache of the Worker's response survive a
// fresh redirect (an image in a markdown document revalidates with a 304
// instead of downloading again). A PRF-derived nonce only repeats for an
// identical payload, which seals to an identical token, so nothing leaks
// beyond "these two URLs are the same grant".
//
// Usage reports (the Worker telling the API how many bytes a share link sent)
// use the same keys under a separate purpose label and a random nonce, so a
// grant can never be replayed as a report or the reverse.
// ---------------------------------------------------------------------------

const GRANT_PURPOSE = "treehouse-blob-grant-v1";
const USAGE_PURPOSE = "treehouse-blob-usage-v1";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BLOB_KEY_BYTES = 32;

/** Long enough for a feature-length video to be paused and seeked; see the doc. */
export const GRANT_TTL_SECONDS = 4 * 60 * 60;
/** Expiries are rounded up to this step so repeat reads share one URL. */
export const GRANT_EXPIRY_STEP_SECONDS = 15 * 60;
/** A report older or newer than this is refused. */
const USAGE_REPORT_SKEW_SECONDS = 10 * 60;
/** Far above any real grant (a long filename is the largest part). */
const MAX_TOKEN_CHARS = 8192;

/** Key ids travel in URLs, so they are restricted to URL-safe characters. */
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The response headers a grant may carry: exactly the ones the API's routes
 * set on a byte response. Transport headers (length, range, CORS) are the
 * Worker's own. An allowlist rather than a free map, so a grant can never be
 * used to set something like Set-Cookie or Location on the Worker's origin.
 */
const GRANT_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-security-policy",
  "content-type",
  "x-content-type-options",
  "x-treehouse-content-hash",
  "x-treehouse-version",
]);

/** Everything the Worker needs to serve one blob exactly as the API would. */
export interface BlobGrant {
  workspaceId: string;
  contentHash: string;
  /** Plaintext size. With the header, this fixes the stored layout. */
  size: number;
  /** The blob's 52-byte header, which the key was derived from. */
  header: Uint8Array;
  /** The per-blob key (see deriveBlobKey). */
  key: Uint8Array;
  /** The validator to emit and to judge If-None-Match / If-Range by; null for none. */
  etag: string | null;
  /** Response headers, lower-case names, from GRANT_HEADERS. */
  headers: Record<string, string>;
  /** Unix seconds. */
  expiresAt: number;
  /** Report the bytes actually sent back to the API (public share links). */
  meter: boolean;
}

export interface UsageReport {
  workspaceId: string;
  bytes: number;
  /** Unix seconds when the Worker finished sending. */
  at: number;
}

/**
 * The grant key ring from `BLOB_WORKER_TOKEN_KEY` (active) and
 * `BLOB_WORKER_TOKEN_KEY_RETIRED` (comma-separated, still accepted), as the API
 * and the Worker both read them. Null when no active key is set. Throws on a
 * malformed value, naming the variable, rather than quietly turning the byte
 * path off.
 */
export function grantKeyRing(
  active: string | undefined,
  retired: string | undefined,
): KeyRing | null {
  if (!active?.trim()) return null;
  const ring = buildKeyRing(active, retired, (which) => {
    const name = which === "active" ? "BLOB_WORKER_TOKEN_KEY" : "BLOB_WORKER_TOKEN_KEY_RETIRED";
    return new Error(
      `${name} is malformed. Expected \`<id>:<base64>\` entries whose keys decode to 32 bytes. ` +
        'Generate one with: printf "t1:$(openssl rand -base64 32)"',
    );
  });
  for (const id of ring.byId.keys()) {
    if (!KEY_ID.test(id)) {
      throw new Error(`grant key id ${JSON.stringify(id)} must match ${KEY_ID.source}`);
    }
  }
  return ring;
}

/** The expiry for a grant minted now: at least the TTL away, rounded up to a step. */
export function grantExpiry(nowSeconds: number): number {
  const earliest = nowSeconds + GRANT_TTL_SECONDS;
  return Math.ceil(earliest / GRANT_EXPIRY_STEP_SECONDS) * GRANT_EXPIRY_STEP_SECONDS;
}

function subkey(secret: Uint8Array, purpose: string, use: "enc" | "nonce"): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, new Uint8Array(0), `${purpose}|${use}`, 32));
}

function seal(
  ring: KeyRing,
  purpose: string,
  payload: unknown,
  nonceMode: "deterministic" | "random",
): string {
  const { id, key } = ring.active;
  const aad = Buffer.from(`${purpose}|${id}`, "utf8");
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const nonce =
    nonceMode === "random"
      ? randomBytes(NONCE_BYTES)
      : createHmac("sha256", subkey(key, purpose, "nonce"))
          .update(aad)
          .update(plain)
          .digest()
          .subarray(0, NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", subkey(key, purpose, "enc"), nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return `${id}.${body.toString("base64url")}`;
}

/** The JSON a token carries, or null for anything that does not open. Never throws. */
function open(ring: KeyRing, purpose: string, token: string): unknown {
  if (token.length > MAX_TOKEN_CHARS) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const secret = ring.byId.get(id);
  if (!secret) return null;
  const encoded = token.slice(dot + 1);
  const body = Buffer.from(encoded, "base64url");
  // Buffer's decoder skips junk and ignores unused trailing bits, so only the
  // canonical spelling of a body is accepted: one grant, one URL.
  if (body.byteLength < NONCE_BYTES + TAG_BYTES || body.toString("base64url") !== encoded) {
    return null;
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      subkey(secret, purpose, "enc"),
      body.subarray(0, NONCE_BYTES),
    );
    decipher.setAAD(Buffer.from(`${purpose}|${id}`, "utf8"));
    decipher.setAuthTag(body.subarray(body.byteLength - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(body.subarray(NONCE_BYTES, body.byteLength - TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

interface GrantWire {
  ws: string;
  h: string;
  n: number;
  hd: string;
  k: string;
  e: string | null;
  hs: Record<string, string>;
  x: number;
  m: boolean;
}

function assertHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!GRANT_HEADERS.has(name)) throw new Error(`grant may not carry header ${name}`);
    if (/[\r\n]/.test(value)) throw new Error(`grant header ${name} contains a line break`);
  }
}

/**
 * A grant too long for the Worker to accept (a very long file name in the
 * download disposition is the realistic cause). Not a bug: serve directly.
 */
export class GrantTooLargeError extends Error {
  constructor(length: number) {
    super(`grant is ${length} characters, over the ${MAX_TOKEN_CHARS} the Worker accepts`);
    this.name = "GrantTooLargeError";
  }
}

/**
 * Seal a grant for the Worker. Throws on a grant that could never be served,
 * and GrantTooLargeError on one the Worker would refuse for its length.
 */
export function mintGrant(ring: KeyRing, grant: BlobGrant): string {
  if (grant.header.byteLength !== HEADER_BYTES) throw new Error("grant header has the wrong size");
  if (grant.key.byteLength !== BLOB_KEY_BYTES) throw new Error("grant key has the wrong size");
  if (!Number.isSafeInteger(grant.size) || grant.size < 0) throw new Error("grant size is invalid");
  assertHeaders(grant.headers);
  const wire: GrantWire = {
    ws: grant.workspaceId,
    h: grant.contentHash,
    n: grant.size,
    hd: Buffer.from(grant.header).toString("base64"),
    k: Buffer.from(grant.key).toString("base64"),
    e: grant.etag,
    hs: grant.headers,
    x: grant.expiresAt,
    m: grant.meter,
  };
  const token = seal(ring, GRANT_PURPOSE, wire, "deterministic");
  // The Worker refuses anything longer, so a grant that size could only ever
  // become a 403 after the redirect. The caller serves those bytes itself.
  if (token.length > MAX_TOKEN_CHARS) throw new GrantTooLargeError(token.length);
  return token;
}

const isString = (v: unknown): v is string => typeof v === "string";

function bytesOf(value: unknown, length: number): Uint8Array | null {
  if (!isString(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === length ? new Uint8Array(bytes) : null;
}

function headersOf(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) {
    if (!GRANT_HEADERS.has(name) || !isString(v) || /[\r\n]/.test(v)) return null;
    out[name] = v;
  }
  return out;
}

/** The grant a token carries, or null when it is malformed, forged, unknown or expired. */
export function openGrant(ring: KeyRing, token: string, nowSeconds: number): BlobGrant | null {
  const wire = open(ring, GRANT_PURPOSE, token) as Partial<GrantWire> | null;
  if (!wire || typeof wire !== "object") return null;
  const header = bytesOf(wire.hd, HEADER_BYTES);
  const key = bytesOf(wire.k, BLOB_KEY_BYTES);
  const headers = headersOf(wire.hs);
  const valid =
    isString(wire.ws) &&
    isString(wire.h) &&
    Number.isSafeInteger(wire.n) &&
    (wire.n as number) >= 0 &&
    (wire.e === null || isString(wire.e)) &&
    Number.isSafeInteger(wire.x) &&
    typeof wire.m === "boolean";
  if (!valid || !header || !key || !headers) return null;
  if ((wire.x as number) <= nowSeconds) return null;
  return {
    workspaceId: wire.ws as string,
    contentHash: wire.h as string,
    size: wire.n as number,
    header,
    key,
    etag: wire.e as string | null,
    headers,
    expiresAt: wire.x as number,
    meter: wire.m as boolean,
  };
}

/** Seal a usage report for the API. A random nonce: two equal reports are two sends. */
export function sealUsageReport(ring: KeyRing, report: UsageReport): string {
  return seal(ring, USAGE_PURPOSE, report, "random");
}

/** The report a sealed body carries, or null when it is forged, malformed or stale. */
export function openUsageReport(
  ring: KeyRing,
  sealed: string,
  nowSeconds: number,
): UsageReport | null {
  const r = open(ring, USAGE_PURPOSE, sealed) as Partial<UsageReport> | null;
  if (!r || typeof r !== "object") return null;
  if (!isString(r.workspaceId) || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 0) {
    return null;
  }
  if (!Number.isSafeInteger(r.at)) return null;
  if (Math.abs((r.at as number) - nowSeconds) > USAGE_REPORT_SKEW_SECONDS) return null;
  return { workspaceId: r.workspaceId, bytes: r.bytes as number, at: r.at as number };
}