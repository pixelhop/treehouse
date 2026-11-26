import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createError, type H3Event } from "h3";
import { single } from "blob-io/byte-stream";
import type { BlobSource } from "./storage";

/**
 * Read a request body with a hard byte ceiling, aborting the moment the
 * accumulated size exceeds `limit` so memory stays bounded even for a chunked
 * upload that omits or lies about Content-Length. Reads `event.node.req`
 * directly — NOT `readRawBody` (buffers unbounded) and NOT `toWebRequest(event)`
 * (locks the body stream and hangs PUT/POST — a documented repo footgun).
 *
 * On overflow it stops accumulating and throws whatever `onOverflow` returns;
 * the error response is written by the error handler. Two deliberate choices in
 * that path:
 *
 * - It does NOT destroy the request. Tearing the stream down mid-upload races
 *   the client and can swallow the response the client needs to see.
 * - It DOES set `Connection: close`. The rest of the body is never read, and
 *   under HTTP/1.1 keep-alive that remainder would be framed as the next
 *   request — so the connection cannot be reused (RFC 9112 §9.6 says as much for
 *   a server that answers before reading the whole body). Announcing the close
 *   is what lets a pooling client retire the socket instead of sending its next
 *   request into a connection that is about to die under it.
 *
 * Draining the remainder instead was tried and is worse: the client normally
 * stops writing the moment it sees the response, so the drain just blocks on a
 * body that never arrives until the socket times out.
 */
export async function readBodyCapped(
  event: H3Event,
  limit: number,
  onOverflow: (limit: number) => unknown,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const buf of cappedChunks(event, limit, onOverflow)) chunks.push(buf);
  return Buffer.concat(chunks);
}

/** The request body's chunks, stopping at `limit` the way readBodyCapped describes. */
async function* cappedChunks(
  event: H3Event,
  limit: number,
  onOverflow: (limit: number) => unknown,
): AsyncGenerator<Buffer> {
  let total = 0;
  try {
    for await (const chunk of event.node.req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > limit) {
        if (!event.node.res.headersSent) event.node.res.setHeader("Connection", "close");
        throw onOverflow(limit);
      }
      yield buf;
    }
  } catch (err) {
    if (!isClientAbort(err)) throw err;
    throw clientClosed(event, total);
  }
}

/**
 * The client hung up part way through sending the body: Node rejects the read
 * with `aborted` / ECONNRESET. Nothing failed on our side and nobody is left to
 * answer, so this is reported as a handled 499 rather than escaping as an
 * unhandled 500. An unhandled error is logged with its stack and the full
 * request URL (which names the file) and reported as a server exception. For
 * a sync client re-sending a large file that is still being written, that was
 * most of the API's error logging.
 */
function isClientAbort(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ECONNRESET";
}

function clientClosed(event: H3Event, received: number) {
  // One line, no path: enough to see that uploads are being cut off and how far
  // they got, without putting file names in the logs.
  const declared = event.node.req.headers?.["content-length"];
  console.warn(
    `[upload] client closed the request after ${received} bytes${declared ? ` of ${declared}` : ""}`,
  );
  return createError({
    statusCode: 499,
    statusMessage: "Client Closed Request",
    data: { error: "client_closed" },
  });
}
/**
 * Bodies up to this size stay in memory; larger ones spill to a temp file.
 * Most writes are documents well under it, so they never touch the disk.
 */
const SPOOL_IN_MEMORY_BYTES = 4 * 1024 * 1024;

/**
 * A request body read in full and hashed, ready to store as a stream. Call
 * `dispose()` when done with it (a `finally`), which removes any temp file.
 */
export interface SpooledBody extends BlobSource {
  dispose(): Promise<void>;
}

/**
 * Read a request body like `readBodyCapped` (same ceiling, same overflow
 * handling) but without holding a large one in memory: past
 * SPOOL_IN_MEMORY_BYTES it is written to a temp file instead. The SHA-256 is
 * computed on the way in, because blobs are named and keyed by it and so the
 * whole body has to be seen before it can be encrypted.
 */
export async function spoolBodyCapped(
  event: H3Event,
  limit: number,
  onOverflow: (limit: number) => unknown,
): Promise<SpooledBody> {
  const spool = new Spool();
  try {
    for await (const buf of cappedChunks(event, limit, onOverflow)) await spool.add(buf);
    // Inside the try: a failed close must remove the temp file too.
    return await spool.finish();
  } catch (err) {
    await spool.discard();
    throw err;
  }
}

/** `write` may store fewer bytes than asked; keep going until the whole buffer is on disk. */
async function writeFully(handle: FileHandle, buf: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
    if (bytesWritten === 0) throw new Error("temp file write made no progress");
    offset += bytesWritten;
  }
}

/** Accumulates a body in memory, moving it to a temp file once it gets large. */
class Spool {
  #hash = createHash("sha256");
  #memory: Buffer[] = [];
  #size = 0;
  #file: { path: string; handle: FileHandle } | null = null;

  async add(buf: Buffer): Promise<void> {
    this.#hash.update(buf);
    this.#size += buf.length;
    if (this.#file) {
      await writeFully(this.#file.handle, buf);
      return;
    }
    this.#memory.push(buf);
    if (this.#size > SPOOL_IN_MEMORY_BYTES) await this.#spill();
  }

  async #spill(): Promise<void> {
    const dir = join(tmpdir(), "treehouse-uploads");
    await mkdir(dir, { recursive: true });
    const path = join(dir, randomUUID());
    this.#file = { path, handle: await open(path, "w", 0o600) };
    for (const piece of this.#memory) await writeFully(this.#file.handle, piece);
    this.#memory = [];
  }

  async finish(): Promise<SpooledBody> {
    const size = this.#size;
    const sha256 = this.#hash.digest("hex");
    if (!this.#file) {
      const bytes = Buffer.concat(this.#memory, size);
      const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { size, sha256, open: () => single(view), dispose: async () => {} };
    }
    await this.#file.handle.close();
    const { path } = this.#file;
    return {
      size,
      sha256,
      open: () => createReadStream(path),
      dispose: () => rm(path, { force: true }),
    };
  }

  async discard(): Promise<void> {
    if (!this.#file) return;
    await this.#file.handle.close().catch(() => {});
    await rm(this.#file.path, { force: true });
  }
}