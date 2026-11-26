import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
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

/** An event whose request sends `before` bytes and then fails with `err`. */
function failingEventFor(before: Uint8Array, err: Error) {
  const req = (async function* () {
    yield Buffer.from(before);
    throw err;
  })();
  const res = { headersSent: false, setHeader: () => {} };
  return { node: { req, res } } as unknown as H3Event;
}

function aborted(): Error {
  return Object.assign(new Error("aborted"), { code: "ECONNRESET" });
}

describe("a client that hangs up mid-body", () => {
  it("is a handled 499, not an unhandled error, and leaves no temp file", async () => {
    const before = await spooledFiles();
    const event = failingEventFor(new Uint8Array(randomBytes(5 * MIB)), aborted());
    const err = await spoolBodyCapped(event, 10 * MIB, overflow).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 499, unhandled: false });
    expect(await spooledFiles()).toEqual(before);
  });

  it("leaves any other read failure as it was", async () => {
    const boom = new Error("disk on fire");
    const event = failingEventFor(new Uint8Array(10), boom);
    await expect(readBodyCapped(event, MIB, overflow)).rejects.toBe(boom);
  });

  it("is what a real socket closing part way through produces", async () => {
    let seen: unknown;
    const handled = new Promise<void>((resolve) => {
      const server = createServer((req, res) => {
        const event = { node: { req, res } } as unknown as H3Event;
        spoolBodyCapped(event, 10 * MIB, overflow)
          .then((b) => b.dispose())
          .catch((e: unknown) => (seen = e))
          .finally(() => {
            server.close();
            resolve();
          });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            `PUT /f HTTP/1.1\r\nHost: x\r\nContent-Length: ${2 * MIB}\r\n\r\n` + "a".repeat(1024),
            () => setTimeout(() => socket.destroy(), 50),
          );
        });
        socket.on("error", () => {});
      });
    });
    await handled;
    expect(seen).toMatchObject({ statusCode: 499 });
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