import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { deriveBlobKey, encryptBlob, HEADER_BYTES } from "blob-io/blob-crypto";
import { grantKeyRing, mintGrant, openUsageReport } from "blob-io/blob-grant";
import { createTestHarness, type TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The Worker in real workerd (the runtime `wrangler dev` and Cloudflare use),
// built from wrangler.jsonc with nodejs_compat. What this proves that the
// plain-function tests cannot: workerd's node:crypto (AES-256-GCM decipher,
// HKDF, HMAC) and Buffer open bytes sealed by Node's, so sharing blob-io
// between the API and the Worker is sound; R2 ranged reads line up with the
// frames; and the response carries real Content-Length and Content-Range.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = `t1:${randomBytes(32).toString("base64")}`;
const DEK = new Uint8Array(randomBytes(32));
const WS = "ws-runtime";
// The production chunk size: 1 MiB frames, so ranges cross real boundaries.
const MIB = 1024 * 1024;
// The Worker's production R2 binding in wrangler.jsonc. The seeder binds the
// same name so both see one local (simulated) bucket; nothing real is touched.
const BUCKET = "treehouse-blobs";

let server: TestHarness;
let reportSink: Server;
const reports: string[] = [];

beforeAll(async () => {
  reportSink = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      reports.push(body);
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => reportSink.listen(0, "127.0.0.1", resolve));
  const { port } = reportSink.address() as AddressInfo;

  server = createTestHarness({
    root: ROOT,
    workers: [
      {
        configPath: "./wrangler.jsonc",
        secrets: { BLOB_WORKER_TOKEN_KEY: KEY },
        vars: { USAGE_REPORT_URL: `http://127.0.0.1:${port}/report` },
      },
      {
        config: {
          name: "blob-seeder",
          main: "./test/runtime/seeder.mjs",
          compatibility_date: "2025-07-15",
          r2_buckets: [{ binding: "BLOBS", bucket_name: BUCKET }],
        },
      },
      {
        config: {
          name: "blob-metering",
          main: "./test/runtime/metering.ts",
          compatibility_date: "2025-07-15",
          compatibility_flags: ["nodejs_compat"],
        },
      },
    ],
  });
  await server.listen();
}, 60_000);

afterAll(async () => {
  await server?.close();
  await new Promise((resolve) => reportSink?.close(resolve));
});

async function seed(plain: Uint8Array, meter = false) {
  const contentHash = createHash("sha256").update(plain).digest("hex");
  const stored = encryptBlob(plain, DEK, { workspaceId: WS, contentHash });
  const key = `${WS}/${contentHash}`;
  const put = await server
    .getWorker("blob-seeder")
    .fetch(`http://seed/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: stored,
    });
  expect(put.status).toBe(200);
  const header = stored.slice(0, HEADER_BYTES);
  const token = mintGrant(grantKeyRing(KEY, undefined)!, {
    workspaceId: WS,
    contentHash,
    size: plain.byteLength,
    header,
    key: deriveBlobKey(DEK, header, { workspaceId: WS, contentHash }),
    etag: `"1-${contentHash}"`,
    headers: { "content-type": "application/octet-stream" },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    meter,
  });
  return { url: `/b/${token}`, contentHash, stored };
}

/** Byte equality that stays fast for megabytes (toEqual walks them one by one). */
function expectSameBytes(actual: ArrayBuffer, expected: Uint8Array) {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.from(actual).equals(expected)).toBe(true);
}

const sha = (bytes: ArrayBuffer | Uint8Array) =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

describe("blob worker in workerd", () => {
  it("serves a multi-chunk file whole, with its length", async () => {
    const plain = new Uint8Array(randomBytes(3 * MIB + 12345));
    const { url, contentHash } = await seed(plain);
    const res = await server.fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(plain.byteLength));
    expect(sha(await res.arrayBuffer())).toBe(contentHash);
  }, 30_000);

  it("serves ranges across 1 MiB frame boundaries byte-exactly", async () => {
    const plain = new Uint8Array(randomBytes(3 * MIB + 12345));
    const { url } = await seed(plain);
    const ranges: [number, number][] = [
      [0, 0],
      [MIB - 1, MIB],
      [MIB - 10, 2 * MIB + 10],
      [2 * MIB, 3 * MIB - 1],
      [plain.byteLength - 100, plain.byteLength - 1],
    ];
    for (const [start, end] of ranges) {
      const res = await server.fetch(url, { headers: { range: `bytes=${start}-${end}` } });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${plain.byteLength}`);
      expect(res.headers.get("content-length")).toBe(String(end - start + 1));
      // Compared with Buffer.equals, not toEqual. toEqual walks a 1 MiB array
      // element by element, which on a loaded CI runner took ~3 s per range.
      // That left the harness's pooled keep-alive connection idle long enough
      // for the server side to close it, and the next request, reusing it,
      // failed with "other side closed" / ECONNRESET.
      expectSameBytes(await res.arrayBuffer(), plain.subarray(start, end + 1));
    }
  }, 30_000);

  it("sandboxes what it serves and never serves a service worker script", async () => {
    const { url } = await seed(new TextEncoder().encode("self.onfetch = () => {};"));
    const ok = await server.fetch(url);
    expect(ok.headers.get("content-security-policy")).toBe("sandbox");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    await ok.arrayBuffer();
    const sw = await server.fetch(url, { headers: { "service-worker": "script" } });
    expect(sw.status).toBe(403);
    expect(await sw.text()).toBe("");
  }, 30_000);

  it("refuses a forged grant and a tampered blob", async () => {
    const forged = await server.fetch("/b/t1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(forged.status).toBe(403);
    expect(await forged.text()).toBe("");

    const plain = new Uint8Array(randomBytes(2 * MIB));
    const { url, contentHash, stored } = await seed(plain);
    // The same object with one bit flipped in its second chunk.
    const tampered = new Uint8Array(stored);
    tampered[HEADER_BYTES + MIB + 16 + 5]! ^= 1;
    await server
      .getWorker("blob-seeder")
      .fetch(`http://seed/${encodeURIComponent(`${WS}/${contentHash}`)}`, {
        method: "PUT",
        body: tampered,
      });
    const res = await server.fetch(url, { headers: { range: `bytes=${MIB}-${MIB + 9}` } });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("");
    // The untouched first chunk still opens.
    const ok = await server.fetch(url, { headers: { range: "bytes=0-9" } });
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(plain.subarray(0, 10));
  }, 30_000);

  it("charges only what the reader took through the real FixedLengthStream", async () => {
    const res = await server.getWorker("blob-metering").fetch("http://metering/");
    const results = await res.json();
    // A body cancelled before any read charges nothing, even though a frame
    // was already decrypted and waiting; one read charges one chunk.
    expect(results).toEqual({
      none: { counted: 0, read: 0 },
      one: { counted: 1000, read: 1000 },
      all: { counted: 3000, read: 3000 },
    });
  }, 30_000);

  it("reports the bytes a metered grant sent, after the response", async () => {
    const plain = new Uint8Array(randomBytes(MIB + 5));
    const { url } = await seed(plain, true);
    const res = await server.fetch(url, { headers: { range: "bytes=0-99999" } });
    expect((await res.arrayBuffer()).byteLength).toBe(100000);
    const deadline = Date.now() + 10_000;
    while (reports.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const report = openUsageReport(
      grantKeyRing(KEY, undefined)!,
      reports.at(-1)!,
      Math.floor(Date.now() / 1000),
    );
    expect(report).toMatchObject({ workspaceId: WS, bytes: 100000 });
  }, 30_000);
});