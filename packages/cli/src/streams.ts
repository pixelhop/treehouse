// Byte-stream helpers for moving file contents without holding a whole file in
// memory. A body is an `AsyncIterable<Uint8Array>`: what a fetch response body,
// a file read stream and a generator all are.
import { createHash, type Hash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";

export type ByteStream = AsyncIterable<Uint8Array>;

/** A stream of one array (an empty array yields nothing). */
export async function* once(bytes: Uint8Array): ByteStream {
  if (bytes.byteLength > 0) yield bytes;
}

/** Read a whole stream into one array. Only for bodies known to be small. */
export async function collect(stream: ByteStream): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const part of stream)
    parts.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  return new Uint8Array(Buffer.concat(parts));
}

/** A file's contents as a stream, feeding each piece to `hash` on the way past. */
export async function* hashedFile(abs: string, hash: Hash): ByteStream {
  for await (const chunk of createReadStream(abs)) {
    const piece = chunk as Buffer;
    hash.update(piece);
    yield piece;
  }
}

const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * SHA-256 of a file, read a megabyte at a time. Synchronous because the scan
 * is, and memory stays at one chunk however large the file.
 */
export function sha256OfFile(abs: string): string {
  const hash = createHash("sha256");
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const n = readSync(fd, buf, 0, HASH_CHUNK_BYTES, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}