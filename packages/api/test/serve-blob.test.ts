import { PassThrough } from "node:stream";
import type { H3Event } from "h3";
import { describe, expect, it } from "vite-plus/test";
import { serveBlob } from "../server/utils/serve-blob";

/** An event whose client has already gone: the response is destroyed. */
function goneClient(): H3Event {
  const res = Object.assign(new PassThrough(), {
    headersSent: false,
    statusCode: 200,
    setHeader() {},
    getHeader() {
      return undefined;
    },
  });
  res.destroy();
  return { node: { req: { headers: {} }, res } } as unknown as H3Event;
}

describe("serveBlob", () => {
  it("closes the storage body even when streaming never starts", async () => {
    let closed = 0;
    let started = false;
    const blob = {
      size: 3,
      contentType: "x",
      range: null,
      body: (async function* () {
        started = true;
        yield new Uint8Array([1, 2, 3]);
      })(),
      close: () => void closed++,
    };
    await serveBlob(goneClient(), blob).catch(() => {});
    expect(started).toBe(false);
    expect(closed).toBe(1);
  });

  it("closes the storage body after a 416", async () => {
    let closed = 0;
    const res = Object.assign(new PassThrough(), {
      headersSent: false,
      statusCode: 200,
      setHeader() {},
    });
    const event = { node: { req: { headers: {} }, res } } as unknown as H3Event;
    await serveBlob(event, {
      size: 3,
      contentType: "x",
      range: "unsatisfiable",
      body: (async function* () {})(),
      close: () => void closed++,
    });
    expect(closed).toBe(1);
  });
});