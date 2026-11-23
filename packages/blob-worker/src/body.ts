// The response body: plaintext pumped into a stream of declared length, with
// an exact count of the bytes the reader actually took.

type TransformLike = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/**
 * The stream the body is written into. On workerd, FixedLengthStream: the
 * runtime sends a ReadableStream chunked unless told its length, a media
 * element seeking through a video needs Content-Length, and it fails the
 * response if the body comes up short, so a cut-off stream never looks
 * complete. Elsewhere (the Node tests) a TransformStream with the same
 * no-buffer behaviour: a write completes only once the reader has taken it.
 */
function lengthStream(length: number): TransformLike {
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformLike })
    .FixedLengthStream;
  if (Fixed) return new Fixed(length);
  return new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 0 },
    { highWaterMark: 0 },
  );
}

/**
 * A body of exactly `length` bytes from `source`. `done` receives the bytes
 * the reader actually took (for a public share link, what its byte ceiling is
 * charged), once, however the body ends: finished, cut off, or abandoned.
 *
 * Counted as each write COMPLETES rather than as each chunk is decrypted. A
 * write into either stream above resolves only when the reader (the runtime,
 * sending to the client) has taken the chunk, so a decrypted chunk still
 * waiting when the client leaves is never charged. Counting on the way in
 * would charge up to a whole 1 MiB frame for a request cancelled before its
 * body was read.
 */
export function meteredBody(
  source: AsyncIterable<Uint8Array>,
  length: number,
  done: (sent: number) => void,
): ReadableStream<Uint8Array> {
  const { readable, writable } = lengthStream(length);
  const writer = writable.getWriter();
  void pump(source, writer).then(done);
  return readable;
}

/** Write `source` through `writer`, resolving to the bytes the reader took. */
async function pump(
  source: AsyncIterable<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<number> {
  const it = source[Symbol.asyncIterator]();
  let sent = 0;
  for (;;) {
    let next: IteratorResult<Uint8Array>;
    try {
      next = await it.next();
    } catch (err) {
      // Past the first chunk, a failure (a frame that will not authenticate)
      // can only cut the response off.
      console.error("[blob-worker] response cut off part way", err);
      await writer.abort(err).catch(() => {});
      return sent;
    }
    if (next.done) {
      await writer.close().catch(() => {});
      return sent;
    }
    try {
      await writer.write(next.value);
    } catch {
      // The reader went away (a client that left, a seek). Stop reading R2.
      await it.return?.();
      return sent;
    }
    sent += next.value.byteLength;
  }
}