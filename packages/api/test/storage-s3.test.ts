import { createHash, randomBytes } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vite-plus/test";

// The R2 driver against a REAL S3-compatible server, through the real AWS SDK:
// streamed PUTs with a declared length, ranged GETs and their Content-Range,
// 416 for a range past the end, and HEAD for a missing key. storage.test.ts
// covers the same driver against a stand-in client; this proves the SDK and a
// server agree with that stand-in.
//
// Skipped unless S3_TEST_ENDPOINT points at a server, e.g. SeaweedFS:
//   docker run --rm -p 127.0.0.1:8333:8333 chrislusf/seaweedfs server -s3
//   S3_TEST_ENDPOINT=http://127.0.0.1:8333 vp test packages/api/test/storage-s3.test.ts

const ENDPOINT = process.env.S3_TEST_ENDPOINT;

const { r2BlobStoreForTesting, encryptingBlobStoreForTesting, bufferSource } =
  await import("../server/utils/storage");
const { collect } = await import("blob-io/byte-stream");

const MIB = 1024 * 1024;
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));

describe.skipIf(!ENDPOINT)("r2 driver against a real S3-compatible server", () => {
  // Vitest runs a skipped describe's body to collect its tests, so nothing here
  // may touch the network until beforeAll.
  const client = new S3Client({
    region: "auto",
    endpoint: ENDPOINT ?? "http://127.0.0.1:1",
    // Path-style for a server on localhost; R2 accepts either style.
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "test",
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const bucket = `treehouse-test-${Date.now()}`;
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  const raw = r2BlobStoreForTesting(client, bucket);
  const dek = new Uint8Array(randomBytes(32));
  const store = encryptingBlobStoreForTesting(raw, async () => ({ dek, generation: 1 }));

  const body = new Uint8Array(randomBytes(5 * MIB + 333));
  const key = `ws1/${hashOf(body)}`;
  const streamed = {
    ...bufferSource(body),
    open: async function* () {
      for (let i = 0; i < body.byteLength; i += 700_001) yield body.subarray(i, i + 700_001);
    },
  };

  it("stores a streamed, encrypted body and reads it back whole", async () => {
    await store.putSource(key, streamed, "video/mp4");
    expect(same((await store.get(key))?.body, body)).toBe(true);
    const opened = await store.open(key);
    expect(opened?.size).toBe(body.byteLength);
    expect(opened?.contentType).toBe("video/mp4");
    expect(same(await collect(opened!.body), body)).toBe(true);
  });

  it("serves byte ranges across chunk boundaries", async () => {
    for (const [start, end] of [
      [0, 9],
      [MIB - 5, MIB + 5],
      [2 * MIB + 1, 4 * MIB + 2],
      [body.byteLength - 1, body.byteLength - 1],
    ] as const) {
      const got = await store.open(key, { start, end });
      expect(got?.range).toEqual({ start, end });
      expect(same(await collect(got!.body), body.subarray(start, end + 1))).toBe(true);
    }
    const tail = await store.open(key, { suffix: 64 });
    expect(same(await collect(tail!.body), body.subarray(-64))).toBe(true);
  });

  it("reports a range past the end as unsatisfiable with the real size", async () => {
    const got = await store.open(key, { start: body.byteLength + 10 });
    expect(got?.range).toBe("unsatisfiable");
    expect(got?.size).toBe(body.byteLength);
  });

  it("stats without reading, and reports a missing key as absent", async () => {
    expect(await store.stat(key)).toEqual({ size: body.byteLength, contentType: "video/mp4" });
    const missing = `ws1/${"0".repeat(64)}`;
    expect(await store.stat(missing)).toBeNull();
    expect(await store.open(missing)).toBeNull();
    expect(await store.open(missing, { start: 0 })).toBeNull();
    expect(await store.get(missing)).toBeNull();
  });

  it("leaves nothing behind when the bytes change before sealing finishes", async () => {
    const other = new Uint8Array(randomBytes(2 * MIB));
    const otherKey = `ws1/${hashOf(other)}`;
    const lying = {
      ...bufferSource(other),
      open: async function* () {
        const changed = new Uint8Array(other);
        changed[MIB] = changed[MIB]! ^ 0xff;
        yield changed;
      },
    };
    await expect(store.putSource(otherKey, lying, "x")).rejects.toThrow();
    expect(await raw.stat(otherKey)).toBeNull();
  });
});