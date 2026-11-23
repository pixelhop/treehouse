import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
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
  frameSpan,
  HEADER_BYTES,
  openFrames,
  sealedLayout,
} from "../src/blob-crypto";
import { sliceStream } from "../src/byte-stream";

const DEK = randomBytes(32);
const OTHER_DEK = randomBytes(32);
const WS = "ws-alpha";
const HASH = "a".repeat(64);

// Small chunk size so multi-chunk framing is exercised without megabyte buffers.
const CHUNK = 64;
const ctx = { workspaceId: WS, contentHash: HASH, chunkSize: CHUNK };

function roundTrip(plain: Uint8Array, chunkSize = CHUNK): Uint8Array {
  const stored = encryptBlob(plain, DEK, { ...ctx, chunkSize });
  return decryptBlob(stored, DEK, { workspaceId: WS, contentHash: HASH });
}

/** Flip one bit at `index` in a copy of `bytes`. */
function corrupt(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  // biome-ignore lint/style/noNonNullAssertion: index is bounds-checked by callers
  copy[index] = copy[index]! ^ 0x01;
  return copy;
}

describe("blob-crypto round-trip", () => {
  it("round-trips utf-8 text byte-exactly", () => {
    const plain = new TextEncoder().encode("# Hello — café 🌳\n");
    expect(roundTrip(plain)).toEqual(plain);
  });

  it("round-trips binary bytes that are not valid utf-8", () => {
    const plain = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
    ]);
    expect(roundTrip(plain)).toEqual(plain);
  });

  it("round-trips an empty file", () => {
    const plain = new Uint8Array(0);
    const stored = encryptBlob(plain, DEK, ctx);
    // Even an empty file must carry a header plus one authenticated final chunk,
    // so truncation to nothing is still detectable.
    expect(stored.byteLength).toBeGreaterThan(HEADER_BYTES);
    expect(decryptBlob(stored, DEK, { workspaceId: WS, contentHash: HASH })).toEqual(plain);
  });

  it("round-trips a payload spanning several chunks", () => {
    const plain = randomBytes(CHUNK * 4 + 7);
    expect(roundTrip(plain)).toEqual(new Uint8Array(plain));
  });

  it("round-trips a payload exactly on a chunk boundary", () => {
    for (const size of [CHUNK, CHUNK * 2, CHUNK * 3]) {
      const plain = randomBytes(size);
      expect(roundTrip(plain)).toEqual(new Uint8Array(plain));
    }
  });

  it("round-trips a payload one byte either side of a chunk boundary", () => {
    for (const size of [CHUNK - 1, CHUNK + 1]) {
      const plain = randomBytes(size);
      expect(roundTrip(plain)).toEqual(new Uint8Array(plain));
    }
  });

  it("produces different ciphertext for identical plaintext each time", () => {
    const plain = new TextEncoder().encode("same bytes");
    const a = encryptBlob(plain, DEK, ctx);
    const b = encryptBlob(plain, DEK, ctx);
    expect(a).not.toEqual(b);
    // ...but both still decrypt to the same plaintext.
    expect(decryptBlob(a, DEK, { workspaceId: WS, contentHash: HASH })).toEqual(
      decryptBlob(b, DEK, { workspaceId: WS, contentHash: HASH }),
    );
  });

  it("does not leave the plaintext visible in the stored bytes", () => {
    const secret = "correct-horse-battery-staple";
    const stored = encryptBlob(new TextEncoder().encode(secret), DEK, ctx);
    expect(Buffer.from(stored).includes(secret)).toBe(false);
  });
});

describe("blob-crypto integrity", () => {
  const plain = randomBytes(CHUNK * 2 + 5);
  const stored = encryptBlob(plain, DEK, ctx);
  const open = () => decryptBlob(stored, DEK, { workspaceId: WS, contentHash: HASH });

  it("decrypts the untampered blob (control for the cases below)", () => {
    expect(open()).toEqual(new Uint8Array(plain));
  });

  it("rejects a flipped bit in the ciphertext body", () => {
    const bad = corrupt(stored, HEADER_BYTES + 3);
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects a flipped bit in the header (header is authenticated as AAD)", () => {
    // Byte 5 is inside keyGeneration — a field that is not otherwise consulted
    // during decryption, so only AAD authentication can catch this.
    const bad = corrupt(stored, 5);
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects a flipped bit in the salt", () => {
    const bad = corrupt(stored, 13);
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects a truncated final chunk", () => {
    const bad = stored.slice(0, stored.byteLength - (CHUNK + 16));
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects truncation on an exact chunk boundary (this is what the final flag is for)", () => {
    // The case above fails on a garbage tag and would still fail without the
    // final-chunk flag. THIS one is the flag's reason to exist: with a payload
    // that is an exact multiple of the chunk size, lopping off the last whole
    // chunk leaves a byte-perfect prefix of valid frames. Without the flag the
    // new last chunk decrypts under the same nonce it was sealed with, and the
    // truncation is silent.
    const exact = randomBytes(CHUNK * 3);
    const full = encryptBlob(exact, DEK, ctx);
    const lopped = full.slice(0, full.byteLength - (CHUNK + 16));
    expect(() => decryptBlob(lopped, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects truncation of an empty file to nothing", () => {
    const empty = encryptBlob(new Uint8Array(0), DEK, ctx);
    expect(() =>
      decryptBlob(empty.slice(0, HEADER_BYTES), DEK, { workspaceId: WS, contentHash: HASH }),
    ).toThrow(BlobDecryptError);
  });

  it("rejects a blob truncated to only its header", () => {
    const bad = stored.slice(0, HEADER_BYTES);
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects swapped chunks (counter is bound into the nonce)", () => {
    const framed = CHUNK + 16;
    const bad = new Uint8Array(stored);
    const first = stored.slice(HEADER_BYTES, HEADER_BYTES + framed);
    const second = stored.slice(HEADER_BYTES + framed, HEADER_BYTES + framed * 2);
    bad.set(second, HEADER_BYTES);
    bad.set(first, HEADER_BYTES + framed);
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects a duplicated chunk", () => {
    const framed = CHUNK + 16;
    const bad = new Uint8Array(stored);
    bad.set(stored.slice(HEADER_BYTES, HEADER_BYTES + framed), HEADER_BYTES + framed);
    expect(() => decryptBlob(bad, DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("rejects the wrong data key", () => {
    expect(() => decryptBlob(stored, OTHER_DEK, { workspaceId: WS, contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });
});

describe("blob-crypto context binding", () => {
  const plain = new TextEncoder().encode("workspace alpha's secret");
  const stored = encryptBlob(plain, DEK, ctx);

  it("refuses to decrypt as a different workspace, even with the same key", () => {
    expect(() => decryptBlob(stored, DEK, { workspaceId: "ws-beta", contentHash: HASH })).toThrow(
      BlobDecryptError,
    );
  });

  it("refuses to decrypt under a different content hash", () => {
    expect(() =>
      decryptBlob(stored, DEK, { workspaceId: WS, contentHash: "b".repeat(64) }),
    ).toThrow(BlobDecryptError);
  });
});

describe("blob-crypto classification", () => {
  it("does not classify ordinary text as encrypted", () => {
    expect(classifyBlob(new TextEncoder().encode("# Just a markdown file\n"))).toBe("legacy");
  });

  it("does not classify a PNG header as encrypted", () => {
    expect(classifyBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "legacy",
    );
  });

  it("does not classify empty bytes as encrypted", () => {
    expect(classifyBlob(new Uint8Array(0))).toBe("legacy");
  });

  it("does not classify bytes shorter than a header as encrypted", () => {
    expect(classifyBlob(randomBytes(HEADER_BYTES - 1))).toBe("legacy");
  });

  it("classifies a real encrypted blob as encrypted", () => {
    expect(classifyBlob(encryptBlob(new TextEncoder().encode("x"), DEK, ctx))).toBe("encrypted");
  });

  it("calls a marked blob with an implausible chunk size MALFORMED, never legacy", () => {
    // Regression: this previously classified as legacy, so the storage wrapper
    // handed the raw ciphertext back as file content with no tag ever checked.
    const bad = new Uint8Array(encryptBlob(new TextEncoder().encode("x"), DEK, ctx));
    new DataView(bad.buffer, bad.byteOffset).setUint32(9, 0, false); // chunkSize = 0
    expect(classifyBlob(bad)).toBe("malformed");
  });

  it("calls a marked blob with an unknown format version MALFORMED", () => {
    // Also covers a blob written by a newer build and read by a rolled-back one.
    const bad = new Uint8Array(encryptBlob(new TextEncoder().encode("x"), DEK, ctx));
    bad[4] = 0x02;
    expect(classifyBlob(bad)).toBe("malformed");
  });

  it("calls a marked blob that is too short to frame MALFORMED", () => {
    const bad = encryptBlob(new TextEncoder().encode("x"), DEK, ctx).slice(0, HEADER_BYTES - 2);
    expect(classifyBlob(bad)).toBe("malformed");
  });
});

describe("blob-crypto header", () => {
  it("exposes the key generation without decrypting the body", () => {
    const stored = encryptBlob(new TextEncoder().encode("x"), DEK, { ...ctx, keyGeneration: 7 });
    const view = new DataView(stored.buffer, stored.byteOffset);
    expect(view.getUint32(5, false)).toBe(7);
  });

  it("defaults the key generation to 1", () => {
    const stored = encryptBlob(new TextEncoder().encode("x"), DEK, ctx);
    const view = new DataView(stored.buffer, stored.byteOffset);
    expect(view.getUint32(5, false)).toBe(1);
  });

  it("rejects a data key that is not 32 bytes", () => {
    expect(() => encryptBlob(new Uint8Array(1), randomBytes(16), ctx)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Streaming. These functions must speak exactly the format the whole-buffer
// ones do: old blobs are read by the new path and new blobs by the old one.
// ---------------------------------------------------------------------------

/** Feed `bytes` as a stream of uneven pieces, the way a socket delivers them. */
async function* pieces(bytes: Uint8Array, sizes = [1, 7, 64, 3, 129]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let i = 0;
  while (offset < bytes.byteLength) {
    const n = sizes[i++ % sizes.length]!;
    yield bytes.subarray(offset, offset + n);
    offset += n;
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

function sealStream(plain: Uint8Array): Promise<Uint8Array> {
  return collect(encryptChunks(pieces(plain), plain.byteLength, DEK, ctx));
}

/** Decrypt chunks first..last of `stored` through the streaming path. */
function openChunks(
  stored: Uint8Array,
  first: number,
  last: number,
  decryptCtx = { workspaceId: WS, contentHash: HASH },
) {
  const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
  const start = layout.frameOffset(first);
  const end = layout.frameOffset(last) + layout.frameLength(last);
  return collect(
    decryptFrames(
      stored.subarray(0, HEADER_BYTES),
      layout,
      first,
      last,
      pieces(stored.subarray(start, end)),
      DEK,
      decryptCtx,
    ),
  );
}

const SIZES = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 5 * CHUNK, 5 * CHUNK + 7];

describe("blob-crypto streaming compatibility", () => {
  it.each(SIZES)("a %i-byte blob sealed as a stream opens with decryptBlob", async (size) => {
    const plain = new Uint8Array(randomBytes(size));
    const stored = await sealStream(plain);
    expect(decryptBlob(stored, DEK, { workspaceId: WS, contentHash: HASH })).toEqual(plain);
  });

  it.each(SIZES)("a %i-byte blob sealed whole opens through decryptFrames", async (size) => {
    const plain = new Uint8Array(randomBytes(size));
    const stored = encryptBlob(plain, DEK, ctx);
    const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    expect(layout.plaintextSize).toBe(size);
    expect(await openChunks(stored, 0, layout.chunkCount - 1)).toEqual(plain);
  });

  it("sealed whole and sealed as a stream have the same length", async () => {
    const plain = new Uint8Array(randomBytes(3 * CHUNK + 5));
    expect((await sealStream(plain)).byteLength).toBe(encryptBlob(plain, DEK, ctx).byteLength);
  });
});

describe("blob-crypto streaming ranges", () => {
  it("decrypts every contiguous chunk range to the matching plaintext slice", async () => {
    const plain = new Uint8Array(randomBytes(5 * CHUNK + 7));
    const stored = encryptBlob(plain, DEK, ctx);
    const { chunkCount } = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    expect(chunkCount).toBe(6);
    for (let first = 0; first < chunkCount; first++) {
      for (let last = first; last < chunkCount; last++) {
        const expected = plain.subarray(
          first * CHUNK,
          Math.min((last + 1) * CHUNK, plain.byteLength),
        );
        expect(await openChunks(stored, first, last)).toEqual(expected);
      }
    }
  });

  it("refuses a chunk range outside the blob", async () => {
    const stored = encryptBlob(new Uint8Array(2 * CHUNK), DEK, ctx);
    await expect(openChunks(stored, 1, 2)).rejects.toThrow(RangeError);
  });

  it("works out the layout from the header prefix alone", () => {
    const stored = encryptBlob(new Uint8Array(2 * CHUNK + 1), DEK, ctx);
    const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    expect(layout.chunkCount).toBe(3);
    expect(layout.frameOffset(0)).toBe(HEADER_BYTES);
    const last = layout.chunkCount - 1;
    expect(layout.frameOffset(last) + layout.frameLength(last)).toBe(stored.byteLength);
  });
});

describe("blob-crypto streaming integrity", () => {
  it("rejects a flipped bit inside the requested chunk", async () => {
    const stored = encryptBlob(new Uint8Array(3 * CHUNK), DEK, ctx);
    const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    const tampered = corrupt(stored, layout.frameOffset(1) + 3);
    await expect(openChunks(tampered, 1, 1)).rejects.toThrow(BlobDecryptError);
  });

  it("rejects truncation at a chunk boundary when the new last chunk is read", async () => {
    const stored = encryptBlob(new Uint8Array(3 * CHUNK), DEK, ctx);
    const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    const truncated = stored.subarray(0, layout.frameOffset(2));
    await expect(openChunks(truncated, 1, 1)).rejects.toThrow(BlobDecryptError);
  });

  it("rejects frames taken from the wrong position (the counter is in the nonce)", async () => {
    const stored = encryptBlob(new Uint8Array(randomBytes(3 * CHUNK)), DEK, ctx);
    const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    const frame0 = stored.subarray(layout.frameOffset(0), layout.frameOffset(1));
    const frames = (async function* () {
      yield frame0;
    })();
    const decrypt = decryptFrames(stored.subarray(0, HEADER_BYTES), layout, 1, 1, frames, DEK, {
      workspaceId: WS,
      contentHash: HASH,
    });
    await expect(collect(decrypt)).rejects.toThrow(BlobDecryptError);
  });

  it("refuses to open under a different content hash", async () => {
    const stored = encryptBlob(new Uint8Array(CHUNK), DEK, ctx);
    await expect(
      openChunks(stored, 0, 0, { workspaceId: WS, contentHash: "b".repeat(64) }),
    ).rejects.toThrow(BlobDecryptError);
  });

  it("fails when the frames stream is shorter than the range", async () => {
    const stored = encryptBlob(new Uint8Array(2 * CHUNK), DEK, ctx);
    const layout = encryptedLayout(stored.subarray(0, HEADER_BYTES), stored.byteLength)!;
    const frames = pieces(stored.subarray(layout.frameOffset(0), layout.frameOffset(1) - 1));
    const decrypt = decryptFrames(stored.subarray(0, HEADER_BYTES), layout, 0, 0, frames, DEK, {
      workspaceId: WS,
      contentHash: HASH,
    });
    await expect(collect(decrypt)).rejects.toThrow(BlobDecryptError);
  });

  it("refuses to seal a stream that is shorter or longer than declared", async () => {
    const plain = new Uint8Array(2 * CHUNK);
    await expect(
      collect(encryptChunks(pieces(plain), plain.byteLength + 1, DEK, ctx)),
    ).rejects.toThrow(/ended before/);
    await expect(
      collect(encryptChunks(pieces(plain), plain.byteLength - 1, DEK, ctx)),
    ).rejects.toThrow(/longer than/);
  });
});

describe("blob-crypto prefix classification", () => {
  it("classifies from the header prefix and total size", () => {
    const stored = encryptBlob(new Uint8Array(3 * CHUNK), DEK, ctx);
    expect(classifyBlobPrefix(stored.subarray(0, HEADER_BYTES), stored.byteLength)).toBe(
      "encrypted",
    );
    expect(classifyBlobPrefix(new TextEncoder().encode("# notes"), 7)).toBe("legacy");
  });

  it("calls a marked prefix too short to frame MALFORMED", () => {
    const stored = encryptBlob(new Uint8Array(0), DEK, ctx);
    expect(classifyBlobPrefix(stored.subarray(0, HEADER_BYTES), HEADER_BYTES)).toBe("malformed");
  });

  it("agrees with classifyBlob on whole blobs", () => {
    const stored = encryptBlob(new Uint8Array(CHUNK), DEK, ctx);
    const bad = corrupt(stored, 4);
    for (const bytes of [stored, bad, new TextEncoder().encode("hello")]) {
      expect(classifyBlobPrefix(bytes.subarray(0, HEADER_BYTES), bytes.byteLength)).toBe(
        classifyBlob(bytes),
      );
    }
  });
});

describe("blob-crypto per-blob keys (the byte Worker's way in)", () => {
  const dctx = { workspaceId: WS, contentHash: HASH };

  /** Decrypt a byte range the way the Worker does: frameSpan, openFrames, slice. */
  async function rangeWithKey(stored: Uint8Array, key: Uint8Array, start: number, end: number) {
    const header = stored.subarray(0, HEADER_BYTES);
    const size = encryptedLayout(header, stored.byteLength)!.plaintextSize;
    const layout = sealedLayout(header, size)!;
    const span = frameSpan(layout, { start, end });
    const frames = pieces(stored.subarray(span.storedStart, span.storedEnd + 1));
    return collect(
      sliceStream(
        openFrames(header, layout, span.first, span.last, frames, key),
        span.skip,
        span.take,
      ),
    );
  }

  it("opens every byte range exactly as the DEK would, chunk boundaries included", async () => {
    const plain = new Uint8Array(randomBytes(4 * CHUNK + 9));
    const stored = encryptBlob(plain, DEK, ctx);
    const key = deriveBlobKey(DEK, stored.subarray(0, HEADER_BYTES), dctx);
    const edges = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 4 * CHUNK - 1, 4 * CHUNK + 8];
    for (const start of edges) {
      for (const end of edges) {
        if (end < start) continue;
        expect(await rangeWithKey(stored, key, start, end)).toEqual(plain.subarray(start, end + 1));
      }
    }
  });

  it("is a different key for every blob, even of the same bytes", () => {
    const plain = new Uint8Array(randomBytes(CHUNK));
    const a = encryptBlob(plain, DEK, ctx);
    const b = encryptBlob(plain, DEK, ctx);
    const ka = deriveBlobKey(DEK, a.subarray(0, HEADER_BYTES), dctx);
    expect(ka).not.toEqual(deriveBlobKey(DEK, b.subarray(0, HEADER_BYTES), dctx));
    expect(ka).not.toEqual(new Uint8Array(DEK));
  });

  it("does not open another blob, or one bound to another workspace", async () => {
    const plain = new Uint8Array(randomBytes(2 * CHUNK));
    const stored = encryptBlob(plain, DEK, ctx);
    const other = encryptBlob(plain, DEK, ctx);
    const otherKey = deriveBlobKey(DEK, other.subarray(0, HEADER_BYTES), dctx);
    await expect(rangeWithKey(stored, otherKey, 0, 10)).rejects.toThrow(BlobDecryptError);
    const wrongWs = deriveBlobKey(DEK, stored.subarray(0, HEADER_BYTES), {
      workspaceId: "ws-beta",
      contentHash: HASH,
    });
    await expect(rangeWithKey(stored, wrongWs, 0, 10)).rejects.toThrow(BlobDecryptError);
  });

  it("refuses a key of the wrong length", async () => {
    const stored = encryptBlob(new Uint8Array(CHUNK), DEK, ctx);
    await expect(rangeWithKey(stored, new Uint8Array(16), 0, 1)).rejects.toThrow(BlobDecryptError);
  });

  it("works out the stored layout from the header and the plaintext size alone", () => {
    for (const size of SIZES) {
      const stored = encryptBlob(new Uint8Array(size), DEK, ctx);
      const layout = sealedLayout(stored.subarray(0, HEADER_BYTES), size)!;
      expect(layout.storedSize).toBe(stored.byteLength);
      expect(layout.plaintextSize).toBe(size);
    }
    const header = encryptBlob(new Uint8Array(1), DEK, ctx).subarray(0, HEADER_BYTES);
    expect(sealedLayout(header, -1)).toBeNull();
    expect(sealedLayout(new TextEncoder().encode("x".repeat(HEADER_BYTES)), 3)).toBeNull();
  });

  it("spans the whole blob, an empty one included, when no range is given", () => {
    const empty = encryptBlob(new Uint8Array(0), DEK, ctx);
    const layout = sealedLayout(empty.subarray(0, HEADER_BYTES), 0)!;
    expect(frameSpan(layout, null)).toEqual({
      first: 0,
      last: 0,
      storedStart: HEADER_BYTES,
      storedEnd: empty.byteLength - 1,
      skip: 0,
      take: 0,
    });
  });
});