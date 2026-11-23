import { afterEach, describe, expect, it } from "vite-plus/test";
import { fetchDescriptor, parseDescriptor } from "../src/descriptor";

// Cross-version contract: the shell's parseDescriptor MUST stay behaviourally
// identical to packages/app/server/utils/descriptor.ts (mirrored, not imported —
// see the DEVIATION note in src/descriptor.ts). These fixtures mirror
// packages/app/test/descriptor.test.ts and add the shell-only fetch cases
// (oversized / non-ok / network error), so the two validators can't silently drift.

describe("parseDescriptor (shell-side validation)", () => {
  it("accepts a well-formed https descriptor", () => {
    const d = parseDescriptor({
      product: "treehouse",
      version: 1,
      apiUrl: "https://api.example.com",
    });
    expect(d?.apiUrl).toBe("https://api.example.com");
  });

  it("strips a trailing slash so the origin is canonical", () => {
    expect(
      parseDescriptor({ product: "treehouse", apiUrl: "https://api.example.com/" })?.apiUrl,
    ).toBe("https://api.example.com");
  });

  it("treats missing and malformed/non-https descriptors identically (null)", () => {
    expect(parseDescriptor(undefined)).toBeNull();
    expect(parseDescriptor(null)).toBeNull();
    expect(parseDescriptor("not json")).toBeNull();
    expect(parseDescriptor({ product: "other", apiUrl: "https://x" })).toBeNull();
    expect(parseDescriptor({ product: "treehouse" })).toBeNull();
    expect(parseDescriptor({ product: "treehouse", apiUrl: "http://evil.example.com" })).toBeNull();
    expect(parseDescriptor({ product: "treehouse", apiUrl: "ftp://x" })).toBeNull();
  });

  it("permits http://localhost only when insecure origins are allowed (dev)", () => {
    const raw = { product: "treehouse", apiUrl: "http://localhost:3010" };
    expect(parseDescriptor(raw)).toBeNull();
    expect(parseDescriptor(raw, { allowInsecure: true })?.apiUrl).toBe("http://localhost:3010");
  });
});

const realFetch = globalThis.fetch;
function stubFetch(impl: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = ((url: string) => Promise.resolve(impl(url))) as unknown as typeof fetch;
}
/**
 * Build a stubbed Response. The body is a real ReadableStream because
 * `fetchDescriptor` enforces its size cap WHILE streaming (never buffering the
 * whole body first) — a `text()`-only stub wouldn't exercise that path at all.
 * `chunks` splits the body so an oversized response can be rejected mid-stream.
 */
function res(
  body: string,
  init: { ok?: boolean; status?: number; chunkSize?: number } = {},
): Response {
  const bytes = new TextEncoder().encode(body);
  const chunkSize = init.chunkSize ?? (bytes.byteLength || 1);
  let cancelled = false;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cancelled) return;
      const start = pulled;
      if (start >= bytes.byteLength) return controller.close();
      pulled = Math.min(start + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(start, pulled));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: stream,
    text: async () => body,
  } as unknown as Response;
}

describe("fetchDescriptor", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fetches + validates a well-formed descriptor from the app origin", async () => {
    stubFetch(() =>
      res(JSON.stringify({ product: "treehouse", version: 1, apiUrl: "https://api.example.com/" })),
    );
    const d = await fetchDescriptor("https://app.example.com");
    expect(d?.apiUrl).toBe("https://api.example.com"); // slash stripped
  });

  it("rejects a non-https app origin unless insecure is allowed", async () => {
    stubFetch(() =>
      res(JSON.stringify({ product: "treehouse", apiUrl: "https://api.example.com" })),
    );
    expect(await fetchDescriptor("http://app.example.com")).toBeNull();
    expect((await fetchDescriptor("http://localhost:3000", { allowInsecure: true }))?.apiUrl).toBe(
      "https://api.example.com",
    );
  });

  it("treats a non-ok response as missing (null)", async () => {
    stubFetch(() => res("", { ok: false, status: 404 }));
    expect(await fetchDescriptor("https://app.example.com")).toBeNull();
  });

  it("rejects an oversized descriptor body (>4KB)", async () => {
    stubFetch(() => res("x".repeat(5000)));
    expect(await fetchDescriptor("https://app.example.com")).toBeNull();
  });

  it("abandons an oversized body mid-stream instead of buffering it all", async () => {
    // The cap has to bite while streaming: a hostile endpoint that keeps sending
    // must not get the whole body into memory first. Cancelling the stream is the
    // observable proof the read stopped early rather than draining to completion.
    let delivered = 0;
    stubFetch(() => {
      const source = res("x".repeat(64 * 1024), { chunkSize: 1024 })
        .body as ReadableStream<Uint8Array>;
      const counted = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            delivered += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
      return { ok: true, status: 200, body: counted } as unknown as Response;
    });
    expect(await fetchDescriptor("https://app.example.com")).toBeNull();
    // Well under the 64KB the endpoint was willing to send.
    expect(delivered).toBeLessThan(16 * 1024);
  });

  it("rejects insecure NON-loopback origins even when allowInsecure is set", async () => {
    // allowInsecure is a localhost-only dev affordance. Accepting http:// for a
    // remote host would let a dev build discover its API origin over plaintext.
    stubFetch(() =>
      res(JSON.stringify({ product: "treehouse", apiUrl: "https://api.example.com" })),
    );
    expect(await fetchDescriptor("http://app.example.com", { allowInsecure: true })).toBeNull();
    expect(await fetchDescriptor("http://10.0.0.5:3000", { allowInsecure: true })).toBeNull();
    // 127.0.0.1 stays permitted alongside localhost.
    expect((await fetchDescriptor("http://127.0.0.1:3000", { allowInsecure: true }))?.apiUrl).toBe(
      "https://api.example.com",
    );
  });

  it("treats a network error as missing (null, never throws)", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchDescriptor("https://app.example.com")).toBeNull();
  });
});