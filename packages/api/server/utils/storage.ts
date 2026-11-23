import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import {
  BlobDecryptError,
  classifyBlob,
  classifyBlobPrefix,
  decryptBlob,
  decryptFrames,
  deriveBlobKey,
  encryptBlob,
  encryptChunks,
  encryptedLayout,
  encryptedSize,
  type EncryptedLayout,
  frameSpan,
  HEADER_BYTES,
  headerGeneration,
} from "blob-io/blob-crypto";
import {
  type ByteRange,
  type RangeRequest,
  rangeHeaderFor,
  resolveRange,
} from "blob-io/byte-range";
import { collect, peek, primed, single, sliceStream } from "blob-io/byte-stream";
import { createWorkspaceKeyService, resolveKekRing, type WorkspaceDek } from "./workspace-keys";

/**
 * Blob storage adapter seam. v0 ships two drivers: R2 (S3 API) for deployed
 * environments and a local filesystem driver for dev/tests so the stack runs
 * without an R2 bucket. Keep this interface narrow — alternate backends
 * (self-host, S3) drop in here without touching callers.
 *
 * Keys are content-addressed by the caller (`<workspaceId>/<sha256>`), so
 * objects are effectively immutable; the store itself just stores bytes by key.
 *
 * Two ways in and two ways out. `put`/`get` move a whole body in memory and
 * suit small, text-shaped callers. `putSource`/`open` stream, so a 2 GB upload
 * or download holds about one chunk at a time, and `open` serves byte ranges.
 */
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Store a body as a stream. Memory stays flat whatever the size. */
  putSource(key: string, source: BlobSource, contentType: string): Promise<void>;
  /** Returns null when the key is absent (callers map this to a 502/503). */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /**
   * Open a blob for streaming, optionally just a byte range of it. Returns null
   * when the key is absent. Sizes and ranges are of the PLAINTEXT, so an
   * encrypted store hides its framing from callers.
   */
  open(key: string, range?: RangeRequest): Promise<OpenedBlob | null>;
  /** Plaintext size and content type without reading the body; null when absent. */
  stat(key: string): Promise<{ size: number; contentType: string } | null>;
  /**
   * The sealed form of an encrypted blob, so its bytes can be served by
   * something that holds no workspace key (the byte Worker). Null when the
   * blob is absent or must be served by this process: legacy plaintext and
   * damaged-marker blobs need whole-file checks only it can make. Only the
   * encrypting store has anything to hand over.
   */
  sealed?(key: string, expectedSize?: number): Promise<SealedBlob | null>;
  delete(key: string): Promise<void>;
  /**
   * Every stored object whose key starts with `prefix`, sizes as stored. Key
   * maintenance only: it is how a rotation finds bytes no database row points
   * at any more, which are still the workspace's and still need re-encrypting.
   */
  list?(prefix: string): AsyncIterable<StoredObject>;
  /** The top-level key prefixes (workspace ids), without the trailing slash. Key maintenance only. */
  listPrefixes?(): AsyncIterable<string>;
  /**
   * Delete what interrupted writes left under `prefix` before `olderThan`.
   * Reports how many went and how many newer ones remain (possibly writes
   * still in flight). Key maintenance only: a half-written blob can still hold
   * chunks an old key opens. Drivers whose writes are all-or-nothing (R2's
   * single PUT) have nothing to leave and do not implement it.
   */
  purgeAbandoned?(prefix: string, olderThan: Date): Promise<AbandonedWrites>;
}

/** What purgeAbandoned removed, and what it left because it was too recent. */
export interface AbandonedWrites {
  purged: number;
  remaining: number;
}

/** One stored object, as a listing reports it. */
export interface StoredObject {
  key: string;
  size: number;
}

/** An encrypted blob as the byte Worker needs it. */
export interface SealedBlob {
  /** Plaintext size. */
  size: number;
  contentType: string;
  /** The stored header, which fixes the layout and the key's salt. */
  header: Uint8Array;
  /** The key that opens this blob and no other. */
  key: Uint8Array;
}

/**
 * A body to store, read as a stream. `size` and `sha256` are known up front —
 * the hash names the blob and derives its key — and `open()` may be called more
 * than once, each call reading from the start.
 */
export interface BlobSource {
  size: number;
  sha256: string;
  open(): AsyncIterable<Uint8Array>;
}

/** A BlobSource over bytes already in memory (MCP writes, restores, small bodies). */
export function bufferSource(bytes: Uint8Array): BlobSource {
  return {
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    open: () => single(bytes),
  };
}

export interface OpenedBlob {
  /** Total size of the blob, whatever range was asked for. */
  size: number;
  contentType: string;
  /** The bytes `body` covers: null for the whole blob, or "unsatisfiable" (416). */
  range: ByteRange | "unsatisfiable" | null;
  body: AsyncIterable<Uint8Array>;
  /**
   * Release the storage connection or file behind `body`. Callers must call it
   * once they are done, read or not: a body that is never iterated (a client
   * that left before streaming began) would otherwise hold its R2 response or
   * file descriptor open, because closing a wrapper that never started does not
   * reach the source underneath.
   */
  close?: () => void;
}

/** A Node stream's destroy, as an OpenedBlob close. */
function closerOf(body: unknown): (() => void) | undefined {
  const destroy = (body as { destroy?: () => void } | null)?.destroy;
  return typeof destroy === "function" ? () => destroy.call(body) : undefined;
}

const EMPTY: AsyncIterable<Uint8Array> = single(new Uint8Array(0));

/** The largest "looks encrypted but won't open" blob given the buffered check. */
const LOOKALIKE_BUFFER_BYTES = 16 * 1024 * 1024;

class R2BlobStore implements BlobStore {
  #client: S3Client;
  #bucket: string;

  constructor(opts: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Test seam: a stand-in for the S3 client. */
    client?: S3Client;
  }) {
    this.#bucket = opts.bucket;
    this.#client =
      opts.client ??
      new S3Client({
        region: "auto",
        endpoint: opts.endpoint,
        credentials: {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        },
        // R2 has historically rejected the AWS SDK's default crc32 checksum
        // headers; only send checksums when a command requires them.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  // One streamed PUT with a declared length. R2 takes up to ~5 GiB this way,
  // above the largest file any plan allows, so multipart (and its part
  // bookkeeping) isn't needed until uploads go direct to R2.
  //
  // The SDK does not watch its body stream for errors: if the source fails part
  // way (the client went away, or the hash check refused changed bytes), the
  // request neither finishes nor rejects, and the stream's error escapes as an
  // unhandled event that can take the process down. So the body is watched
  // here, and a failure aborts the request and is what the caller sees.
  async putSource(key: string, source: BlobSource, contentType: string): Promise<void> {
    const body = Readable.from(source.open());
    const abort = new AbortController();
    let failure: unknown;
    body.on("error", (err) => {
      failure = err;
      abort.abort(err);
    });
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: source.size,
        }),
        { abortSignal: abort.signal },
      );
    } catch (err) {
      throw failure ?? err;
    } finally {
      body.destroy();
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    try {
      const res = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (!res.Body) return null;
      const body = await res.Body.transformToByteArray();
      return { body, contentType: res.ContentType ?? "application/octet-stream" };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async open(key: string, range?: RangeRequest): Promise<OpenedBlob | null> {
    let res: GetObjectCommandOutput;
    try {
      res = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Range: range ? rangeHeaderFor(range) : undefined,
        }),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      // 416: the range starts past the end. Report the real size so the caller
      // can answer with `Content-Range: bytes */size`.
      if (isInvalidRange(err)) {
        const meta = await this.stat(key);
        return meta && { ...meta, range: "unsatisfiable", body: EMPTY };
      }
      throw err;
    }
    if (!res.Body) return null;
    return openedFromResponse(res, range);
  }

  async stat(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? "application/octet-stream",
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async *list(prefix: string): AsyncGenerator<StoredObject> {
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async *listPrefixes(): AsyncGenerator<string> {
    let token: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Delimiter: "/",
          ContinuationToken: token,
        }),
      );
      for (const p of page.CommonPrefixes ?? []) {
        if (p.Prefix) yield p.Prefix.slice(0, -1);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

/** Parse an S3 `Content-Range: bytes a-b/total` response header. */
function parseContentRange(header: string | undefined): { range: ByteRange; size: number } | null {
  const m = header ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header) : null;
  if (!m) return null;
  return { range: { start: Number(m[1]), end: Number(m[2]) }, size: Number(m[3]) };
}

/** What an S3 GET returned, as an OpenedBlob for the range that was asked for. */
function openedFromResponse(res: GetObjectCommandOutput, range?: RangeRequest): OpenedBlob {
  const contentType = res.ContentType ?? "application/octet-stream";
  const body = res.Body as unknown as AsyncIterable<Uint8Array>;
  const close = closerOf(res.Body);
  const parsed = range ? parseContentRange(res.ContentRange) : null;
  if (parsed) return { size: parsed.size, contentType, range: parsed.range, body, close };
  // No range asked for, or a store that ignored the Range header and sent the
  // whole object (200): resolve the range here rather than serve wrong bytes.
  return { ...rangeOfStream(body, res.ContentLength ?? 0, contentType, range), close };
}

function isInvalidRange(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "InvalidRange" || status === 416;
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string; Code?: string })?.name;
  const code = (err as { Code?: string })?.Code;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  // HEAD responses have no body, so a missing key surfaces as "NotFound".
  return name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey" || status === 404;
}

/**
 * Local filesystem driver for dev/tests. Bytes live at `<baseDir>/<key>` and the
 * content-type in a sibling `<key>.ct` file so binaries round-trip with their
 * type intact.
 */
class FsBlobStore implements BlobStore {
  #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = baseDir;
  }

  #pathFor(key: string): string {
    return join(this.#baseDir, key);
  }

  // Both writes go to a temporary name and are renamed into place, so a reader
  // never sees a half-written blob, and a blob replaced while it is being read
  // (a key rotation re-sealing it, an identical upload) is read whole, old or
  // new. A failed upload leaves nothing at the key.
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.partial-${randomUUID()}`;
    try {
      await writeFile(partial, body);
      await writeFile(`${path}.ct`, contentType, "utf8");
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
  }

  async putSource(key: string, source: BlobSource, contentType: string): Promise<void> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.partial-${randomUUID()}`;
    try {
      await pipeline(Readable.from(source.open()), createWriteStream(partial));
      await writeFile(`${path}.ct`, contentType, "utf8");
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
  }

  async open(key: string, range?: RangeRequest): Promise<OpenedBlob | null> {
    const path = this.#pathFor(key);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const contentType = await readFile(`${path}.ct`, "utf8").catch(
      () => "application/octet-stream",
    );
    if (!range) {
      const body = createReadStream(path);
      return { size, contentType, range: null, body, close: () => body.destroy() };
    }
    const resolved = resolveRange(range, size);
    if (resolved === "unsatisfiable") return { size, contentType, range: resolved, body: EMPTY };
    const body = createReadStream(path, { start: resolved.start, end: resolved.end });
    return { size, contentType, range: resolved, body, close: () => body.destroy() };
  }

  async stat(key: string): Promise<{ size: number; contentType: string } | null> {
    const path = this.#pathFor(key);
    try {
      const { size } = await stat(path);
      const contentType = await readFile(`${path}.ct`, "utf8").catch(
        () => "application/octet-stream",
      );
      return { size, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const path = this.#pathFor(key);
    try {
      const body = await readFile(path);
      const contentType = await readFile(`${path}.ct`, "utf8").catch(
        () => "application/octet-stream",
      );
      return { body: new Uint8Array(body), contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.ct`, { force: true });
  }

  /** One directory per workspace; the content-type sidecars and partial writes are not objects. */
  async *list(prefix: string): AsyncGenerator<StoredObject> {
    const slash = prefix.lastIndexOf("/");
    const dir = prefix.slice(0, slash + 1);
    const start = prefix.slice(slash + 1);
    let names: string[];
    try {
      names = await readdir(this.#pathFor(dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names.sort()) {
      if (!name.startsWith(start) || name.endsWith(".ct") || name.includes(".partial-")) continue;
      // Only a blob removed since readdir is skipped. Any other failure must
      // stop the listing: key maintenance destroys a key when a scan finds
      // nothing under it, so a silently missing object could lose its file.
      const info = await stat(this.#pathFor(dir + name)).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (info?.isFile()) yield { key: dir + name, size: info.size };
    }
  }

  async purgeAbandoned(prefix: string, olderThan: Date): Promise<AbandonedWrites> {
    const dir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    let names: string[];
    try {
      names = await readdir(this.#pathFor(dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { purged: 0, remaining: 0 };
      throw err;
    }
    let purged = 0;
    let remaining = 0;
    for (const name of names) {
      if (!name.includes(".partial-")) continue;
      const path = this.#pathFor(dir + name);
      const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (!info) continue;
      if (info.mtime >= olderThan) {
        remaining++;
        continue;
      }
      await rm(path, { force: true });
      purged++;
    }
    return { purged, remaining };
  }

  async *listPrefixes(): AsyncGenerator<string> {
    const entries = await readdir(this.#baseDir, { withFileTypes: true }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    });
    for (const e of entries) if (e.isDirectory()) yield e.name;
  }
}

/**
 * Re-sealing buffers blobs up to this size and streams larger ones. Icons and
 * most files are small; streaming needs the content hash to check against.
 */
const RESEAL_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Resolves a workspace's data keys. Injected so the wrapper is unit-testable.
 * Without a generation: the key new writes use. With one: the key a blob with
 * that generation in its header was sealed under, or null when the workspace
 * has no such generation (never issued, or destroyed after a rotation).
 */
export interface DekResolver {
  (workspaceId: string): Promise<WorkspaceDek>;
  (workspaceId: string, generation: number): Promise<WorkspaceDek | null>;
}

/**
 * Split a content-addressed blob key into the workspace and content hash it
 * encodes. Both are bound into the blob's key derivation, so getting this wrong
 * silently would produce undecryptable data — hence strict validation and a
 * throw rather than a best guess.
 */
export function splitBlobKey(key: string): { workspaceId: string; contentHash: string } {
  const slash = key.indexOf("/");
  const malformed = slash <= 0 || slash === key.length - 1 || key.indexOf("/", slash + 1) !== -1;
  if (malformed) {
    throw new Error(
      `blob key ${JSON.stringify(key)} is not "<workspaceId>/<contentHash>". ` +
        "Encrypted blobs are keyed to their workspace, so the key format is load-bearing.",
    );
  }
  return { workspaceId: key.slice(0, slash), contentHash: key.slice(slash + 1) };
}

/**
 * The one honest way to recognise a pre-encryption plaintext blob that happens
 * to begin with the encryption marker: blobs are content-addressed, so bytes
 * that hash to the content hash they are keyed by ARE the original plaintext —
 * the same authenticator the ordinary legacy path relies on. Nothing an
 * attacker can write passes this check without being the true content, so the
 * fallback adds no substitution surface. Bytes we actually sealed can never
 * take this path (their stored form hashes to nothing meaningful), so it only
 * ever rescues genuine legacy files.
 */
function legacyByHash(
  stored: { body: Uint8Array; contentType: string },
  contentHash: string,
): { body: Uint8Array; contentType: string } | null {
  const actual = createHash("sha256").update(stored.body).digest("hex");
  return actual === contentHash ? stored : null;
}

function logDecryptFailure(key: string, err: unknown): void {
  console.error(
    `[storage] blob ${key} is present but failed to decrypt — treating as an ` +
      "integrity failure, not a missing blob",
    err,
  );
}

/** Pass a stream through unchanged, failing at its end if its SHA-256 isn't `expected`. */
async function* verifyHash(
  source: AsyncIterable<Uint8Array>,
  expected: string,
): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  for await (const piece of source) {
    hash.update(piece);
    yield piece;
  }
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`bytes changed while being stored: expected sha256 ${expected}, got ${actual}`);
  }
}

async function* concat(
  head: Uint8Array,
  rest: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (head.byteLength > 0) yield head;
  yield* rest;
}

/** The layout of an encrypted blob from its header prefix, or null for anything else. */
function layoutOf(head: Uint8Array, storedSize: number): EncryptedLayout | null {
  return classifyBlobPrefix(head, storedSize) === "encrypted"
    ? encryptedLayout(head, storedSize)
    : null;
}

/**
 * Serve a stream of a known-size blob, or one range of it, by skipping and
 * trimming. For bodies that can't be fetched by range: legacy blobs read whole,
 * and stores that ignore a Range header.
 */
function rangeOfStream(
  body: AsyncIterable<Uint8Array>,
  size: number,
  contentType: string,
  range?: RangeRequest,
): OpenedBlob {
  if (!range) return { size, contentType, range: null, body };
  const resolved = resolveRange(range, size);
  if (resolved === "unsatisfiable") return { size, contentType, range: resolved, body: EMPTY };
  return {
    size,
    contentType,
    range: resolved,
    body: sliceStream(body, resolved.start, resolved.end - resolved.start + 1),
  };
}

/**
 * Encrypts on the way in and decrypts on the way out, wrapping either driver so
 * R2 and the filesystem path are covered by one implementation. Callers of
 * `BlobStore` are unaware this exists.
 *
 * Encryption happens BEFORE the delegated put, so a failure to encrypt (a
 * missing or unopenable key) leaves no object behind. That ordering matters:
 * `files.ts` persists the blob before the metadata CAS precisely so a committed
 * row never points at missing bytes, and a half-written put would invert the
 * invariant into a row pointing at unreadable bytes.
 *
 * Reads pass legacy plaintext through untouched, so blobs written before
 * encryption was introduced keep working with no migration.
 */
class EncryptingBlobStore implements BlobStore, KeyRotationStore {
  /** The wrapped driver. Exposed so callers can still identify the backend. */
  readonly inner: BlobStore;
  #dekFor: DekResolver;
  #forget: (workspaceId?: string) => void;

  constructor(
    inner: BlobStore,
    dekFor: DekResolver,
    forget: (workspaceId?: string) => void = () => {},
  ) {
    this.inner = inner;
    this.#dekFor = dekFor;
    this.#forget = forget;
  }

  list(prefix: string): AsyncIterable<StoredObject> {
    if (!this.inner.list) throw new Error("this blob driver cannot list its objects");
    return this.inner.list(prefix);
  }

  listPrefixes(): AsyncIterable<string> {
    if (!this.inner.listPrefixes) throw new Error("this blob driver cannot list its prefixes");
    return this.inner.listPrefixes();
  }

  async purgeAbandoned(prefix: string, olderThan: Date): Promise<AbandonedWrites> {
    return this.inner.purgeAbandoned
      ? this.inner.purgeAbandoned(prefix, olderThan)
      : { purged: 0, remaining: 0 };
  }

  forgetKeys(workspaceId?: string): void {
    this.#forget(workspaceId);
  }

  async sealedGeneration(key: string): Promise<number | "legacy" | "malformed" | null> {
    const header = await this.#readHeader(key);
    if (!header) return null;
    if (header.kind === "legacy") return "legacy";
    return headerGeneration(header.head, header.size) ?? "malformed";
  }

  async verifiedGeneration(key: string): Promise<number | "unverified" | null> {
    const header = await this.#readHeader(key);
    if (!header) return null;
    if (!header.layout) return "unverified";
    const generation = headerGeneration(header.head, header.size);
    const dek = await this.#dekForHeader(key, header.head, header.size);
    if (generation === null || !dek) return "unverified";
    // The header is authenticated as each chunk's associated data, so a first
    // chunk that opens proves the generation field was not altered.
    return (await this.#firstChunkOpens(key, dek, header.head, header.layout))
      ? generation
      : "unverified";
  }

  async reseal(key: string): Promise<boolean> {
    const { contentHash } = splitBlobKey(key);
    const size = (await this.stat(key))?.size;
    if (size === undefined) return false;
    if (size > RESEAL_BUFFER_BYTES && /^[0-9a-f]{64}$/.test(contentHash)) {
      // Streamed both ways, so memory stays flat. putSource re-hashes the
      // plaintext against the content hash on the way through, and the driver
      // only replaces the object once the new one is whole.
      const contentType = (await this.inner.stat(key))?.contentType;
      if (contentType === undefined) return false;
      const legacy = (await this.sealedGeneration(key)) === "legacy";
      await this.putSource(
        key,
        {
          size,
          sha256: contentHash,
          // Legacy plaintext streams straight from the driver: the public read
          // path buffers it whole to hash-check it, and putSource's own hash
          // check already refuses to replace the object if the bytes differ.
          open: () => (legacy ? this.#rawBytes(key) : this.#plaintext(key)),
        },
        contentType,
      );
      return true;
    }
    const plain = await this.get(key);
    if (!plain) return false;
    await this.put(key, plain.body, plain.contentType);
    return true;
  }

  async *#rawBytes(key: string): AsyncGenerator<Uint8Array> {
    const opened = await this.inner.open(key);
    if (!opened) throw new BlobDecryptError(`blob ${key} disappeared while it was being re-sealed`);
    try {
      yield* opened.body;
    } finally {
      opened.close?.();
    }
  }

  async *#plaintext(key: string): AsyncGenerator<Uint8Array> {
    const opened = await this.open(key);
    if (!opened) throw new BlobDecryptError(`blob ${key} disappeared while it was being re-sealed`);
    try {
      yield* opened.body;
    } finally {
      opened.close?.();
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const { workspaceId, contentHash } = splitBlobKey(key);
    const { dek, generation } = await this.#dekFor(workspaceId);
    const sealed = encryptBlob(body, dek, { workspaceId, contentHash, keyGeneration: generation });
    await this.inner.put(key, sealed, contentType);
  }

  async putSource(key: string, source: BlobSource, contentType: string): Promise<void> {
    const { workspaceId, contentHash } = splitBlobKey(key);
    // The hash names the blob and derives its key, so a source that disagrees
    // with its key would seal bytes under the wrong identity.
    if (source.sha256 !== contentHash) {
      throw new Error(`blob key ${key} does not match the hash of the bytes being stored`);
    }
    const { dek, generation } = await this.#dekFor(workspaceId);
    const ctx = { workspaceId, contentHash, keyGeneration: generation };
    await this.inner.putSource(
      key,
      {
        size: encryptedSize(source.size),
        sha256: contentHash,
        // Re-hash on the way through. The size and hash were measured when the
        // body was spooled; if the bytes read back now differ, sealing stops
        // before the final chunk and the store is left with nothing at the key.
        open: () => encryptChunks(verifyHash(source.open(), contentHash), source.size, dek, ctx),
      },
      contentType,
    );
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const stored = await this.inner.get(key);
    if (!stored) return null;
    return this.#open(key, stored);
  }

  /** Decrypt (or verify, for legacy plaintext) a whole stored blob. */
  async #open(
    key: string,
    stored: { body: Uint8Array; contentType: string },
  ): Promise<{ body: Uint8Array; contentType: string }> {
    const { workspaceId, contentHash } = splitBlobKey(key);
    const kind = classifyBlob(stored.body);

    if (kind === "malformed") {
      // Carries our marker but the header will not parse: corruption, tampering,
      // or a format version this build cannot read. Returning it as legacy
      // plaintext would serve raw ciphertext as file content with no tag ever
      // checked, so this fails — unless the bytes hash to the content hash they
      // are keyed by, which proves they are a pre-encryption plaintext file that
      // happens to begin with the marker (see legacyByHash).
      const rescued = legacyByHash(stored, contentHash);
      if (rescued) return rescued;
      console.error(
        `[storage] blob ${key} carries the encryption marker but its header is unreadable`,
      );
      throw new BlobDecryptError(
        "stored blob carries the encryption marker but its header is not readable by this build",
      );
    }

    if (kind === "legacy") {
      // Written before encryption existed (R10). Nothing authenticates these,
      // so verify them against the content hash they are keyed by — otherwise
      // anyone who can WRITE to the bucket could replace an encrypted object
      // with plaintext of their choosing and have the API serve it.
      const actual = createHash("sha256").update(stored.body).digest("hex");
      if (actual !== contentHash) {
        console.error(
          `[storage] legacy plaintext blob ${key} does not match its content hash ` +
            `(got ${actual}) — refusing to serve substituted content`,
        );
        throw new BlobDecryptError("legacy plaintext blob does not match its content hash");
      }
      return stored;
    }

    const dek = await this.#dekForHeader(key, stored.body, stored.body.byteLength);
    try {
      if (!dek) {
        throw new BlobDecryptError(
          `blob ${key} names a key generation its workspace does not have`,
        );
      }
      return {
        body: decryptBlob(stored.body, dek, { workspaceId, contentHash }),
        contentType: stored.contentType,
      };
    } catch (err) {
      // Same rescue as the malformed branch: a legacy plaintext file can begin
      // with bytes that parse as a valid header, and the hash check is what
      // tells that apart from a blob we sealed and someone broke.
      const rescued = legacyByHash(stored, contentHash);
      if (rescued) return rescued;
      // A blob that is present but will not open is either tampering or a key
      // mismatch — never ordinary absence. It must not be reported as a missing
      // blob (which routes map to 502, and a pinned share maps to a reassuring
      // 410), so this throws rather than returning null, and says so in the log.
      logDecryptFailure(key, err);
      throw err;
    }
  }

  /**
   * Stream a blob, or one byte range of it, decrypting only the chunks that
   * cover the bytes asked for. Encrypted blobs authenticate each chunk before
   * releasing it. Legacy plaintext (and the malformed-marker case) can only be
   * authenticated by hashing the whole file, so those keep the buffered path
   * above: they predate encryption, and correctness beats streaming for them.
   */
  async open(key: string, range?: RangeRequest): Promise<OpenedBlob | null> {
    return range ? this.#openRange(key, range) : this.#openWhole(key);
  }

  /** The whole blob in one GET, peeling the header off the front. */
  async #openWhole(key: string): Promise<OpenedBlob | null> {
    const whole = await this.inner.open(key);
    if (!whole) return null;
    const { head, rest } = await peek(whole.body, HEADER_BYTES);
    const layout = layoutOf(head, whole.size);
    if (!layout) return this.#openUnsealedWhole(key, head, rest, whole);
    const dek = await this.#dekForOpenBody(key, head, whole);
    if (!dek) {
      // Names a generation this workspace does not have: a legacy file that
      // merely looks encrypted, or a blob whose key is gone. Only the buffered
      // check can say which.
      whole.close?.();
      return this.#openLookalike(key, whole.size);
    }
    const frames = await this.#verifiedFirst(
      key,
      this.#decrypt(key, dek, head, layout, 0, layout.chunkCount - 1, rest),
    );
    if (!frames) {
      whole.close?.();
      return this.#openLookalike(key, whole.size);
    }
    return {
      size: layout.plaintextSize,
      contentType: whole.contentType,
      range: null,
      body: this.#logFailures(key, frames),
      close: whole.close,
    };
  }

  /** A whole read of a blob with no parseable header: legacy plaintext, or a damaged marker. */
  async #openUnsealedWhole(
    key: string,
    head: Uint8Array,
    rest: AsyncIterable<Uint8Array>,
    whole: OpenedBlob,
  ): Promise<OpenedBlob> {
    if (classifyBlobPrefix(head, whole.size) !== "legacy") {
      // Carries the marker but the header won't parse (a damaged version byte,
      // say). Only the buffered check can rescue a legacy file behind it, and
      // that check is bounded: a large one is far likelier to be damage.
      whole.close?.();
      return this.#openLookalike(key, whole.size);
    }
    const stored = await collect(concat(head, rest));
    const plain = await this.#open(key, { body: stored, contentType: whole.contentType });
    return rangeOfStream(single(plain.body), plain.body.byteLength, plain.contentType);
  }

  /** Read the header to learn the layout, then fetch only the frames covering the range. */
  async #openRange(key: string, range: RangeRequest, retried = false): Promise<OpenedBlob | null> {
    const header = await this.#readHeader(key);
    if (!header) return null;
    if (!header.layout) {
      // True legacy plaintext keeps the buffered path it always had; a marked
      // blob whose header won't parse gets the bounded one.
      return header.kind === "legacy"
        ? this.#openLegacy(key, range)
        : this.#openLookalike(key, header.size, range);
    }
    const dek = await this.#dekForHeader(key, header.head, header.size);
    if (!dek) return this.#openLookalike(key, header.size, range);
    const { layout, contentType } = header;
    const resolved = resolveRange(range, layout.plaintextSize);
    if (resolved === "unsatisfiable") {
      return this.#unsatisfiable(key, dek, { ...header, layout }, range, retried);
    }
    const opened = await this.#rangeBody(key, dek, header, layout, resolved);
    if (!opened) {
      // The header and the frames come from two reads. A blob re-sealed in
      // between (fresh salt, same size) fails here although nothing is wrong,
      // so read it once more before concluding anything.
      if (!retried) return this.#openRange(key, range, true);
      return this.#openLookalike(key, header.size, range);
    }
    return { size: layout.plaintextSize, contentType, range: resolved, ...opened };
  }

  /**
   * A 416 reports the size, so the header has to be shown to be genuine first:
   * a legacy lookalike's real size differs from what it implies.
   */
  async #unsatisfiable(
    key: string,
    dek: Uint8Array,
    header: { size: number; contentType: string; head: Uint8Array; layout: EncryptedLayout },
    range: RangeRequest,
    retried: boolean,
  ): Promise<OpenedBlob | null> {
    if (!(await this.#firstChunkOpens(key, dek, header.head, header.layout))) {
      // Re-sealed between the header read and this one: read both again, as
      // #openRange does, before treating it as a lookalike.
      if (!retried) return this.#openRange(key, range, true);
      return this.#openLookalike(key, header.size, range);
    }
    const { plaintextSize: size } = header.layout;
    return { size, contentType: header.contentType, range: "unsatisfiable", body: EMPTY };
  }

  /** The decrypted bytes of `range`, or null if its first chunk won't authenticate. */
  async #rangeBody(
    key: string,
    dek: Uint8Array,
    header: { size: number; head: Uint8Array },
    layout: EncryptedLayout,
    range: ByteRange,
  ): Promise<{ body: AsyncIterable<Uint8Array>; close?: () => void } | null> {
    const span = frameSpan(layout, range);
    const raw = await this.inner.open(key, { start: span.storedStart, end: span.storedEnd });
    if (!raw || raw.range === "unsatisfiable" || raw.size !== header.size) {
      throw new BlobDecryptError(`blob ${key} changed while it was being read`);
    }
    const plain = await this.#verifiedFirst(
      key,
      this.#decrypt(key, dek, header.head, layout, span.first, span.last, raw.body),
    );
    if (!plain) {
      raw.close?.();
      return null;
    }
    return {
      body: this.#logFailures(key, sliceStream(plain, span.skip, span.take)),
      close: raw.close,
    };
  }

  /**
   * Authenticate a decrypting stream's first chunk before anything about the
   * response is committed. Null means it failed with an integrity error, and
   * the caller should take the buffered path instead: that either rescues a
   * legacy plaintext file whose bytes merely look like an encrypted header —
   * with ITS real size and ranges, not the ones the header implied — or throws
   * the same integrity error `get` would.
   */
  async #verifiedFirst(
    key: string,
    stream: AsyncIterable<Uint8Array>,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    try {
      return await primed(stream);
    } catch (err) {
      if (err instanceof BlobDecryptError) return null;
      throw err;
    }
  }

  /** The buffered read as an OpenedBlob, for blobs only a whole-file check can vouch for. */
  async #openLegacy(key: string, range?: RangeRequest): Promise<OpenedBlob> {
    const plain = await this.#reopen(key);
    return rangeOfStream(single(plain.body), plain.body.byteLength, plain.contentType, range);
  }

  /**
   * A blob whose header parses but whose first chunk won't open. That is a
   * legacy plaintext file that happens to look encrypted, or a broken blob,
   * and only the buffered whole-file check can say which. A lookalike is
   * vanishingly rare and small; a multi-gigabyte one is far likelier to be
   * damage, and buffering it would bring back exactly the memory blow-up
   * streaming exists to prevent. So only small ones get the buffered check.
   */
  async #openLookalike(key: string, storedSize: number, range?: RangeRequest): Promise<OpenedBlob> {
    const plain = await this.#reopenBounded(key, storedSize);
    return rangeOfStream(single(plain.body), plain.body.byteLength, plain.contentType, range);
  }

  async #reopenBounded(
    key: string,
    storedSize: number,
  ): Promise<{ body: Uint8Array; contentType: string }> {
    if (storedSize > LOOKALIKE_BUFFER_BYTES) {
      const err = new BlobDecryptError(`blob ${key} failed to decrypt`);
      logDecryptFailure(key, err);
      throw err;
    }
    return this.#reopen(key);
  }

  /**
   * Hand an encrypted blob over for serving elsewhere: its header and the one
   * key that opens it, never the workspace DEK. Only the 52-byte header is
   * read when `expectedSize` (the plaintext size the metadata records) is
   * known: a genuine sealed blob's header implies exactly that size, and a
   * legacy plaintext file that merely begins with a valid-looking header
   * cannot, because its stored size IS its plaintext size. Without one, the
   * first chunk has to open, as in `stat`, with the same one re-read.
   */
  async sealed(key: string, expectedSize?: number, retried = false): Promise<SealedBlob | null> {
    const header = await this.#readHeader(key);
    if (!header?.layout) return null;
    const { layout, head } = header;
    // No such generation: leave it to this process's own read, which can tell a
    // legacy lookalike from a blob whose key is gone.
    const dek = await this.#dekForHeader(key, head, header.size);
    if (!dek) return null;
    const genuine =
      expectedSize === undefined
        ? await this.#firstChunkOpens(key, dek, head, layout)
        : layout.plaintextSize === expectedSize;
    if (!genuine) {
      // As in `stat`: an identical upload can re-seal the blob between the
      // header and first-chunk reads. Only the first-chunk path has two reads.
      if (expectedSize === undefined && !retried) return this.sealed(key, undefined, true);
      return null;
    }
    return {
      size: layout.plaintextSize,
      contentType: header.contentType,
      header: head.slice(0, HEADER_BYTES),
      key: deriveBlobKey(dek, head, splitBlobKey(key)),
    };
  }

  async stat(key: string, retried = false): Promise<{ size: number; contentType: string } | null> {
    const header = await this.#readHeader(key);
    if (!header) return null;
    if (header.kind === "legacy") return { size: header.size, contentType: header.contentType };
    // A header that parses only describes the file if its first chunk opens: a
    // legacy plaintext file can begin with bytes that look like one.
    if (header.layout) {
      const dek = await this.#dekForHeader(key, header.head, header.size);
      if (dek && (await this.#firstChunkOpens(key, dek, header.head, header.layout))) {
        return { size: header.layout.plaintextSize, contentType: header.contentType };
      }
      // The header and first chunk are two reads; an identical upload re-sealing
      // the blob in between fails this although nothing is wrong. Read again.
      if (!retried) return this.stat(key, true);
    }
    // Marked but unreadable, or a lookalike: only the buffered read can tell a
    // legacy file that merely begins with the marker from a broken blob.
    const plain = await this.#reopenBounded(key, header.size);
    return { size: plain.body.byteLength, contentType: plain.contentType };
  }

  async #firstChunkOpens(
    key: string,
    dek: Uint8Array,
    head: Uint8Array,
    layout: EncryptedLayout,
  ): Promise<boolean> {
    const raw = await this.inner.open(key, {
      start: layout.frameOffset(0),
      end: layout.frameOffset(0) + layout.frameLength(0) - 1,
    });
    if (!raw || raw.range === "unsatisfiable") return false;
    return (
      (await this.#verifiedFirst(key, this.#decrypt(key, dek, head, layout, 0, 0, raw.body))) !==
      null
    );
  }

  /** The stored header and what it says, from a ranged read of the first bytes. */
  async #readHeader(key: string) {
    const prefix = await this.inner.open(key, { start: 0, end: HEADER_BYTES - 1 });
    if (!prefix) return null;
    const head = prefix.range === "unsatisfiable" ? new Uint8Array(0) : await collect(prefix.body);
    return {
      size: prefix.size,
      contentType: prefix.contentType,
      head,
      kind: classifyBlobPrefix(head, prefix.size),
      layout: layoutOf(head, prefix.size),
    };
  }

  #decrypt(
    key: string,
    dek: Uint8Array,
    head: Uint8Array,
    layout: EncryptedLayout,
    first: number,
    last: number,
    frames: AsyncIterable<Uint8Array>,
  ): AsyncIterable<Uint8Array> {
    const { workspaceId, contentHash } = splitBlobKey(key);
    return decryptFrames(head, layout, first, last, frames, dek, { workspaceId, contentHash });
  }

  /** #dekForHeader for a body already open: a failed lookup must not strand it. */
  async #dekForOpenBody(
    key: string,
    head: Uint8Array,
    body: { size: number; close?: () => void },
  ): Promise<Uint8Array | null> {
    try {
      return await this.#dekForHeader(key, head, body.size);
    } catch (err) {
      body.close?.();
      throw err;
    }
  }

  /**
   * The data key a blob was sealed under, chosen by the generation its header
   * names. Null when the header does not parse or the workspace has no such
   * generation; callers treat that as "this blob will not open with our keys".
   */
  async #dekForHeader(
    key: string,
    head: Uint8Array,
    storedSize: number,
  ): Promise<Uint8Array | null> {
    const generation = headerGeneration(head, storedSize);
    if (generation === null) return null;
    return (await this.#dekFor(splitBlobKey(key).workspaceId, generation))?.dek ?? null;
  }

  /** The buffered read, for blobs that only a whole-file check can vouch for. */
  async #reopen(key: string): Promise<{ body: Uint8Array; contentType: string }> {
    const stored = await this.inner.get(key);
    if (!stored) throw new BlobDecryptError(`blob ${key} disappeared while it was being read`);
    return this.#open(key, stored);
  }

  /**
   * Pass a decrypting stream through, logging a failure part way as tampering.
   * The first chunk is already authenticated (see #verifiedFirst), so a later
   * failure can only cut the response off; the log is what says why.
   */
  async *#logFailures(key: string, stream: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    try {
      yield* stream;
    } catch (err) {
      logDecryptFailure(key, err);
      throw err;
    }
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

let store: BlobStore | undefined;

/**
 * Select a blob driver from an environment. R2 when all four R2_* vars are set;
 * otherwise the local filesystem driver (BLOB_DIR, default `.data/blobs`).
 *
 * Production boot guard (U16): in production, silently falling back to the
 * default local directory means file bytes land on ephemeral disk and vanish on
 * the next redeploy. So when NODE_ENV=production and R2 is not configured, we
 * require BLOB_DIR to be set *explicitly* (a deliberate filesystem opt-in on a
 * persistent volume) and refuse to boot otherwise — naming both valid setups.
 * Dev is unchanged: no NODE_ENV=production, so the default directory is used.
 */
export function resolveBlobStore(env: NodeJS.ProcessEnv = process.env): BlobStore {
  const endpoint = env.R2_ENDPOINT;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;

  // A PARTIAL R2 config (e.g. bucket set but secret forgotten) must fail loud,
  // not silently drop to the filesystem driver — otherwise a self-hoster who
  // meant to use R2 writes bytes to ephemeral disk and loses them on redeploy.
  const anyR2 = endpoint || bucket || accessKeyId || secretAccessKey;
  const allR2 = endpoint && bucket && accessKeyId && secretAccessKey;
  if (anyR2 && !allR2) {
    throw new Error(
      "Partial R2 configuration detected. To use Cloudflare R2 you must set all " +
        "four vars: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. " +
        "Leave them all unset to use the filesystem driver (BLOB_DIR).",
    );
  }

  if (allR2) {
    return withEncryption(new R2BlobStore({ endpoint, bucket, accessKeyId, secretAccessKey }), env);
  }

  const blobDir = env.BLOB_DIR;
  if (env.NODE_ENV === "production" && !blobDir) {
    throw new Error(
      "Blob storage is not configured. In production the API refuses to boot " +
        "without an explicit choice, so file bytes never silently land on " +
        "ephemeral disk (lost on the next redeploy). Either set the R2_* vars " +
        "(R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) to use " +
        "object storage, or set BLOB_DIR to a path on a persistent volume to use " +
        "the filesystem driver.",
    );
  }

  return withEncryption(new FsBlobStore(blobDir ?? ".data/blobs"), env);
}

/**
 * Wrap a driver in encryption when a KEK is configured. With none configured
 * the driver is returned bare and bytes are stored in plaintext, exactly as
 * before this feature — `resolveKekRing` is what refuses that outcome in
 * production.
 */
function withEncryption(driver: BlobStore, env: NodeJS.ProcessEnv): BlobStore {
  const ring = resolveKekRing(env);
  if (!ring) return driver;
  const keys = createWorkspaceKeyService(ring);
  const resolve = ((workspaceId: string, generation?: number) =>
    generation === undefined
      ? keys.dekFor(workspaceId)
      : keys.dekForGeneration(workspaceId, generation)) as DekResolver;
  return new EncryptingBlobStore(driver, resolve, (workspaceId) => keys.forget(workspaceId));
}

/**
 * What key maintenance needs from an encrypting store: find every object,
 * learn which data-key generation each is sealed under, and seal one again
 * under the generation in use.
 */
export interface KeyRotationStore {
  list(prefix: string): AsyncIterable<StoredObject>;
  /** Every top-level prefix: one per workspace that has ever stored bytes, deleted ones included. */
  listPrefixes(): AsyncIterable<string>;
  delete(key: string): Promise<void>;
  /** Delete leftovers of interrupted writes older than `olderThan`; see BlobStore.purgeAbandoned. */
  purgeAbandoned(prefix: string, olderThan: Date): Promise<AbandonedWrites>;
  /**
   * A blob's data-key generation; `legacy` for pre-encryption plaintext,
   * `malformed` for a marker whose header won't parse; null when absent.
   */
  sealedGeneration(key: string): Promise<number | "legacy" | "malformed" | null>;
  /**
   * The generation a blob is sealed under, proven by opening its first chunk
   * with that generation's key; `unverified` for anything that does not prove
   * itself (legacy plaintext, a damaged header, a key that will not open it);
   * null when absent. What key destruction trusts, where sealedGeneration is
   * only a hint.
   */
  verifiedGeneration(key: string): Promise<number | "unverified" | null>;
  /** Decrypt (or verify, for legacy plaintext) and store again under the current key. False when absent. */
  reseal(key: string): Promise<boolean>;
  /** Drop cached data keys so the next write sees a newly issued generation. */
  forgetKeys(workspaceId?: string): void;
}

/** The store's rotation surface, or null when it does not encrypt. */
export function keyRotationStoreOf(store: BlobStore): KeyRotationStore | null {
  return store instanceof EncryptingBlobStore ? store : null;
}

/** Whether a store keeps its bytes in R2, where the byte Worker can read them. */
export function storesInR2(store: BlobStore): boolean {
  const inner = store instanceof EncryptingBlobStore ? store.inner : store;
  return inner instanceof R2BlobStore;
}

/** Test seam: the R2 driver over a stand-in S3 client. */
export function r2BlobStoreForTesting(client: S3Client, bucket = "test"): BlobStore {
  return new R2BlobStore({
    endpoint: "",
    bucket,
    accessKeyId: "",
    secretAccessKey: "",
    client,
  });
}

/** Test seam: wrap an arbitrary driver with an injected key resolver. */
export function encryptingBlobStoreForTesting(
  inner: BlobStore,
  dekFor: DekResolver,
  forget?: (workspaceId?: string) => void,
): BlobStore {
  return new EncryptingBlobStore(inner, dekFor, forget);
}

/**
 * Memoized blob store. Uses R2 when the R2_* env vars are present, otherwise the
 * local filesystem driver (BLOB_DIR, default `.data/blobs`). Mirrors the
 * `use*` singleton convention used by usePrismaClient / useRedis.
 */
export function useBlobStore(): BlobStore {
  if (store) return store;
  store = resolveBlobStore();
  return store;
}

/** Test seam: force a specific store (used by storage tests). */
export function setStorageForTesting(custom: BlobStore): void {
  store = custom;
}