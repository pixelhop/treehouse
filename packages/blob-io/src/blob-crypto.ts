import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { exactSlices } from "./byte-stream";

// ---------------------------------------------------------------------------
// Chunked authenticated encryption for stored file bytes.
//
// The layout follows Tink's AES-GCM-HKDF streaming construction: a cleartext
// header, then fixed-size chunks each sealed independently with AES-256-GCM.
// Only the framing lives here — the primitives are Node's. Four properties are
// load-bearing, and every one of them is a test in blob-crypto.test.ts:
//
//   * a per-BLOB key is derived from the workspace DEK and a random salt, so
//     the DEK is never used directly as a GCM key across many blobs and the
//     nonce-collision question never arises;
//   * the chunk counter is bound into each nonce, so reordering or duplicating
//     chunks fails authentication;
//   * the last chunk is sealed under a distinct final flag, so truncating the
//     stream fails authentication rather than silently returning a prefix;
//   * the header is authenticated as AAD, so tampering with the salt, chunk
//     size, or key generation fails authentication.
//
// The derivation is additionally bound to (workspaceId, contentHash), which
// makes a blob cryptographically non-portable: an attacker with bucket WRITE
// access cannot move one workspace's ciphertext into another's key namespace
// and have it decrypt.
// ---------------------------------------------------------------------------

/** "THE\0" — a NUL in the marker keeps it out of plausible text-file prefixes. */
const MAGIC = Uint8Array.from([0x54, 0x48, 0x45, 0x00]);
const FORMAT_VERSION = 1;

const SALT_BYTES = 32;
const NONCE_PREFIX_BYTES = 7;
const COUNTER_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

const OFF_VERSION = MAGIC.byteLength;
const OFF_KEY_GENERATION = OFF_VERSION + 1;
const OFF_CHUNK_SIZE = OFF_KEY_GENERATION + 4;
const OFF_SALT = OFF_CHUNK_SIZE + 4;
const OFF_NONCE_PREFIX = OFF_SALT + SALT_BYTES;

/** Total size of the cleartext header that prefixes every encrypted blob. */
export const HEADER_BYTES = OFF_NONCE_PREFIX + NONCE_PREFIX_BYTES;

/** Plaintext bytes per chunk. 1 MiB balances framing overhead against buffering. */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** Sanity ceiling used both when encrypting and when validating a stored header. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** The counter is a uint32, so this is the framing limit, not a policy limit. */
const MAX_CHUNKS = 0xffff_ffff;

/**
 * A stored blob could not be authenticated or decrypted. Distinct from "the
 * blob is absent" — callers must not collapse the two, or a tampered object
 * reads as ordinary data loss.
 */
export class BlobDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BlobDecryptError";
  }
}

export interface EncryptContext {
  workspaceId: string;
  contentHash: string;
  /** Stamped into the header so a future DEK rotation can leave old blobs readable. */
  keyGeneration?: number;
  chunkSize?: number;
}

export interface DecryptContext {
  workspaceId: string;
  contentHash: string;
}

function assertDek(dek: Uint8Array): void {
  if (dek.byteLength !== DEK_BYTES) {
    throw new Error(`data key must be ${DEK_BYTES} bytes, got ${dek.byteLength}`);
  }
}

/**
 * Length-prefix the context so it cannot be ambiguous: without it, a workspace
 * id containing the delimiter could produce the same derivation as a different
 * (workspaceId, contentHash) pair.
 */
function derivationInfo(workspaceId: string, contentHash: string): Buffer {
  return Buffer.from(
    `treehouse-blob-v1|${workspaceId.length}:${workspaceId}|${contentHash.length}:${contentHash}`,
    "utf8",
  );
}

function deriveKey(
  dek: Uint8Array,
  salt: Uint8Array,
  workspaceId: string,
  contentHash: string,
): Uint8Array {
  const info = derivationInfo(workspaceId, contentHash);
  return new Uint8Array(hkdfSync("sha256", dek, salt, info, DEK_BYTES));
}

function nonceFor(prefix: Uint8Array, counter: number, isFinal: boolean): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(NONCE_PREFIX_BYTES, counter, false);
  nonce[NONCE_PREFIX_BYTES + COUNTER_BYTES] = isFinal ? 1 : 0;
  return nonce;
}

interface Header {
  keyGeneration: number;
  chunkSize: number;
  salt: Uint8Array;
  noncePrefix: Uint8Array;
}

function buildHeader(h: Header): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[OFF_VERSION] = FORMAT_VERSION;
  const view = new DataView(header.buffer);
  view.setUint32(OFF_KEY_GENERATION, h.keyGeneration, false);
  view.setUint32(OFF_CHUNK_SIZE, h.chunkSize, false);
  header.set(h.salt, OFF_SALT);
  header.set(h.noncePrefix, OFF_NONCE_PREFIX);
  return header;
}

/**
 * Parse and structurally validate a header, or return null if these bytes are
 * not a well-formed encrypted blob. Never throws — `isEncryptedBlob` and the
 * decrypt path both need a total answer.
 *
 * `storedSize` is the length of the whole stored object, which may be longer
 * than `stored` when only the header prefix has been fetched (a ranged read).
 */
function parseHeader(stored: Uint8Array, storedSize = stored.byteLength): Header | null {
  // A valid blob is a header plus at least one sealed chunk; an empty file
  // still carries one (whose plaintext is empty but whose tag is not).
  if (storedSize < HEADER_BYTES + TAG_BYTES || stored.byteLength < HEADER_BYTES) return null;
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (stored[i] !== MAGIC[i]) return null;
  }
  if (stored[OFF_VERSION] !== FORMAT_VERSION) return null;

  const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  const chunkSize = view.getUint32(OFF_CHUNK_SIZE, false);
  if (chunkSize === 0 || chunkSize > MAX_CHUNK_BYTES) return null;

  return {
    keyGeneration: view.getUint32(OFF_KEY_GENERATION, false),
    chunkSize,
    salt: stored.subarray(OFF_SALT, OFF_SALT + SALT_BYTES),
    noncePrefix: stored.subarray(OFF_NONCE_PREFIX, HEADER_BYTES),
  };
}

/**
 * The data-key generation a stored blob's header names, or null when these
 * bytes are not a well-formed header. Reads use it to pick the key a blob was
 * sealed under, so a rotation can leave older blobs readable while it works.
 * `storedSize` is the length of the whole stored object, as for parseHeader.
 */
export function headerGeneration(prefix: Uint8Array, storedSize: number): number | null {
  return parseHeader(prefix, storedSize)?.keyGeneration ?? null;
}

function hasMagic(stored: Uint8Array): boolean {
  if (stored.byteLength < MAGIC.byteLength) return false;
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (stored[i] !== MAGIC[i]) return false;
  }
  return true;
}

/**
 * What a stored object is.
 *
 * The three-way split matters, and collapsing `malformed` into `legacy` is a
 * real vulnerability rather than a tidiness question: bytes that carry the
 * marker but fail the version or chunk-size check would then be handed back to
 * the caller verbatim as file content, so flipping a single bit in the version
 * field (offset 4) would make the read path serve raw ciphertext with no tag
 * ever checked. Once the marker matches, these bytes are ours and the only
 * honest outcomes are "decrypt it" or "fail".
 *
 * `malformed` also covers a blob written by a NEWER format version and read by
 * a rolled-back deployment, which must fail loudly rather than leak ciphertext.
 */
export type BlobKind = "encrypted" | "legacy" | "malformed";

export function classifyBlob(stored: Uint8Array): BlobKind {
  if (!hasMagic(stored)) return "legacy";
  return parseHeader(stored) ? "encrypted" : "malformed";
}

/**
 * `classifyBlob` for a ranged read: classify a stored object from its first
 * `HEADER_BYTES` (or fewer, for a tiny object) and its total stored size,
 * without fetching the rest.
 */
export function classifyBlobPrefix(prefix: Uint8Array, storedSize: number): BlobKind {
  if (!hasMagic(prefix)) return "legacy";
  return parseHeader(prefix, storedSize) ? "encrypted" : "malformed";
}

/**
 * Where each chunk of an encrypted blob sits, worked out from its header and
 * stored size alone. This is what lets a ranged read fetch only the frames
 * covering the bytes asked for.
 */
export interface EncryptedLayout {
  /** Length of the whole stored object. */
  storedSize: number;
  /** Plaintext bytes per chunk (the last chunk may hold fewer). */
  chunkSize: number;
  chunkCount: number;
  plaintextSize: number;
  /** Byte offset of chunk `i`'s frame (ciphertext plus tag) in the stored object. */
  frameOffset(i: number): number;
  /** Stored length of chunk `i`'s frame. */
  frameLength(i: number): number;
}

/** The layout of an encrypted blob, or null if its size can't be one. */
export function encryptedLayout(prefix: Uint8Array, storedSize: number): EncryptedLayout | null {
  const header = parseHeader(prefix, storedSize);
  if (!header) return null;
  const framed = header.chunkSize + TAG_BYTES;
  const body = storedSize - HEADER_BYTES;
  // Mirrors decryptBlob's walk: every frame but the last is full, and the last
  // is whatever remains, which must still hold a tag.
  const chunkCount = Math.ceil(body / framed);
  const lastFrame = body - (chunkCount - 1) * framed;
  if (chunkCount < 1 || lastFrame < TAG_BYTES || chunkCount - 1 > MAX_CHUNKS) return null;
  return {
    storedSize,
    chunkSize: header.chunkSize,
    chunkCount,
    plaintextSize: body - chunkCount * TAG_BYTES,
    frameOffset: (i) => HEADER_BYTES + i * framed,
    frameLength: (i) => (i === chunkCount - 1 ? lastFrame : framed),
  };
}

/**
 * The layout of an encrypted blob from its header and PLAINTEXT size, for a
 * reader that knows the file's size but has not asked storage for the object's
 * (the byte Worker, which is told both by the API). Null when they disagree.
 */
export function sealedLayout(header: Uint8Array, plaintextSize: number): EncryptedLayout | null {
  const parsed = parseHeader(header, HEADER_BYTES + TAG_BYTES);
  if (!parsed || !Number.isSafeInteger(plaintextSize) || plaintextSize < 0) return null;
  const layout = encryptedLayout(header, encryptedSize(plaintextSize, parsed.chunkSize));
  return layout?.plaintextSize === plaintextSize ? layout : null;
}

/** Stored size of a `plaintextSize`-byte blob once sealed. */
export function encryptedSize(plaintextSize: number, chunkSize = DEFAULT_CHUNK_BYTES): number {
  return (
    HEADER_BYTES + plaintextSize + Math.max(1, Math.ceil(plaintextSize / chunkSize)) * TAG_BYTES
  );
}

function* repeatLengths(total: number, chunkSize: number): Generator<number> {
  const count = Math.max(1, Math.ceil(total / chunkSize));
  for (let i = 0; i < count; i++) yield Math.min(chunkSize, total - i * chunkSize);
}

/**
 * Streaming `encryptBlob`: seals `source`, which must be exactly `size` bytes,
 * yielding the header and then one sealed frame per chunk. The output is
 * byte-for-byte the format `decryptBlob` reads, so a blob written this way and
 * one written whole are interchangeable. Memory is one chunk at a time.
 *
 * The size has to be known up front because the last chunk is sealed under a
 * distinct final flag; callers spool the body first anyway, to learn the
 * content hash the key is derived from.
 */
export async function* encryptChunks(
  source: AsyncIterable<Uint8Array>,
  size: number,
  dek: Uint8Array,
  ctx: EncryptContext,
): AsyncGenerator<Uint8Array> {
  assertDek(dek);
  const chunkSize = ctx.chunkSize ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_BYTES) {
    throw new Error(`chunk size must be a positive integer up to ${MAX_CHUNK_BYTES}`);
  }
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("size must be a non-negative integer");
  const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
  if (chunkCount > MAX_CHUNKS) {
    throw new Error("payload exceeds the maximum number of chunks for this format");
  }

  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const noncePrefix = new Uint8Array(randomBytes(NONCE_PREFIX_BYTES));
  const header = buildHeader({
    keyGeneration: ctx.keyGeneration ?? 1,
    chunkSize,
    salt,
    noncePrefix,
  });
  const key = deriveKey(dek, salt, ctx.workspaceId, ctx.contentHash);
  yield header;

  let i = 0;
  const slices = exactSlices(source, repeatLengths(size, chunkSize), (m) => new Error(m));
  for await (const slice of slices) {
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      nonceFor(noncePrefix, i, i === chunkCount - 1),
    );
    cipher.setAAD(header);
    yield new Uint8Array(
      Buffer.concat([cipher.update(slice), cipher.final(), cipher.getAuthTag()]),
    );
    i++;
  }
}

/**
 * The key one blob's chunks are sealed under, derived from the workspace DEK
 * and the salt in that blob's header. It opens exactly one blob: a different
 * salt, workspace or content hash derives a different key. That is what makes
 * it safe to hand to the byte Worker, which must never hold a DEK.
 */
export function deriveBlobKey(
  dek: Uint8Array,
  headerBytes: Uint8Array,
  ctx: DecryptContext,
): Uint8Array {
  assertDek(dek);
  const header = parseHeader(headerBytes, HEADER_BYTES + TAG_BYTES);
  if (!header) throw new BlobDecryptError("stored blob is not a well-formed encrypted blob");
  return deriveKey(dek, header.salt, ctx.workspaceId, ctx.contentHash);
}

/**
 * Which chunks cover a plaintext byte range, where their frames sit in the
 * stored object, and how much of the decrypted chunks to drop and keep. A null
 * range is the whole blob (including an empty one, which still has one chunk).
 */
export interface FrameSpan {
  first: number;
  last: number;
  /** Stored byte offsets of the frames, inclusive at both ends. */
  storedStart: number;
  storedEnd: number;
  /** Plaintext bytes to skip at the front of chunk `first`. */
  skip: number;
  /** Plaintext bytes to keep after skipping. */
  take: number;
}

export function frameSpan(
  layout: EncryptedLayout,
  range: { start: number; end: number } | null,
): FrameSpan {
  const first = range ? Math.floor(range.start / layout.chunkSize) : 0;
  const last = range ? Math.floor(range.end / layout.chunkSize) : layout.chunkCount - 1;
  return {
    first,
    last,
    storedStart: layout.frameOffset(first),
    storedEnd: layout.frameOffset(last) + layout.frameLength(last) - 1,
    skip: range ? range.start - first * layout.chunkSize : 0,
    take: range ? range.end - range.start + 1 : layout.plaintextSize,
  };
}

/**
 * Decrypt chunks `first`..`last` (inclusive) of an encrypted blob, given its
 * header bytes and a stream of exactly those chunks' frames. Each chunk is
 * authenticated before its plaintext is yielded, so nothing unverified ever
 * leaves this function. Bound to the same (workspaceId, contentHash) context as
 * `decryptBlob`.
 */
export async function* decryptFrames(
  headerBytes: Uint8Array,
  layout: EncryptedLayout,
  first: number,
  last: number,
  frames: AsyncIterable<Uint8Array>,
  dek: Uint8Array,
  ctx: DecryptContext,
): AsyncGenerator<Uint8Array> {
  assertDek(dek);
  const header = parseHeader(headerBytes, layout.storedSize);
  if (!header) throw new BlobDecryptError("stored blob is not a well-formed encrypted blob");
  const key = deriveKey(dek, header.salt, ctx.workspaceId, ctx.contentHash);
  yield* openFrames(headerBytes, layout, first, last, frames, key);
}

/**
 * `decryptFrames` under a per-blob key already derived (see `deriveBlobKey`).
 * The byte Worker's way in: it is handed the key for one blob, never the DEK.
 */
export async function* openFrames(
  headerBytes: Uint8Array,
  layout: EncryptedLayout,
  first: number,
  last: number,
  frames: AsyncIterable<Uint8Array>,
  key: Uint8Array,
): AsyncGenerator<Uint8Array> {
  const header = parseHeader(headerBytes, layout.storedSize);
  if (!header) throw new BlobDecryptError("stored blob is not a well-formed encrypted blob");
  if (key.byteLength !== DEK_BYTES) throw new BlobDecryptError("blob key has the wrong length");
  if (first < 0 || last >= layout.chunkCount || first > last) {
    throw new RangeError("chunk range is outside the blob");
  }
  const aad = headerBytes.subarray(0, HEADER_BYTES);

  function* lengths(): Generator<number> {
    for (let i = first; i <= last; i++) yield layout.frameLength(i);
  }
  let counter = first;
  for await (const frame of exactSlices(frames, lengths(), (m) => new BlobDecryptError(m))) {
    const isFinal = counter === layout.chunkCount - 1;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      nonceFor(header.noncePrefix, counter, isFinal),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(frame.subarray(frame.byteLength - TAG_BYTES));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(frame.subarray(0, frame.byteLength - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch (cause) {
      throw new BlobDecryptError(`chunk ${counter} failed authentication`, { cause });
    }
    yield new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength);
    counter++;
  }
}

export function encryptBlob(
  plaintext: Uint8Array,
  dek: Uint8Array,
  ctx: EncryptContext,
): Uint8Array {
  assertDek(dek);
  const chunkSize = ctx.chunkSize ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_BYTES) {
    throw new Error(`chunk size must be a positive integer up to ${MAX_CHUNK_BYTES}`);
  }
  const keyGeneration = ctx.keyGeneration ?? 1;

  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const noncePrefix = new Uint8Array(randomBytes(NONCE_PREFIX_BYTES));
  const header = buildHeader({ keyGeneration, chunkSize, salt, noncePrefix });
  const key = deriveKey(dek, salt, ctx.workspaceId, ctx.contentHash);

  // An empty file still gets one (empty, authenticated) chunk, so that
  // truncating it to nothing remains detectable.
  const chunkCount = Math.max(1, Math.ceil(plaintext.byteLength / chunkSize));
  if (chunkCount > MAX_CHUNKS) {
    throw new Error("payload exceeds the maximum number of chunks for this format");
  }

  const parts: Uint8Array[] = [header];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const slice = plaintext.subarray(start, Math.min(start + chunkSize, plaintext.byteLength));
    const cipher = createCipheriv(
      "aes-256-gcm",
      key,
      nonceFor(noncePrefix, i, i === chunkCount - 1),
    );
    cipher.setAAD(header);
    parts.push(cipher.update(slice), cipher.final(), cipher.getAuthTag());
  }
  return new Uint8Array(Buffer.concat(parts));
}

export function decryptBlob(stored: Uint8Array, dek: Uint8Array, ctx: DecryptContext): Uint8Array {
  assertDek(dek);
  const header = parseHeader(stored);
  if (!header) {
    throw new BlobDecryptError("stored blob is not a well-formed encrypted blob");
  }

  const key = deriveKey(dek, header.salt, ctx.workspaceId, ctx.contentHash);
  const aad = stored.subarray(0, HEADER_BYTES);
  const framed = header.chunkSize + TAG_BYTES;

  const parts: Uint8Array[] = [];
  let offset = HEADER_BYTES;
  let remaining = stored.byteLength - HEADER_BYTES;
  let counter = 0;

  while (remaining > 0) {
    // The final chunk is whatever does not fill a whole frame — including the
    // case where it exactly does, which is why this is `<=` and not `<`.
    const isFinal = remaining <= framed;
    const take = isFinal ? remaining : framed;
    if (take < TAG_BYTES) {
      throw new BlobDecryptError("stored blob ends mid-chunk");
    }
    if (counter > MAX_CHUNKS) {
      throw new BlobDecryptError("stored blob declares more chunks than the format allows");
    }

    const body = stored.subarray(offset, offset + take - TAG_BYTES);
    const tag = stored.subarray(offset + take - TAG_BYTES, offset + take);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      nonceFor(header.noncePrefix, counter, isFinal),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    try {
      parts.push(decipher.update(body), decipher.final());
    } catch (cause) {
      throw new BlobDecryptError(`chunk ${counter} failed authentication`, { cause });
    }

    offset += take;
    remaining -= take;
    counter++;
  }

  return new Uint8Array(Buffer.concat(parts));
}