// Small helpers for byte streams (`AsyncIterable<Uint8Array>`), which is the
// shape file bodies take between the request, the encryption layer and the
// blob store. Kept free of Node stream classes so the same code can run in a
// Worker later.

/**
 * Re-slice a byte stream into pieces of exactly the given lengths, in order.
 * Throws through `fail` if the stream is shorter or longer than the lengths
 * add up to: a stream that disagrees with its declared size must never be
 * stored or served as if it were whole.
 */
export async function* exactSlices(
  source: AsyncIterable<Uint8Array>,
  lengths: Iterable<number>,
  fail: (message: string) => Error,
): AsyncGenerator<Uint8Array> {
  const reader = new ExactReader(source, fail);
  const lens = lengths[Symbol.iterator]();
  let current = lens.next();
  try {
    while (!current.done) {
      const following = lens.next();
      const slice = await reader.take(current.value);
      // Confirm the stream really ends here BEFORE handing over the last slice.
      // A source that checks something at its end (a hash, say) then fails while
      // the consumer can still refuse the whole body, rather than after the last
      // byte has already been written somewhere.
      if (following.done) await reader.assertEnded();
      yield slice;
      current = following;
    }
  } finally {
    // Drives its source by hand, so a consumer that stops early (a client
    // disconnecting mid-download) must be passed on explicitly, or the storage
    // connection or file descriptor underneath stays open.
    await reader.close();
  }
}

/** Pulls exact-length pieces off a byte stream, carrying any overshoot forward. */
class ExactReader {
  #it: AsyncIterator<Uint8Array>;
  #fail: (message: string) => Error;
  #pending: Buffer[] = [];
  #pendingBytes = 0;

  constructor(source: AsyncIterable<Uint8Array>, fail: (message: string) => Error) {
    this.#it = source[Symbol.asyncIterator]();
    this.#fail = fail;
  }

  async take(length: number): Promise<Uint8Array> {
    while (this.#pendingBytes < length) {
      const next = await this.#it.next();
      if (next.done) throw this.#fail("stream ended before the expected length");
      this.#pending.push(asBuffer(next.value));
      this.#pendingBytes += next.value.byteLength;
    }
    const joined =
      this.#pending.length === 1
        ? this.#pending[0]!
        : Buffer.concat(this.#pending, this.#pendingBytes);
    const rest = joined.subarray(length);
    this.#pending = rest.byteLength ? [rest] : [];
    this.#pendingBytes = rest.byteLength;
    return new Uint8Array(joined.buffer, joined.byteOffset, length);
  }

  async close(): Promise<void> {
    await this.#it.return?.();
  }

  async assertEnded(): Promise<void> {
    if (this.#pendingBytes > 0) throw this.#fail("stream is longer than the expected length");
    for (;;) {
      const next = await this.#it.next();
      if (next.done) return;
      if (next.value.byteLength > 0) throw this.#fail("stream is longer than the expected length");
    }
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read a whole byte stream into one array. Only for bodies known to be small. */
export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  }
  const joined = Buffer.concat(parts);
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}

/** A stream of one array (empty arrays yield nothing). */
export async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes;
}

/**
 * Skip the first `skip` bytes of a stream and stop after `take` more. Used to
 * trim decrypted whole chunks down to the exact byte range a client asked for.
 */
export async function* sliceStream(
  source: AsyncIterable<Uint8Array>,
  skip: number,
  take: number,
): AsyncGenerator<Uint8Array> {
  let toSkip = skip;
  let left = take;
  for await (const piece of source) {
    if (left <= 0) return;
    let view = piece;
    if (toSkip > 0) {
      if (view.byteLength <= toSkip) {
        toSkip -= view.byteLength;
        continue;
      }
      view = view.subarray(toSkip);
      toSkip = 0;
    }
    if (view.byteLength > left) view = view.subarray(0, left);
    left -= view.byteLength;
    if (view.byteLength > 0) yield view;
  }
}

/**
 * Read at least `n` bytes from the front of a stream without losing any: the
 * returned `rest` replays whatever was read past `n` before continuing the
 * original stream. `head` is shorter than `n` only when the stream is.
 */
export async function peek(
  source: AsyncIterable<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: AsyncIterable<Uint8Array> }> {
  const it = source[Symbol.asyncIterator]();
  const parts: Buffer[] = [];
  let have = 0;
  let done = false;
  while (have < n) {
    const next = await it.next();
    if (next.done) {
      done = true;
      break;
    }
    parts.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
    have += next.value.byteLength;
  }
  const joined = Buffer.concat(parts, have);
  const head = new Uint8Array(joined.buffer, joined.byteOffset, Math.min(n, have));
  const over = joined.subarray(head.byteLength);
  async function* rest(): AsyncGenerator<Uint8Array> {
    try {
      if (over.byteLength > 0) yield new Uint8Array(over.buffer, over.byteOffset, over.byteLength);
      if (done) return;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // Same as exactSlices: pass an early stop on to the source.
      await it.return?.();
    }
  }
  return { head, rest: rest() };
}

/**
 * Pull the first piece of a stream now, so a failure in it (a chunk that won't
 * authenticate) surfaces here, before a caller commits to response headers,
 * rather than once the body is already being sent. The returned stream replays
 * that piece and carries on.
 */
export async function primed(
  source: AsyncIterable<Uint8Array>,
): Promise<AsyncIterable<Uint8Array>> {
  const it = source[Symbol.asyncIterator]();
  const first = await it.next();
  async function* replay(): AsyncGenerator<Uint8Array> {
    try {
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await it.return?.();
    }
  }
  return replay();
}