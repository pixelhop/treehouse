import { createHash, randomBytes } from "node:crypto";
import { deriveBlobKey, encryptBlob, HEADER_BYTES } from "blob-io/blob-crypto";
import { type BlobGrant, grantKeyRing, mintGrant, openUsageReport } from "blob-io/blob-grant";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env";
import { handle } from "../src/handler";
import { FakeBucket, FakeContext } from "./fakes";

// The Worker's handler as a plain function over an in-memory bucket. Blobs are
// sealed with blob-io's encryptBlob, the exact function the API's encrypting
// store writes with, and grants are minted the way the API mints them. The
// same bytes through real workerd are in runtime.test.ts.

const DEK = new Uint8Array(randomBytes(32));
const WS = "ws-worker";
const CHUNK = 1024;
const KEY = `t1:${randomBytes(32).toString("base64")}`;
const OTHER_KEY = `t2:${randomBytes(32).toString("base64")}`;
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const ORIGIN = "https://blobs.example";

let bucket: FakeBucket;
let ctx: FakeContext;
let reports: { url: string; body: string }[];

function env(over: Partial<Env> = {}): Env {
  return {
    BLOBS: bucket,
    BLOB_WORKER_TOKEN_KEY: KEY,
    USAGE_REPORT_URL: "https://api.example/api/internal/blob-usage",
    ...over,
  };
}

const opts = () => ({
  now: () => NOW_MS,
  fetch: (async (url: string, init: { body: string }) => {
    reports.push({ url, body: init.body });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch,
});

/** Seal `plain` as the API would and store it; returns a grant for it. */
function store(plain: Uint8Array, over: Partial<BlobGrant> = {}): BlobGrant {
  const contentHash = createHash("sha256").update(plain).digest("hex");
  const stored = encryptBlob(plain, DEK, { workspaceId: WS, contentHash, chunkSize: CHUNK });
  bucket.objects.set(`${WS}/${contentHash}`, stored);
  const header = stored.slice(0, HEADER_BYTES);
  return {
    workspaceId: WS,
    contentHash,
    size: plain.byteLength,
    header,
    key: deriveBlobKey(DEK, header, { workspaceId: WS, contentHash }),
    etag: `"1-${contentHash}"`,
    headers: {
      "content-type": "video/mp4",
      "cache-control": "private, max-age=0, must-revalidate",
      "x-treehouse-version": "1",
      "x-treehouse-content-hash": contentHash,
    },
    expiresAt: NOW + 3600,
    meter: false,
    ...over,
  };
}

function urlFor(grant: BlobGrant, key = KEY): string {
  return `${ORIGIN}/b/${mintGrant(grantKeyRing(key, undefined)!, grant)}`;
}

function get(url: string, headers: Record<string, string> = {}, method = "GET") {
  return handle(new Request(url, { method, headers }), env(), ctx, opts());
}

async function bytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

const MIB = 10 * CHUNK + 77;
let plain: Uint8Array;

beforeEach(() => {
  bucket = new FakeBucket();
  ctx = new FakeContext();
  reports = [];
  plain = new Uint8Array(randomBytes(MIB));
});

describe("blob worker: serving", () => {
  it("serves the whole file with the API's headers", async () => {
    const grant = store(plain);
    const res = await get(urlFor(grant));
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(plain);
    expect(res.headers.get("content-length")).toBe(String(plain.byteLength));
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("etag")).toBe(grant.etag);
    expect(res.headers.get("x-treehouse-version")).toBe("1");
    expect(res.headers.get("x-treehouse-content-hash")).toBe(grant.contentHash);
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves every range across chunk boundaries byte-exactly, reading only the frames it needs", async () => {
    const grant = store(plain);
    const url = urlFor(grant);
    const edges = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 7 * CHUNK + 5, MIB - 2, MIB - 1];
    for (const start of edges) {
      for (const end of edges) {
        if (end < start) continue;
        bucket.reads = [];
        const res = await get(url, { range: `bytes=${start}-${end}` });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${MIB}`);
        expect(res.headers.get("content-length")).toBe(String(end - start + 1));
        expect(await bytes(res)).toEqual(plain.subarray(start, end + 1));
        // One read, of whole frames only: never the whole object for a range.
        const chunks = Math.floor(end / CHUNK) - Math.floor(start / CHUNK) + 1;
        expect(bucket.reads).toHaveLength(1);
        expect(bucket.reads[0]!.length).toBeLessThanOrEqual(chunks * (CHUNK + 16));
      }
    }
  });

  it("serves suffix and open-ended ranges", async () => {
    const url = urlFor(store(plain));
    const suffix = await get(url, { range: "bytes=-100" });
    expect(suffix.status).toBe(206);
    expect(await bytes(suffix)).toEqual(plain.subarray(MIB - 100));
    const open = await get(url, { range: `bytes=${MIB - 5000}-` });
    expect(await bytes(open)).toEqual(plain.subarray(MIB - 5000));
  });

  it("answers a range past the end with 416 and the real size", async () => {
    const res = await get(urlFor(store(plain)), { range: `bytes=${MIB}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${MIB}`);
    expect(bucket.reads).toHaveLength(0);
  });

  it("serves the whole file for several ranges, which it does not support", async () => {
    const res = await get(urlFor(store(plain)), { range: "bytes=0-1,5-9" });
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(plain);
  });

  it("honours If-Range: the range when it matches, the whole file when not", async () => {
    const grant = store(plain);
    const hit = await get(urlFor(grant), { range: "bytes=0-9", "if-range": grant.etag! });
    expect(hit.status).toBe(206);
    const miss = await get(urlFor(grant), { range: "bytes=0-9", "if-range": '"2-other"' });
    expect(miss.status).toBe(200);
    expect(await bytes(miss)).toEqual(plain);
  });

  it("never honours If-Range for a grant without a validator", async () => {
    const res = await get(urlFor(store(plain, { etag: null })), {
      range: "bytes=0-9",
      "if-range": '"anything"',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("answers If-None-Match with 304 without touching the bucket", async () => {
    const grant = store(plain);
    const res = await get(urlFor(grant), { "if-none-match": grant.etag! });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(grant.etag);
    expect(bucket.reads).toHaveLength(0);
  });

  it("serves an empty file", async () => {
    const res = await get(urlFor(store(new Uint8Array(0))));
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(new Uint8Array(0));
  });

  it("answers HEAD with the lengths and no body", async () => {
    const res = await get(urlFor(store(plain)), { range: "bytes=10-19" }, "HEAD");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.body).toBeNull();
  });

  it("answers 404 when the blob is gone", async () => {
    const grant = store(plain);
    bucket.objects.clear();
    expect((await get(urlFor(grant))).status).toBe(404);
    expect((await get(urlFor(grant), {}, "HEAD")).status).toBe(404);
  });
});

describe("blob worker: failing closed", () => {
  async function expectBare(res: Response, status: number) {
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBeNull();
  }

  it("refuses an expired grant", async () => {
    await expectBare(await get(urlFor(store(plain, { expiresAt: NOW }))), 403);
  });

  it("refuses a tampered grant", async () => {
    const url = urlFor(store(plain));
    const at = url.length - 8;
    const tampered = url.slice(0, at) + (url[at] === "A" ? "B" : "A") + url.slice(at + 1);
    await expectBare(await get(tampered), 403);
  });

  it("refuses a grant under a key it does not hold, and one with no key configured", async () => {
    await expectBare(await get(urlFor(store(plain), OTHER_KEY)), 403);
    const res = await handle(
      new Request(urlFor(store(plain))),
      env({ BLOB_WORKER_TOKEN_KEY: undefined }),
      ctx,
      opts(),
    );
    await expectBare(res, 503);
  });

  it("accepts a grant under a retired key during rotation", async () => {
    const url = urlFor(store(plain), OTHER_KEY);
    const res = await handle(
      new Request(url),
      env({ BLOB_WORKER_TOKEN_KEY_RETIRED: OTHER_KEY }),
      ctx,
      opts(),
    );
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(plain);
  });

  it("refuses paths and methods it does not serve", async () => {
    await expectBare(await get(`${ORIGIN}/`), 404);
    await expectBare(await get(`${ORIGIN}/b/a/b`), 404);
    const post = await handle(
      new Request(urlFor(store(plain)), { method: "POST" }),
      env(),
      ctx,
      opts(),
    );
    await expectBare(post, 405);
  });

  it("refuses a blob whose bytes were tampered with, before sending anything", async () => {
    const grant = store(plain);
    const stored = bucket.objects.get(`${WS}/${grant.contentHash}`)!;
    stored[HEADER_BYTES + 3 * (CHUNK + 16) + 10]! ^= 1; // inside chunk 3
    await expectBare(
      await get(urlFor(grant), { range: `bytes=${3 * CHUNK}-${3 * CHUNK + 5}` }),
      502,
    );
    // A range that starts before the damage gets its good chunks, then is cut off.
    const res = await get(urlFor(grant));
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("refuses chunks that were reordered", async () => {
    const grant = store(plain);
    const key = `${WS}/${grant.contentHash}`;
    const stored = bucket.objects.get(key)!;
    const frame = CHUNK + 16;
    const one = stored.slice(HEADER_BYTES + frame, HEADER_BYTES + 2 * frame);
    const two = stored.slice(HEADER_BYTES + 2 * frame, HEADER_BYTES + 3 * frame);
    stored.set(two, HEADER_BYTES + frame);
    stored.set(one, HEADER_BYTES + 2 * frame);
    await expectBare(await get(urlFor(grant), { range: `bytes=${CHUNK}-${CHUNK + 1}` }), 502);
  });

  it("refuses a truncated or replaced object", async () => {
    const grant = store(plain);
    const key = `${WS}/${grant.contentHash}`;
    bucket.objects.set(key, bucket.objects.get(key)!.slice(0, -1));
    await expectBare(await get(urlFor(grant)), 502);
    expect(bucket.cancelled).toBe(1);
  });

  it("refuses a blob re-sealed since the grant was issued (same size, new salt)", async () => {
    const grant = store(plain);
    store(plain); // the same bytes uploaded again: same key, fresh salt
    await expectBare(await get(urlFor(grant)), 502);
  });

  it("opens only the blob its key was derived for, not the same bytes in another workspace", async () => {
    const grant = store(plain);
    const other = encryptBlob(plain, DEK, {
      workspaceId: "ws-other",
      contentHash: grant.contentHash,
      chunkSize: CHUNK,
    });
    bucket.objects.set(`ws-other/${grant.contentHash}`, other);
    // Even a grant pointed at the other workspace's copy (which the API would
    // never mint) carries a key that cannot open it.
    const pointedElsewhere = { ...grant, workspaceId: "ws-other" };
    await expectBare(await get(urlFor(pointedElsewhere)), 502);
  });
});

describe("blob worker: uploaded content stays inert on this origin", () => {
  /** Whether `res` carries a CSP policy that is exactly `sandbox` (no allowances). */
  const sandboxed = (res: Response) =>
    (res.headers.get("content-security-policy") ?? "")
      .split(",")
      .some((p) => p.trim() === "sandbox");

  it("never serves a grant as a service worker, shared worker or worker script", async () => {
    const page = store(new TextEncoder().encode("self.addEventListener('fetch', () => {})"), {
      headers: { "content-type": "text/javascript" },
    });
    for (const headers of <Record<string, string>[]>[
      { "service-worker": "script" },
      { "sec-fetch-dest": "serviceworker" },
      { "sec-fetch-dest": "sharedworker" },
      { "sec-fetch-dest": "worker" },
    ]) {
      const res = await get(urlFor(page), headers);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    }
    expect(bucket.reads).toHaveLength(0);
    // An ordinary script load is still served.
    expect((await get(urlFor(page), { "sec-fetch-dest": "script" })).status).toBe(200);
  });

  it("sandboxes an uploaded HTML page (opaque origin, no scripts) and forbids sniffing", async () => {
    const html = store(new TextEncoder().encode("<script>navigator.serviceWorker</script>"), {
      headers: { "content-type": "text/html" },
    });
    const res = await get(urlFor(html), { "sec-fetch-dest": "document" });
    expect(res.status).toBe(200);
    expect(sandboxed(res)).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps its own sandbox policy alongside a grant's stricter one", async () => {
    const res = await get(
      urlFor(
        store(plain, {
          headers: {
            "content-type": "text/html",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        }),
      ),
    );
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'; sandbox");
    expect(sandboxed(res)).toBe(true);
  });

  it("hardens every answer: ranges, 304, 416 and refusals alike", async () => {
    const grant = store(plain);
    const answers = [
      await get(urlFor(grant), { range: "bytes=0-9" }),
      await get(urlFor(grant), { "if-none-match": grant.etag! }),
      await get(urlFor(grant), { range: `bytes=${MIB}-` }),
      await get(`${ORIGIN}/b/t1.AAAA`),
    ];
    expect(answers.map((r) => r.status)).toEqual([206, 304, 416, 403]);
    for (const res of answers) {
      expect(sandboxed(res)).toBe(true);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("blob worker: logs never carry a grant", () => {
  it("logs failures without the grant or the request URL", async () => {
    const logged: string[] = [];
    const saved = { error: console.error, log: console.log, warn: console.warn };
    const capture = (...args: unknown[]) =>
      void logged.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
      );
    console.error = console.log = console.warn = capture;
    const urls: string[] = [];
    try {
      // A blob that won't authenticate, one that fails part way, a failed report.
      const bad = store(plain, { meter: true });
      const stored = bucket.objects.get(`${WS}/${bad.contentHash}`)!;
      stored[HEADER_BYTES + 5 * (CHUNK + 16) + 3]! ^= 1;
      urls.push(urlFor(bad));
      await get(urls[0]!, { range: `bytes=${5 * CHUNK}-${5 * CHUNK + 1}` });
      await (await get(urls[0]!)).arrayBuffer().catch(() => {});
      const failingReport = await handle(new Request(urls[0]!), env(), ctx, {
        now: () => NOW_MS,
        fetch: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
      });
      await failingReport.arrayBuffer().catch(() => {});
      // A malformed key on the Worker.
      urls.push(urlFor(store(new Uint8Array(10))));
      await handle(new Request(urls[1]!), env({ BLOB_WORKER_TOKEN_KEY: "t9:nope" }), ctx, opts());
      await ctx.settle();
    } finally {
      Object.assign(console, saved);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const url of urls) {
      const token = url.slice(url.indexOf("/b/") + 3);
      for (const line of logged) {
        expect(line).not.toContain(token.slice(3, 40));
        expect(line).not.toContain("/b/");
      }
    }
  });
});

describe("blob worker: CORS", () => {
  it("echoes the origin, including the null origin a redirect leaves behind", async () => {
    for (const origin of ["https://app.example", "null"]) {
      const res = await get(urlFor(store(plain)), { origin });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("access-control-expose-headers")).toContain("X-Treehouse-Version");
      expect(res.headers.get("vary")).toBe("Origin");
    }
  });

  it("answers a preflight for the range and conditional headers", async () => {
    const res = await handle(
      new Request(`${ORIGIN}/b/anything`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-headers": "range" },
      }),
      env(),
      ctx,
      opts(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("If-Range");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
  });

  it("sends CORS headers on a refusal too, so a script can read the status", async () => {
    const res = await get(`${ORIGIN}/b/t1.AAAA`, { origin: "https://app.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });
});

describe("blob worker: share-link metering", () => {
  const ring = () => grantKeyRing(KEY, undefined)!;

  it("reports the bytes sent for a metered grant, sealed so only the API can read it", async () => {
    const res = await get(urlFor(store(plain, { meter: true })), { range: "bytes=100-4099" });
    await bytes(res);
    await ctx.settle();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.url).toBe("https://api.example/api/internal/blob-usage");
    expect(openUsageReport(ring(), reports[0]!.body, NOW)).toEqual({
      workspaceId: WS,
      bytes: 4000,
      at: NOW,
    });
  });

  it("reports only what was read when the client leaves early", async () => {
    const res = await get(urlFor(store(plain, { meter: true })));
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    await ctx.settle();
    expect(openUsageReport(ring(), reports[0]!.body, NOW)!.bytes).toBe(first.value!.byteLength);
    expect(first.value!.byteLength).toBeLessThan(plain.byteLength);
  });

  it("charges nothing when the client leaves before reading the body", async () => {
    const res = await get(urlFor(store(plain, { meter: true })));
    // The first frame is decrypted and waiting (it was authenticated before
    // the status was chosen), but the reader never took it.
    await new Promise((r) => setTimeout(r, 20));
    await res.body!.cancel();
    await ctx.settle();
    // Zero bytes is not worth a report at all.
    expect(reports).toHaveLength(0);
  });

  it("reports nothing for an unmetered grant, a 304, a HEAD, or with no report URL", async () => {
    const metered = store(plain, { meter: true });
    await bytes(await get(urlFor(store(plain))));
    await get(urlFor(metered), { "if-none-match": metered.etag! });
    await get(urlFor(metered), {}, "HEAD");
    const res = await handle(
      new Request(urlFor(metered)),
      env({ USAGE_REPORT_URL: "" }),
      ctx,
      opts(),
    );
    await bytes(res);
    await ctx.settle();
    expect(reports).toHaveLength(0);
  });
});