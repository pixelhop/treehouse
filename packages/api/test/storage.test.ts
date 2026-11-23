import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { useTempBlobDir } from "./blob-env";

// Point the storage adapter at a throwaway temp dir and ensure no R2 vars are
// set, so useBlobStore() resolves to the local filesystem driver.
useTempBlobDir("treehouse-blobs-");

const { useBlobStore, resolveBlobStore, encryptingBlobStoreForTesting, splitBlobKey } =
  await import("../server/utils/storage");
const store = useBlobStore();

// A tiny but real binary: PNG signature + IHDR-ish bytes (not a valid image,
// but exercises non-UTF-8 round-tripping).
const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);

describe("blob storage (fs driver)", () => {
  it("round-trips text with its content-type", async () => {
    const key = "ws1/hash-text";
    await store.put(key, new TextEncoder().encode("# Hello"), "text/markdown");
    const got = await store.get(key);
    expect(got?.contentType).toBe("text/markdown");
    expect(new TextDecoder().decode(got?.body)).toBe("# Hello");
  });

  it("round-trips binary bytes intact", async () => {
    const key = "ws1/hash-bin";
    await store.put(key, binary, "image/png");
    const got = await store.get(key);
    expect(got?.contentType).toBe("image/png");
    expect(got?.body).toEqual(binary);
  });

  it("returns null for a missing key (callers map to 502/503)", async () => {
    expect(await store.get("ws1/does-not-exist")).toBeNull();
  });

  it("deletes a key", async () => {
    const key = "ws1/hash-del";
    await store.put(key, new TextEncoder().encode("x"), "text/plain");
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });
});

// U16: the production boot guard. `resolveBlobStore(env)` takes an explicit env
// so these don't depend on process.env or the memoized singleton.
const KEK_ENV = { BLOB_KEK: `v1:${randomBytes(32).toString("base64")}` };

const R2_ENV = {
  R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  R2_BUCKET: "bucket",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
};

/** The driver behind any encryption wrapper, for driver-selection assertions. */
function driverName(s: unknown): string {
  const inner = (s as { inner?: unknown }).inner;
  return (inner ?? s)?.constructor.name ?? "unknown";
}

describe("blob-driver boot guard (U16)", () => {
  it("refuses to boot in production with neither R2 config nor an explicit BLOB_DIR", () => {
    expect(() => resolveBlobStore({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /refuses to boot|not configured/i,
    );
    // The message names both valid configurations.
    try {
      resolveBlobStore({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as Error).message).toContain("R2_");
      expect((e as Error).message).toContain("BLOB_DIR");
    }
  });

  it("boots in production when the R2_* vars are set", () => {
    const s = resolveBlobStore({
      NODE_ENV: "production",
      ...R2_ENV,
      ...KEK_ENV,
    } as NodeJS.ProcessEnv);
    expect(driverName(s)).toBe("R2BlobStore");
  });

  it("boots in production when BLOB_DIR is set explicitly", () => {
    const s = resolveBlobStore({
      NODE_ENV: "production",
      BLOB_DIR: "/data/blobs",
      ...KEK_ENV,
    } as NodeJS.ProcessEnv);
    expect(driverName(s)).toBe("FsBlobStore");
  });

  it("boots in dev with no blob config (unchanged local default)", () => {
    const s = resolveBlobStore({} as NodeJS.ProcessEnv);
    expect(driverName(s)).toBe("FsBlobStore");
  });
});
// ---------------------------------------------------------------------------
// Encryption at the storage seam. The key resolver is injected, so these run
// against the real filesystem driver without a database.
// ---------------------------------------------------------------------------

const DEK_A = new Uint8Array(randomBytes(32));
const DEK_B = new Uint8Array(randomBytes(32));

const sha256 = (s: string) =>
  createHash("sha256").update(new TextEncoder().encode(s)).digest("hex");

const keyring: Record<string, Uint8Array> = { wsA: DEK_A, wsB: DEK_B };
const dekFor = async (workspaceId: string) => {
  const dek = keyring[workspaceId];
  if (!dek) throw new Error(`no key for ${workspaceId}`);
  return { dek, generation: 1 };
};

/** The bare fs driver over the same directory, for inspecting what really landed. */
const raw = resolveBlobStore({ BLOB_DIR: process.env.BLOB_DIR } as NodeJS.ProcessEnv);
const enc = encryptingBlobStoreForTesting(raw, dekFor);

describe("encrypting blob store", () => {
  it("round-trips text through the wrapper", async () => {
    const key = "wsA/enc-text";
    await enc.put(key, new TextEncoder().encode("# Hello"), "text/markdown");
    const got = await enc.get(key);
    expect(new TextDecoder().decode(got?.body)).toBe("# Hello");
    expect(got?.contentType).toBe("text/markdown");
  });

  it("round-trips binary through the wrapper", async () => {
    const key = "wsA/enc-bin";
    await enc.put(key, binary, "image/png");
    expect((await enc.get(key))?.body).toEqual(binary);
  });

  it("round-trips an empty file", async () => {
    const key = "wsA/enc-empty";
    await enc.put(key, new Uint8Array(0), "text/plain");
    expect((await enc.get(key))?.body).toEqual(new Uint8Array(0));
  });

  it("stores ciphertext, not the plaintext", async () => {
    // The assertion that catches a no-op wrapper: read the underlying object
    // directly and confirm the secret is not sitting in it.
    const key = "wsA/enc-secret";
    const secret = "correct-horse-battery-staple";
    await enc.put(key, new TextEncoder().encode(secret), "text/plain");

    const onDisk = await raw.get(key);
    expect(onDisk).not.toBeNull();
    expect(Buffer.from(onDisk?.body ?? new Uint8Array()).includes(secret)).toBe(false);
    expect(onDisk?.body.byteLength).toBeGreaterThan(secret.length);
  });

  it("leaves the blob key untouched (dedup and version pointers still work)", async () => {
    const key = "wsA/enc-keyshape";
    await enc.put(key, new TextEncoder().encode("x"), "text/plain");
    expect(await raw.get(key)).not.toBeNull();
  });

  it("keeps content-type as cleartext metadata", async () => {
    const key = "wsA/enc-ct";
    await enc.put(key, new TextEncoder().encode("x"), "image/webp");
    expect((await raw.get(key))?.contentType).toBe("image/webp");
  });

  it("reads legacy plaintext blobs written before encryption", async () => {
    // Keyed by the real content hash, as every blob written by files.ts is.
    const text = "# Written before encryption";
    const key = `wsA/${sha256(text)}`;
    await raw.put(key, new TextEncoder().encode(text), "text/markdown");
    const got = await enc.get(key);
    expect(new TextDecoder().decode(got?.body)).toBe(text);
    expect(got?.contentType).toBe("text/markdown");
  });

  it("refuses a legacy blob whose bytes do not match the hash it is keyed by", async () => {
    // Nothing authenticates a legacy plaintext object, so an attacker with
    // bucket WRITE access could otherwise replace an encrypted blob with
    // plaintext of their choosing and have it served as file content.
    const key = `wsA/${sha256("the real contents")}`;
    await raw.put(key, new TextEncoder().encode("SUBSTITUTED CONTENT"), "text/plain");
    await expect(enc.get(key)).rejects.toThrow(/content hash/);
  });

  it("refuses a blob that carries the marker but has an unreadable header", async () => {
    // Regression: this used to be classified as legacy plaintext, so the raw
    // ciphertext was handed back as the file body with no tag ever checked.
    const key = "wsA/marked-but-broken";
    await enc.put(key, new TextEncoder().encode("TOP-SECRET-CONTENTS"), "text/plain");
    const stored = await raw.get(key);
    const damaged = new Uint8Array(stored?.body ?? new Uint8Array());
    damaged[4] = 0x02; // format version 1 -> 2
    await raw.put(key, damaged, "text/plain");

    await expect(enc.get(key)).rejects.toThrow(/not readable by this build/);
  });

  it("still serves a legacy plaintext file that happens to begin with the marker", async () => {
    // A pre-encryption binary whose first four bytes collide with `THE\0` but
    // whose header does not parse. It is keyed by its real content hash, and
    // that hash is what proves it is the original plaintext, not our ciphertext.
    const body = Uint8Array.from([
      0x54,
      0x48,
      0x45,
      0x00,
      0x99,
      ...new Uint8Array(randomBytes(80)),
    ]);
    const key = `wsA/${createHash("sha256").update(body).digest("hex")}`;
    await raw.put(key, body, "application/octet-stream");
    expect((await enc.get(key))?.body).toEqual(body);
  });

  it("still serves a marker-colliding legacy file even when its bytes parse as a header", async () => {
    // Worst-case collision: the legacy bytes form a structurally valid header
    // (version 1, plausible chunk size), so the read path attempts a real
    // decryption first. Authentication fails, and the content-hash check is
    // what rescues the file instead of reporting tampering.
    const header = new Uint8Array(52);
    header.set([0x54, 0x48, 0x45, 0x00, 0x01], 0); // magic + version 1
    new DataView(header.buffer).setUint32(9, 1024, false); // valid chunk size
    const body = Uint8Array.from([...header, ...new Uint8Array(randomBytes(64))]);
    const key = `wsA/${createHash("sha256").update(body).digest("hex")}`;
    await raw.put(key, body, "application/octet-stream");
    expect((await enc.get(key))?.body).toEqual(body);

    // The streaming paths must report the FILE's size and ranges, not the
    // ones its lookalike header implies (which here would claim 48 bytes).
    const whole = await enc.open(key);
    expect(whole?.size).toBe(116);
    expect(await collect(whole!.body)).toEqual(body);
    const part = await enc.open(key, { start: 60, end: 70 });
    expect(part?.range).toEqual({ start: 60, end: 70 });
    expect(await collect(part!.body)).toEqual(body.subarray(60, 71));
    const tail = await enc.open(key, { suffix: 5 });
    expect(await collect(tail!.body)).toEqual(body.subarray(-5));
    expect((await enc.stat(key))?.size).toBe(116);
  });

  it("cannot read one workspace's blob with another workspace's key", async () => {
    const key = "wsA/cross";
    await enc.put(key, new TextEncoder().encode("alpha only"), "text/plain");
    // Same stored object, presented under wsB's key namespace.
    const stored = await raw.get(key);
    await raw.put("wsB/cross", stored?.body ?? new Uint8Array(), "text/plain");
    await expect(enc.get("wsB/cross")).rejects.toThrow();
  });

  it("returns null for a missing key (absence is not a decryption failure)", async () => {
    expect(await enc.get("wsA/does-not-exist")).toBeNull();
  });

  it("raises rather than returning null or partial bytes on a corrupted object", async () => {
    const key = "wsA/corrupt";
    await enc.put(key, new TextEncoder().encode("intact"), "text/plain");
    const stored = await raw.get(key);
    const damaged = new Uint8Array(stored?.body ?? new Uint8Array());
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0x01;
    await raw.put(key, damaged, "text/plain");

    await expect(enc.get(key)).rejects.toThrow();
  });

  it("leaves no object behind when the key cannot be resolved during put", async () => {
    // Encryption happens before the delegated put, so files.ts's
    // blob-before-metadata durability ordering is preserved: a failed write
    // never leaves a row pointing at unreadable bytes.
    const key = "wsMissing/never-written";
    await expect(enc.put(key, new TextEncoder().encode("x"), "text/plain")).rejects.toThrow();
    expect(await raw.get(key)).toBeNull();
  });

  it("delegates deletes", async () => {
    const key = "wsA/enc-del";
    await enc.put(key, new TextEncoder().encode("x"), "text/plain");
    await enc.delete(key);
    expect(await enc.get(key)).toBeNull();
  });
});

describe("blob key parsing", () => {
  it("splits a well-formed key", () => {
    expect(splitBlobKey("ws1/abc123")).toEqual({ workspaceId: "ws1", contentHash: "abc123" });
  });

  it.each([
    ["no slash", "abc123"],
    ["empty workspace", "/abc"],
    ["empty hash", "ws1/"],
    ["nested", "ws1/a/b"],
    ["empty", ""],
  ])("rejects a malformed key (%s)", (_label, key) => {
    expect(() => splitBlobKey(key)).toThrow(/load-bearing|not "/);
  });
});
// ---------------------------------------------------------------------------
// Streaming. putSource/open must agree with put/get byte for byte, serve exact
// ranges, and keep every integrity guarantee the buffered path has.
// ---------------------------------------------------------------------------

const { bufferSource, r2BlobStoreForTesting } = await import("../server/utils/storage");
const { collect, single } = await import("blob-io/byte-stream");
const { HEADER_BYTES, BlobDecryptError, openFrames, frameSpan, sealedLayout } =
  await import("blob-io/blob-crypto");

const MIB = 1024 * 1024;
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Byte equality for multi-megabyte arrays (toEqual walks them element by element). */
function expectBytes(actual: Uint8Array | undefined, expected: Uint8Array) {
  expect(actual?.byteLength).toBe(expected.byteLength);
  expect(Buffer.from(actual!).equals(Buffer.from(expected))).toBe(true);
}

/** A source whose stream arrives in uneven pieces, like a socket. */
function streamedSource(bytes: Uint8Array) {
  const src = bufferSource(bytes);
  return {
    ...src,
    open: async function* () {
      for (let i = 0; i < bytes.byteLength; i += 300_007) yield bytes.subarray(i, i + 300_007);
    },
  };
}

async function readAll(store: typeof enc, key: string, range?: Parameters<typeof enc.open>[1]) {
  const opened = await store.open(key, range);
  if (!opened) return null;
  return { ...opened, bytes: await collect(opened.body) };
}

describe("encrypting blob store, streaming", () => {
  // Three full chunks and a partial fourth, so ranges cross chunk boundaries.
  const big = new Uint8Array(randomBytes(3 * MIB + 12_345));
  const bigKey = `wsA/${hashOf(big)}`;

  it("stores a stream that reads back identically through get and open", async () => {
    await enc.putSource(bigKey, streamedSource(big), "video/mp4");
    expectBytes((await enc.get(bigKey))?.body, big);
    const opened = await readAll(enc, bigKey);
    expect(opened?.size).toBe(big.byteLength);
    expect(opened?.range).toBeNull();
    expect(opened?.contentType).toBe("video/mp4");
    expectBytes(opened?.bytes, big);
  });

  it("stores the encrypted format, not plaintext", async () => {
    const stored = await raw.get(bigKey);
    expect(stored?.body.byteLength).toBeGreaterThan(big.byteLength);
    expect(Buffer.from(stored!.body).includes(Buffer.from(big.subarray(MIB, MIB + 64)))).toBe(
      false,
    );
  });

  it("serves exact byte ranges across chunk boundaries", async () => {
    const cases: [number, number][] = [
      [0, 0],
      [0, MIB - 1],
      [MIB - 1, MIB],
      [MIB + 17, 3 * MIB + 99],
      [3 * MIB, big.byteLength - 1],
      [big.byteLength - 1, big.byteLength - 1],
    ];
    for (const [start, end] of cases) {
      const got = await readAll(enc, bigKey, { start, end });
      expect(got?.range).toEqual({ start, end });
      expect(got?.size).toBe(big.byteLength);
      expectBytes(got?.bytes, big.subarray(start, end + 1));
    }
  });

  it("resolves open-ended and suffix ranges, clamping past the end", async () => {
    expectBytes((await readAll(enc, bigKey, { start: 3 * MIB }))?.bytes, big.subarray(3 * MIB));
    expectBytes((await readAll(enc, bigKey, { suffix: 500 }))?.bytes, big.subarray(-500));
    expectBytes(
      (await readAll(enc, bigKey, { start: 10, end: 10 * MIB }))?.bytes,
      big.subarray(10),
    );
  });

  it("reports an unsatisfiable range with the real size", async () => {
    const got = await readAll(enc, bigKey, { start: big.byteLength });
    expect(got?.range).toBe("unsatisfiable");
    expect(got?.size).toBe(big.byteLength);
    expect(got?.bytes.byteLength).toBe(0);
  });

  it("round-trips an empty file", async () => {
    const empty = new Uint8Array(0);
    const key = `wsA/${hashOf(empty)}`;
    await enc.putSource(key, bufferSource(empty), "text/plain");
    const got = await readAll(enc, key);
    expect(got?.size).toBe(0);
    expect(got?.bytes.byteLength).toBe(0);
    expect((await readAll(enc, key, { start: 0 }))?.range).toBe("unsatisfiable");
  });

  it("refuses a source whose key does not match its hash", async () => {
    await expect(enc.putSource(`wsA/${"0".repeat(64)}`, bufferSource(binary), "x")).rejects.toThrow(
      /does not match/,
    );
  });

  it("stores nothing when the bytes change between spooling and sealing", async () => {
    const body = new Uint8Array(randomBytes(2 * MIB));
    const key = `wsA/${hashOf(body)}`;
    const lying = {
      ...bufferSource(body),
      open: async function* () {
        const changed = new Uint8Array(body);
        changed[MIB + 3] = changed[MIB + 3]! ^ 0xff;
        yield changed;
      },
    };
    await expect(enc.putSource(key, lying, "x")).rejects.toThrow(/changed while being stored/);
    expect(await enc.open(key)).toBeNull();
  });

  it("returns null for a missing key", async () => {
    expect(await enc.open(`wsA/${"9".repeat(64)}`)).toBeNull();
    expect(await enc.open(`wsA/${"9".repeat(64)}`, { start: 0 })).toBeNull();
  });

  it("serves legacy plaintext whole and in ranges, verified by hash", async () => {
    const text = new TextEncoder().encode("legacy plaintext, written before encryption");
    const key = `wsA/${hashOf(text)}`;
    await raw.put(key, text, "text/plain");
    expectBytes((await readAll(enc, key))?.bytes, text);
    const part = await readAll(enc, key, { start: 7, end: 15 });
    expect(part?.range).toEqual({ start: 7, end: 15 });
    expectBytes(part?.bytes, text.subarray(7, 16));
  });

  it("refuses substituted legacy plaintext on both open paths", async () => {
    const key = `wsA/${sha256("the real content")}`;
    await raw.put(key, new TextEncoder().encode("attacker content"), "text/plain");
    await expect(enc.open(key)).rejects.toThrow(/does not match its content hash/);
    await expect(enc.open(key, { start: 0, end: 3 })).rejects.toThrow(
      /does not match its content hash/,
    );
  });

  it("fails rather than serve a tampered chunk, but still serves untouched ranges", async () => {
    const body = new Uint8Array(randomBytes(3 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    const stored = (await raw.get(key))!.body;
    const tampered = new Uint8Array(stored);
    // A byte inside the third chunk's frame.
    const at = HEADER_BYTES + 2 * (MIB + 16) + 100;
    tampered[at] = tampered[at]! ^ 0x01;
    await raw.put(key, tampered, "x");

    // The first two chunks are intact and authenticate.
    expectBytes(
      (await readAll(enc, key, { start: 0, end: 2 * MIB - 1 }))?.bytes,
      body.subarray(0, 2 * MIB),
    );
    // A range starting in the broken chunk fails before sending anything.
    await expect(readAll(enc, key, { start: 2 * MIB, end: 2 * MIB + 5 })).rejects.toThrow();
    // The whole file fails part way through rather than serving the bad chunk.
    await expect(readAll(enc, key)).rejects.toThrow();
  });
});

describe("fs driver, streaming (no encryption)", () => {
  it("stores a stream and serves ranges of it", async () => {
    const body = new Uint8Array(randomBytes(2 * MIB + 3));
    const key = `wsZ/${hashOf(body)}`;
    await raw.putSource(key, streamedSource(body), "application/octet-stream");
    expectBytes((await readAll(raw, key))?.bytes, body);
    expectBytes(
      (await readAll(raw, key, { start: MIB, end: MIB + 9 }))?.bytes,
      body.subarray(MIB, MIB + 10),
    );
    expectBytes((await readAll(raw, key, { suffix: 4 }))?.bytes, body.subarray(-4));
    expect((await readAll(raw, key, { start: body.byteLength }))?.range).toBe("unsatisfiable");
  });

  it("leaves nothing at the key when the stream fails", async () => {
    const key = "wsZ/failing";
    const failing = {
      size: 10,
      sha256: "x",
      open: async function* () {
        yield new Uint8Array(4);
        throw new Error("client went away");
      },
    };
    await expect(raw.putSource(key, failing, "x")).rejects.toThrow(/client went away/);
    expect(await raw.open(key)).toBeNull();
  });
});

describe("r2 driver, streaming", () => {
  /** A stand-in S3 client that records commands and answers like R2. */
  function fakeS3(object: Uint8Array) {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = cmd.constructor.name;
        sent.push({ name, input: cmd.input });
        if (name === "PutObjectCommand") {
          const body = cmd.input.Body as AsyncIterable<Uint8Array>;
          return { stored: await collect(body) };
        }
        if (name === "HeadObjectCommand")
          return { ContentLength: object.byteLength, ContentType: "x" };
        if (name === "GetObjectCommand") {
          const header = cmd.input.Range as string | undefined;
          if (!header) {
            return {
              Body: (async function* () {
                yield object;
              })(),
              ContentLength: object.byteLength,
              ContentType: "x",
            };
          }
          const m = /^bytes=(\d*)-(\d*)$/.exec(header)!;
          let start = m[1] === "" ? object.byteLength - Number(m[2]) : Number(m[1]);
          let end = m[1] !== "" && m[2] !== "" ? Number(m[2]) : object.byteLength - 1;
          start = Math.max(0, start);
          end = Math.min(end, object.byteLength - 1);
          if (start >= object.byteLength) {
            throw Object.assign(new Error("InvalidRange"), {
              name: "InvalidRange",
              $metadata: { httpStatusCode: 416 },
            });
          }
          return {
            Body: (async function* () {
              yield object.subarray(start, end + 1);
            })(),
            ContentLength: end - start + 1,
            ContentRange: `bytes ${start}-${end}/${object.byteLength}`,
            ContentType: "x",
          };
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    return { client, sent };
  }

  it("streams a put with its declared length", async () => {
    const { client, sent } = fakeS3(new Uint8Array(0));
    const r2 = r2BlobStoreForTesting(client as never);
    const body = new Uint8Array(randomBytes(70_000));
    await r2.putSource("ws/k", streamedSource(body), "x");
    expect(sent[0]?.name).toBe("PutObjectCommand");
    expect(sent[0]?.input.ContentLength).toBe(body.byteLength);
  });

  it("rejects, rather than hanging, when the body fails part way through a put", async () => {
    // What the real SDK does (see storage-s3.test.ts): it reads the body but
    // ignores the body's errors, and only gives up when the request is aborted.
    const client = {
      send(
        cmd: { input: { Body: AsyncIterable<Uint8Array> } },
        opts?: { abortSignal?: AbortSignal },
      ) {
        return new Promise((_, reject) => {
          opts?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
          void (async () => {
            try {
              for await (const _ of cmd.input.Body);
            } catch {
              // swallowed, like the SDK
            }
          })();
        });
      },
    };
    const r2 = r2BlobStoreForTesting(client as never);
    const failing = {
      size: 10,
      sha256: "x",
      open: async function* () {
        yield new Uint8Array(4);
        throw new Error("client went away");
      },
    };
    await expect(r2.putSource("ws/k", failing, "x")).rejects.toThrow(/client went away/);
  });

  it("asks R2 for the range and reports the real size", async () => {
    const object = new Uint8Array(randomBytes(1000));
    const { client, sent } = fakeS3(object);
    const r2 = r2BlobStoreForTesting(client as never);
    const got = await readAll(r2 as typeof enc, "ws/k", { start: 100, end: 199 });
    expect(sent[0]?.input.Range).toBe("bytes=100-199");
    expect(got?.size).toBe(1000);
    expect(got?.range).toEqual({ start: 100, end: 199 });
    expectBytes(got?.bytes, object.subarray(100, 200));
    expectBytes(
      (await readAll(r2 as typeof enc, "ws/k", { suffix: 10 }))?.bytes,
      object.subarray(-10),
    );
  });

  it("turns R2's 416 into an unsatisfiable range with the object's size", async () => {
    const { client } = fakeS3(new Uint8Array(50));
    const r2 = r2BlobStoreForTesting(client as never);
    const got = await r2.open("ws/k", { start: 50 });
    expect(got?.range).toBe("unsatisfiable");
    expect(got?.size).toBe(50);
  });

  it("works end to end under the encrypting wrapper", async () => {
    // Seal through the wrapper into the fs driver, then serve those exact
    // stored bytes from the fake R2 to exercise the ranged-GET path.
    const body = new Uint8Array(randomBytes(2 * MIB + 77));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    const stored = (await raw.get(key))!.body;
    const { client } = fakeS3(stored);
    const r2enc = encryptingBlobStoreForTesting(r2BlobStoreForTesting(client as never), dekFor);
    expectBytes((await readAll(r2enc, key))?.bytes, body);
    expectBytes(
      (await readAll(r2enc, key, { start: MIB - 3, end: MIB + 3 }))?.bytes,
      body.subarray(MIB - 3, MIB + 4),
    );
  });
});
describe("encrypting blob store, cancellation", () => {
  /** The fs driver, with a flag recording when a body's source was closed. */
  function tracking() {
    const closed: string[] = [];
    const store = {
      ...raw,
      put: raw.put.bind(raw),
      putSource: raw.putSource.bind(raw),
      get: raw.get.bind(raw),
      stat: raw.stat.bind(raw),
      delete: raw.delete.bind(raw),
      async open(key: string, range?: Parameters<typeof raw.open>[1]) {
        const opened = await raw.open(key, range);
        if (!opened) return null;
        const inner = opened.body;
        const label = range ? "range" : "whole";
        async function* body() {
          try {
            yield* inner;
          } finally {
            closed.push(label);
          }
        }
        return { ...opened, body: body() };
      },
    };
    return { store: encryptingBlobStoreForTesting(store, dekFor), closed };
  }

  it("closes the storage stream when a reader stops part way", async () => {
    const body = new Uint8Array(randomBytes(4 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    const { store, closed } = tracking();

    for (const range of [undefined, { start: 10, end: 3 * MIB }]) {
      const opened = await store.open(key, range);
      const it = opened!.body[Symbol.asyncIterator]();
      await it.next(); // one chunk, then the client goes away
      await it.return?.();
    }
    // The whole read, and the frames fetch of the ranged one, were closed.
    expect(closed).toContain("whole");
    expect(closed).toContain("range");
  });
});
describe("encrypting blob store, review round two", () => {
  /** The fs driver, instrumented: counts buffered reads and runs a hook between reads. */
  function instrumented(onOpen?: (range: unknown) => Promise<void>) {
    const calls = { get: 0, open: 0 };
    const store = {
      put: raw.put.bind(raw),
      putSource: raw.putSource.bind(raw),
      stat: raw.stat.bind(raw),
      delete: raw.delete.bind(raw),
      async get(key: string) {
        calls.get++;
        return raw.get(key);
      },
      async open(key: string, range?: Parameters<typeof raw.open>[1]) {
        calls.open++;
        await onOpen?.(range);
        return raw.open(key, range);
      },
    };
    return { store, calls };
  }

  it("re-reads, rather than buffering, when a blob is re-sealed between header and frames", async () => {
    const body = new Uint8Array(randomBytes(3 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    let resealed = false;
    const { store, calls } = instrumented(async (range) => {
      // Just before the first frames read, the same content is sealed again
      // (fresh salt, same size), as a concurrent identical upload would.
      const r = range as { start: number } | undefined;
      if (!resealed && r && r.start > 0) {
        resealed = true;
        await enc.putSource(key, bufferSource(body), "x");
      }
    });
    const reader = encryptingBlobStoreForTesting(store, dekFor);
    const got = await reader.open(key, { start: MIB + 5, end: MIB + 14 });
    expectBytes(await collect(got!.body), body.subarray(MIB + 5, MIB + 15));
    expect(resealed).toBe(true);
    expect(calls.get).toBe(0);
  });

  /** Seal `body` again (fresh salt, same size) just before the first read past the header. */
  function resealingReader(key: string, body: Uint8Array) {
    let resealed = false;
    const { store, calls } = instrumented(async (range) => {
      const r = range as { start: number } | undefined;
      if (!resealed && r && r.start > 0) {
        resealed = true;
        await enc.putSource(key, bufferSource(body), "x");
      }
    });
    return {
      reader: encryptingBlobStoreForTesting(store, dekFor),
      calls,
      resealed: () => resealed,
    };
  }

  it("stat re-reads a large blob re-sealed between header and first chunk", async () => {
    // Over the lookalike buffer limit, so a wrong fallback would throw.
    const body = new Uint8Array(randomBytes(17 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    const { reader, calls, resealed } = resealingReader(key, body);
    expect(await reader.stat(key)).toEqual({ size: body.byteLength, contentType: "x" });
    expect(resealed()).toBe(true);
    expect(calls.get).toBe(0);
  });

  it("a range past the end still gets a 416 when the blob is re-sealed mid-check", async () => {
    const body = new Uint8Array(randomBytes(17 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    const { reader, calls, resealed } = resealingReader(key, body);
    const got = await reader.open(key, { start: body.byteLength + 10 });
    expect(got?.range).toBe("unsatisfiable");
    expect(got?.size).toBe(body.byteLength);
    expect(resealed()).toBe(true);
    expect(calls.get).toBe(0);
  });

  it("refuses a large blob that looks encrypted but will not open, without buffering it", async () => {
    // A valid-looking header in front of 17 MiB that is not ciphertext.
    const header = new Uint8Array(52);
    header.set([0x54, 0x48, 0x45, 0x00, 0x01], 0);
    new DataView(header.buffer).setUint32(9, MIB, false);
    const bytes = new Uint8Array(52 + 17 * MIB);
    bytes.set(header, 0);
    const key = `wsA/${hashOf(bytes)}`;
    await raw.put(key, bytes, "x");
    const { store, calls } = instrumented();
    const reader = encryptingBlobStoreForTesting(store, dekFor);
    await expect(reader.open(key)).rejects.toThrow(BlobDecryptError);
    await expect(reader.open(key, { start: 0, end: 9 })).rejects.toThrow(BlobDecryptError);
    expect(calls.get).toBe(0);
  });

  it("refuses a large blob with a damaged header, without buffering it", async () => {
    // A real encrypted blob whose format-version byte has been flipped: it
    // still carries the marker, so it must not be served as plaintext, and at
    // this size the buffered legacy check must not run either.
    const body = new Uint8Array(randomBytes(17 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    const stored = new Uint8Array((await raw.get(key))!.body);
    stored[4] = 0x7f;
    await raw.put(key, stored, "x");
    const { store, calls } = instrumented();
    const reader = encryptingBlobStoreForTesting(store, dekFor);
    await expect(reader.open(key)).rejects.toThrow(BlobDecryptError);
    await expect(reader.open(key, { start: 0, end: 9 })).rejects.toThrow(BlobDecryptError);
    expect(calls.get).toBe(0);
  });

  it("closes every storage body it opened when the workspace key cannot be resolved", async () => {
    // The key is chosen by the generation in the blob's header, so the header
    // has to be read first; what matters is that nothing is left open.
    const body = new Uint8Array(randomBytes(2 * MIB));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "x");
    let opened = 0;
    let closed = 0;
    const store = {
      ...instrumented().store,
      async open(k: string, range?: Parameters<typeof raw.open>[1]) {
        const o = await raw.open(k, range);
        if (!o) return o;
        opened++;
        // A ranged header read is drained by the reader, which ends it; a body
        // left unread is only released by close().
        let done = false;
        const body = (async function* () {
          try {
            yield* o.body;
          } finally {
            if (!done) closed++;
            done = true;
          }
        })();
        return {
          ...o,
          body,
          close: () => {
            if (!done) closed++;
            done = true;
            o.close?.();
          },
        };
      },
    };
    const reader = encryptingBlobStoreForTesting(store, async () => {
      throw new Error("retired KEK missing");
    });
    await expect(reader.open(key)).rejects.toThrow(/retired KEK missing/);
    await expect(reader.open(key, { start: 0, end: 9 })).rejects.toThrow(/retired KEK missing/);
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
  });
});

// ---------------------------------------------------------------------------
// Handing a blob to the byte Worker: the header and the one key that opens it,
// and only for blobs the Worker can serve without a whole-file check.
// ---------------------------------------------------------------------------

describe("encrypting blob store, sealed handoff", () => {
  /** The fs driver, counting whole-object and ranged reads. */
  function counting() {
    const calls = { get: 0, open: 0 };
    const store = {
      put: raw.put.bind(raw),
      putSource: raw.putSource.bind(raw),
      stat: raw.stat.bind(raw),
      delete: raw.delete.bind(raw),
      async get(key: string) {
        calls.get++;
        return raw.get(key);
      },
      async open(key: string, range?: Parameters<typeof raw.open>[1]) {
        calls.open++;
        return raw.open(key, range);
      },
    };
    return { store, calls };
  }

  /** Decrypt `key`'s stored object with only what `sealed` handed over, as the Worker does. */
  async function openAsWorker(
    key: string,
    handed: { header: Uint8Array; key: Uint8Array; size: number },
  ) {
    const layout = sealedLayout(handed.header, handed.size)!;
    const span = frameSpan(layout, null);
    const stored = (await raw.get(key))!.body;
    expect(stored.byteLength).toBe(layout.storedSize);
    return collect(
      openFrames(
        handed.header,
        layout,
        span.first,
        span.last,
        single(stored.subarray(span.storedStart, span.storedEnd + 1)),
        handed.key,
      ),
    );
  }

  it("hands over a key that opens exactly this blob, from the header read alone", async () => {
    const body = new Uint8Array(randomBytes(2 * MIB + 3));
    const key = `wsA/${hashOf(body)}`;
    await enc.putSource(key, bufferSource(body), "video/mp4");
    const { store, calls } = counting();
    const reader = encryptingBlobStoreForTesting(store, dekFor);
    const handed = (await reader.sealed!(key, body.byteLength))!;
    expect(handed.size).toBe(body.byteLength);
    expect(handed.contentType).toBe("video/mp4");
    expect(handed.header.byteLength).toBe(HEADER_BYTES);
    // Never the workspace DEK itself.
    expect(Buffer.from(handed.key).equals(Buffer.from(DEK_A))).toBe(false);
    expectBytes(await openAsWorker(key, handed), body);
    // One ranged read of the header; no whole-object read.
    expect(calls.open).toBe(1);
    expect(calls.get).toBe(0);
  });

  it("authenticates the first chunk instead when no size is known", async () => {
    const body = new Uint8Array(randomBytes(1000));
    const key = `wsA/${hashOf(body)}`;
    await enc.put(key, body, "image/png");
    const handed = (await enc.sealed!(key))!;
    expectBytes(await openAsWorker(key, handed), body);
  });

  it("keeps legacy plaintext, damaged blobs and lookalikes on the API", async () => {
    const legacy = new TextEncoder().encode("# written before encryption");
    const legacyKey = `wsA/${hashOf(legacy)}`;
    await raw.put(legacyKey, legacy, "text/markdown");
    expect(await enc.sealed!(legacyKey, legacy.byteLength)).toBeNull();

    // A legacy file whose first bytes form a valid header: its real size is
    // its stored size, which a genuine sealed blob's header can never imply.
    const header = new Uint8Array(52);
    header.set([0x54, 0x48, 0x45, 0x00, 0x01], 0);
    new DataView(header.buffer).setUint32(9, 1024, false);
    const lookalike = Uint8Array.from([...header, ...new Uint8Array(randomBytes(64))]);
    const lookKey = `wsA/${hashOf(lookalike)}`;
    await raw.put(lookKey, lookalike, "application/octet-stream");
    expect(await enc.sealed!(lookKey, lookalike.byteLength)).toBeNull();
    expect(await enc.sealed!(lookKey)).toBeNull();

    const sealedBody = new Uint8Array(randomBytes(100));
    const damagedKey = `wsA/${hashOf(sealedBody)}`;
    await enc.put(damagedKey, sealedBody, "x");
    const damaged = new Uint8Array((await raw.get(damagedKey))!.body);
    damaged[4] = 0x7f; // format version
    await raw.put(damagedKey, damaged, "x");
    expect(await enc.sealed!(damagedKey, sealedBody.byteLength)).toBeNull();
  });

  it("returns null for a missing blob or a size the metadata disagrees with", async () => {
    expect(await enc.sealed!("wsA/does-not-exist", 10)).toBeNull();
    const body = new Uint8Array(randomBytes(300));
    const key = `wsA/${hashOf(body)}`;
    await enc.put(key, body, "x");
    expect(await enc.sealed!(key, body.byteLength + 1)).toBeNull();
  });

  it("has nothing to hand over without encryption", () => {
    expect("sealed" in raw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Key rotation: blobs name the data-key generation they were sealed under, and
// every read picks that generation's key, so a rotation can re-encrypt a
// workspace while both old and new blobs stay readable.
// ---------------------------------------------------------------------------

const { deriveBlobKey, HEADER_BYTES: HEADER } = await import("blob-io/blob-crypto");
const { keyRotationStoreOf } = await import("../server/utils/storage");

describe("encrypting blob store, key generations", () => {
  function rotating() {
    const generations = new Map<number, Uint8Array>([[1, new Uint8Array(randomBytes(32))]]);
    let current = 1;
    const forgotten: (string | undefined)[] = [];
    const resolve = (async (_ws: string, generation?: number) => {
      const g = generation ?? current;
      const dek = generations.get(g);
      if (!dek) {
        if (generation === undefined) throw new Error("no current key");
        return null;
      }
      return { dek, generation: g };
    }) as never;
    const store = encryptingBlobStoreForTesting(raw, resolve, (ws) => forgotten.push(ws));
    return {
      store,
      rotation: keyRotationStoreOf(store)!,
      generations,
      forgotten,
      rotate() {
        current++;
        generations.set(current, new Uint8Array(randomBytes(32)));
      },
      destroy(g: number) {
        generations.delete(g);
      },
    };
  }

  const ws = () => `wsGen${randomBytes(4).toString("hex")}`;

  it("reads a blob sealed under an older generation by every path", async () => {
    const r = rotating();
    const body = new Uint8Array(randomBytes(3 * MIB + 17));
    const key = `${ws()}/${hashOf(body)}`;
    await r.store.putSource(key, bufferSource(body), "video/mp4");
    const firstKey = r.generations.get(1)!;
    r.rotate();

    expect(hashOf((await r.store.get(key))!.body)).toBe(hashOf(body));
    const whole = await r.store.open(key);
    expect(hashOf(await collect(whole!.body))).toBe(hashOf(body));
    const part = await r.store.open(key, { start: MIB, end: MIB + 99 });
    expect(await collect(part!.body)).toEqual(body.subarray(MIB, MIB + 100));
    expect((await r.store.stat(key))?.size).toBe(body.byteLength);

    const sealed = await r.store.sealed!(key, body.byteLength);
    expect(sealed).not.toBeNull();
    const { workspaceId, contentHash } = splitBlobKey(key);
    const stored = (await raw.get(key))!.body;
    expect(sealed!.key).toEqual(
      deriveBlobKey(firstKey, stored.subarray(0, HEADER), { workspaceId, contentHash }),
    );
  });

  it("stamps new writes with the generation in use", async () => {
    const r = rotating();
    r.rotate();
    const body = new TextEncoder().encode("after rotation");
    const key = `${ws()}/${hashOf(body)}`;
    await r.store.put(key, body, "text/plain");
    expect(await r.rotation.sealedGeneration(key)).toBe(2);
  });

  it("refuses, rather than misreads, a blob whose generation is gone", async () => {
    const r = rotating();
    const body = new Uint8Array(randomBytes(300));
    const key = `${ws()}/${hashOf(body)}`;
    await r.store.put(key, body, "x");
    r.rotate();
    r.destroy(1);

    await expect(r.store.get(key)).rejects.toThrow(/decrypt|generation/);
    await expect(r.store.open(key)).rejects.toThrow();
    await expect(r.store.open(key, { start: 0, end: 9 })).rejects.toThrow();
    expect(await r.store.sealed!(key, body.byteLength)).toBeNull();
  });

  it("re-seals small and large blobs under the current generation, bytes unchanged", async () => {
    const r = rotating();
    const w = ws();
    const small = new Uint8Array(randomBytes(4096));
    const large = new Uint8Array(randomBytes(17 * MIB));
    const smallKey = `${w}/${hashOf(small)}`;
    const largeKey = `${w}/${hashOf(large)}`;
    await r.store.put(smallKey, small, "image/png");
    await r.store.putSource(largeKey, bufferSource(large), "video/mp4");
    r.rotate();

    expect(await r.rotation.reseal(smallKey)).toBe(true);
    expect(await r.rotation.reseal(largeKey)).toBe(true);

    r.destroy(1);
    expect(await r.rotation.sealedGeneration(smallKey)).toBe(2);
    expect(await r.rotation.sealedGeneration(largeKey)).toBe(2);
    expect((await r.store.get(smallKey))?.body).toEqual(small);
    expect((await r.store.get(smallKey))?.contentType).toBe("image/png");
    expect(hashOf(await collect((await r.store.open(largeKey))!.body))).toBe(hashOf(large));
    expect((await r.store.stat(largeKey))?.contentType).toBe("video/mp4");
  });

  it("encrypts a legacy plaintext blob when re-sealing it", async () => {
    const r = rotating();
    const body = new TextEncoder().encode("written before encryption existed");
    const key = `${ws()}/${hashOf(body)}`;
    await raw.put(key, body, "text/plain");
    expect(await r.rotation.sealedGeneration(key)).toBe("legacy");

    expect(await r.rotation.reseal(key)).toBe(true);
    expect(await r.rotation.sealedGeneration(key)).toBe(1);
    expect((await raw.get(key))!.body).not.toEqual(body);
    expect((await r.store.get(key))?.body).toEqual(body);
  });

  it("streams a large legacy plaintext blob into its encrypted form", async () => {
    const r = rotating();
    const body = new Uint8Array(randomBytes(17 * MIB));
    const key = `${ws()}/${hashOf(body)}`;
    await raw.put(key, body, "application/zip");
    expect(await r.rotation.reseal(key)).toBe(true);
    expect(await r.rotation.sealedGeneration(key)).toBe(1);
    expect(hashOf(await collect((await r.store.open(key))!.body))).toBe(hashOf(body));
    expect((await r.store.stat(key))?.contentType).toBe("application/zip");
  });

  it("refuses to re-seal large legacy bytes that do not match their hash", async () => {
    const r = rotating();
    const body = new Uint8Array(randomBytes(17 * MIB));
    const key = `${ws()}/${hashOf(new Uint8Array(randomBytes(8)))}`;
    await raw.put(key, body, "application/zip");
    await expect(r.rotation.reseal(key)).rejects.toThrow();
    expect(await r.rotation.sealedGeneration(key)).toBe("legacy");
    expect(hashOf((await raw.get(key))!.body)).toBe(hashOf(body));
  });

  it("re-seals an icon, whose key is not a bare content hash", async () => {
    const r = rotating();
    const icon = new Uint8Array(randomBytes(2048));
    const key = `${ws()}/icon-${hashOf(icon)}`;
    await r.store.put(key, icon, "image/png");
    r.rotate();
    expect(await r.rotation.reseal(key)).toBe(true);
    r.destroy(1);
    expect((await r.store.get(key))?.body).toEqual(icon);
  });

  it("reports a damaged marker as malformed and an absent blob as null", async () => {
    const r = rotating();
    const body = new Uint8Array(randomBytes(100));
    const key = `${ws()}/${hashOf(body)}`;
    await r.store.put(key, body, "x");
    const damaged = new Uint8Array((await raw.get(key))!.body);
    damaged[4] = 0x7f; // format version
    await raw.put(key, damaged, "x");
    expect(await r.rotation.sealedGeneration(key)).toBe("malformed");
    expect(await r.rotation.sealedGeneration(`${ws()}/missing`)).toBeNull();
    expect(await r.rotation.reseal(`${ws()}/missing`)).toBe(false);
  });

  it("lists one workspace's objects and nothing else", async () => {
    const r = rotating();
    const w = ws();
    const a = new TextEncoder().encode("a");
    const b = new TextEncoder().encode("b");
    await r.store.put(`${w}/${hashOf(a)}`, a, "text/plain");
    await r.store.put(`${w}/icon-${hashOf(b)}`, b, "image/png");
    await r.store.put(`${ws()}/${hashOf(b)}`, b, "text/plain");

    const listed: string[] = [];
    for await (const o of r.rotation.list(`${w}/`)) listed.push(o.key);
    expect(listed.sort()).toEqual([`${w}/${hashOf(a)}`, `${w}/icon-${hashOf(b)}`].sort());
    const none: string[] = [];
    for await (const o of r.rotation.list(`${ws()}/`)) none.push(o.key);
    expect(none).toEqual([]);
  });

  it("fails the listing, rather than skipping an object, when one cannot be read", async () => {
    const r = rotating();
    const w = ws();
    const body = new TextEncoder().encode("still needs its key");
    await r.store.put(`${w}/${hashOf(body)}`, body, "text/plain");
    // Readable but not searchable: readdir works, stat of each entry fails.
    const dir = `${process.env.BLOB_DIR}/${w}`;
    const { chmod } = await import("node:fs/promises");
    await chmod(dir, 0o444);
    try {
      const listed: string[] = [];
      await expect(
        (async () => {
          for await (const o of r.rotation.list(`${w}/`)) listed.push(o.key);
        })(),
      ).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it("purges only interrupted-write leftovers older than asked", async () => {
    const r = rotating();
    const w = ws();
    const body = new TextEncoder().encode("whole");
    const key = `${w}/${hashOf(body)}`;
    await r.store.put(key, body, "text/plain");
    const { utimes, writeFile } = await import("node:fs/promises");
    const dir = `${process.env.BLOB_DIR}/${w}`;
    await writeFile(`${dir}/${hashOf(body)}.partial-old`, "x");
    await writeFile(`${dir}/${hashOf(body)}.partial-new`, "x");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(`${dir}/${hashOf(body)}.partial-old`, old, old);

    expect(await r.rotation.purgeAbandoned(`${w}/`, new Date(Date.now() - 60 * 60_000))).toEqual({
      purged: 1,
      remaining: 1,
    });
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((n) => n.includes(".partial-"))).toEqual([
      `${hashOf(body)}.partial-new`,
    ]);
    expect((await r.store.get(key))?.body).toEqual(body);
  });

  it("passes forgetKeys through to the key service", () => {
    const r = rotating();
    r.rotation.forgetKeys("wsX");
    expect(r.forgotten).toEqual(["wsX"]);
  });

  it("has no rotation surface without encryption", () => {
    expect(keyRotationStoreOf(raw)).toBeNull();
  });
});