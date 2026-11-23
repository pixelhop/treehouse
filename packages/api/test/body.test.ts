import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3Event } from "h3";
import { describe, expect, it } from "vite-plus/test";
import { readBodyCapped, spoolBodyCapped } from "../server/utils/body";
import { collect } from "blob-io/byte-stream";

const MIB = 1024 * 1024;
const UPLOADS = join(tmpdir(), "treehouse-uploads");

/** An event whose request body arrives as the given pieces. */
function eventFor(body: Uint8Array, piece = 256 * 1024) {
  const headers: Record<string, string> = {};
  const req = (async function* () {
    for (let i = 0; i < body.byteLength; i += piece) yield Buffer.from(body.subarray(i, i + piece));
  })();
  const event = {
    node: {
      req,
      res: { headersSent: false, setHeader: (k: string, v: string) => (headers[k] = v) },
    },
  } as unknown as H3Event;
  return { event, headers };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const overflow = (limit: number) => new Error(`over ${limit}`);

async function spooledFiles(): Promise<string[]> {
  return existsSync(UPLOADS) ? readdir(UPLOADS) : [];
}

describe("spoolBodyCapped", () => {
  it("keeps a small body in memory, with its size and hash", async () => {
    const body = new Uint8Array(randomBytes(1000));
    const before = await spooledFiles();
    const spooled = await spoolBodyCapped(eventFor(body).event, 10 * MIB, overflow);
    expect(spooled.size).toBe(1000);
    expect(spooled.sha256).toBe(sha(body));
    expect(Buffer.from(await collect(spooled.open())).equals(Buffer.from(body))).toBe(true);
    expect(await spooledFiles()).toEqual(before);
    await spooled.dispose();
  });

  it("spills a large body to a temp file, readable more than once, removed on dispose", async () => {
    const body = new Uint8Array(randomBytes(6 * MIB + 17));
    const spooled = await spoolBodyCapped(eventFor(body).event, 10 * MIB, overflow);
    expect(spooled.size).toBe(body.byteLength);
    expect(spooled.sha256).toBe(sha(body));
    for (let i = 0; i < 2; i++) {
      expect(Buffer.from(await collect(spooled.open())).equals(Buffer.from(body))).toBe(true);
    }
    const during = await spooledFiles();
    await spooled.dispose();
    expect((await spooledFiles()).length).toBe(during.length - 1);
  });

  it("stops at the limit, asks for the connection to close, and leaves no temp file", async () => {
    const body = new Uint8Array(randomBytes(6 * MIB));
    const before = await spooledFiles();
    const { event, headers } = eventFor(body);
    await expect(spoolBodyCapped(event, 5 * MIB, overflow)).rejects.toThrow(`over ${5 * MIB}`);
    expect(headers.Connection).toBe("close");
    expect(await spooledFiles()).toEqual(before);
  });

  it("handles an empty body", async () => {
    const spooled = await spoolBodyCapped(eventFor(new Uint8Array(0)).event, MIB, overflow);
    expect(spooled.size).toBe(0);
    expect((await collect(spooled.open())).byteLength).toBe(0);
  });
});

describe("readBodyCapped", () => {
  it("still reads a body whole and enforces the same limit", async () => {
    const body = new Uint8Array(randomBytes(3000));
    expect(
      Buffer.from(await readBodyCapped(eventFor(body, 700).event, 5000, overflow)).equals(
        Buffer.from(body),
      ),
    ).toBe(true);
    await expect(readBodyCapped(eventFor(body, 700).event, 2000, overflow)).rejects.toThrow(
      "over 2000",
    );
  });
});