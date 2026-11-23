import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { collect } from "../src/streams";
import { ApiClient, AuthError } from "../src/api-client";
import type { Config } from "../src/config";

const cfg: Config = { apiBase: "https://api.test", apiKey: "k", workspaceId: "ws1" };

// Swap global fetch for a handler that records the requested URL and returns a
// canned Response. Returns a restore fn. Keeps the suite dependency-free (no vi).
function stubFetch(handler: (url: string) => Response): { urls: string[]; restore: () => void } {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  const fake: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return Promise.resolve(handler(url));
  };
  globalThis.fetch = fake;
  return { urls, restore: () => (globalThis.fetch = orig) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ApiClient.changes", () => {
  it("requests ?sinceSeq and parses { changes, head }", async () => {
    const f = stubFetch(() =>
      json({ changes: [{ path: "a.md", op: "write", version: 2, seq: 5 }], head: 5 }),
    );
    try {
      const page = await new ApiClient(cfg).changes(3);
      expect(f.urls[0]).toBe("https://api.test/api/workspaces/ws1/changes?sinceSeq=3");
      expect(page.head).toBe(5);
      expect(page.changes).toEqual([{ path: "a.md", op: "write", version: 2, seq: 5 }]);
    } finally {
      f.restore();
    }
  });

  it("parses nextSeq when the server returns it (U1)", async () => {
    const f = stubFetch(() => json({ changes: [], head: 9, nextSeq: 7 }));
    try {
      const page = await new ApiClient(cfg).changes(5);
      expect(page.nextSeq).toBe(7);
      expect(page.changes).toEqual([]);
      expect(page.head).toBe(9);
    } finally {
      f.restore();
    }
  });

  it("leaves nextSeq undefined when the server omits it (U1)", async () => {
    const f = stubFetch(() => json({ changes: [], head: 0 }));
    try {
      const page = await new ApiClient(cfg).changes(0);
      expect(page.nextSeq).toBeUndefined();
    } finally {
      f.restore();
    }
  });

  it("includes limit when provided", async () => {
    const f = stubFetch(() => json({ changes: [], head: 0 }));
    try {
      await new ApiClient(cfg).changes(0, 50);
      expect(f.urls[0]).toContain("sinceSeq=0");
      expect(f.urls[0]).toContain("limit=50");
    } finally {
      f.restore();
    }
  });

  it("throws on a non-OK response", async () => {
    const f = stubFetch(() => json({ error: "boom" }, 500));
    try {
      await expect(new ApiClient(cfg).changes(0)).rejects.toThrow(/changes failed: 500/);
    } finally {
      f.restore();
    }
  });
});

describe("ApiClient typed auth errors (U2)", () => {
  for (const status of [401, 403]) {
    it(`throws AuthError (not a bare message) on ${status} from changes`, async () => {
      const f = stubFetch(() => json({ error: "nope" }, status));
      try {
        await expect(new ApiClient(cfg).changes(0)).rejects.toBeInstanceOf(AuthError);
      } finally {
        f.restore();
      }
    });
  }

  it("carries the status code so callers classify without string-matching", async () => {
    const f = stubFetch(() => json({ error: "nope" }, 403));
    try {
      await new ApiClient(cfg).list();
      throw new Error("expected AuthError");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).status).toBe(403);
    } finally {
      f.restore();
    }
  });

  it("a read_only 409 is a typed refusal, never an auth loss or a conflict", async () => {
    // The exact shape the API's readOnlyError produces.
    const body = { statusCode: 409, data: { error: "read_only", reason: "role" } };
    const f = stubFetch(() => json(body, 409));
    try {
      const client = new ApiClient(cfg);
      await expect(
        client.put("a.md", enc("hi"), { baseVersion: 1 }, "text/markdown"),
      ).resolves.toEqual({ ok: false, refused: "role" });
      await expect(client.delete("a.md", 1)).resolves.toEqual({ ok: false, refused: "role" });
    } finally {
      f.restore();
    }
  });

  it("a different 409 still fails the path rather than reading as read-only", async () => {
    const f = stubFetch(() => json({ error: "something_else" }, 409));
    try {
      await expect(
        new ApiClient(cfg).put("a.md", enc("hi"), { create: true }, "text/markdown"),
      ).rejects.toThrow("put a.md failed: 409");
    } finally {
      f.restore();
    }
  });

  it("put surfaces 403 as AuthError, still treating 404 as a private-path forbidden", async () => {
    const f403 = stubFetch(() => json({}, 403));
    try {
      await expect(
        new ApiClient(cfg).put("a.md", enc("hi"), { create: true }, "text/markdown"),
      ).rejects.toBeInstanceOf(AuthError);
    } finally {
      f403.restore();
    }
    const f404 = stubFetch(() => json({}, 404));
    try {
      const res = await new ApiClient(cfg).put(
        "a.md",
        enc("hi"),
        { create: true },
        "text/markdown",
      );
      expect(res).toEqual({ ok: false, forbidden: true });
    } finally {
      f404.restore();
    }
  });
});

describe("ApiClient.list (U3 pagination reservation)", () => {
  it("returns entries and terminates on nextCursor: null", async () => {
    const f = stubFetch(() =>
      json({
        entries: [{ path: "a.md", version: 1, size: 1, contentType: "text/markdown" }],
        nextCursor: null,
      }),
    );
    try {
      const entries = await new ApiClient(cfg).list();
      expect(entries.map((e) => e.path)).toEqual(["a.md"]);
      expect(f.urls).toHaveLength(1); // one page, no cursor follow-up
    } finally {
      f.restore();
    }
  });

  it("follows a cursor across pages until null", async () => {
    const f = stubFetch((url) =>
      url.includes("cursor=")
        ? json({
            entries: [{ path: "b.md", version: 1, size: 1, contentType: "t" }],
            nextCursor: null,
          })
        : json({
            entries: [{ path: "a.md", version: 1, size: 1, contentType: "t" }],
            nextCursor: "c1",
          }),
    );
    try {
      const entries = await new ApiClient(cfg).list();
      expect(entries.map((e) => e.path)).toEqual(["a.md", "b.md"]);
      expect(f.urls).toHaveLength(2);
      expect(f.urls[1]).toContain("cursor=c1");
    } finally {
      f.restore();
    }
  });

  it("tolerates a response without nextCursor (single page)", async () => {
    const f = stubFetch(() =>
      json({ entries: [{ path: "a.md", version: 1, size: 1, contentType: "t" }] }),
    );
    try {
      const entries = await new ApiClient(cfg).list();
      expect(entries.map((e) => e.path)).toEqual(["a.md"]);
      expect(f.urls).toHaveLength(1);
    } finally {
      f.restore();
    }
  });
});

const enc = (s: string) => new TextEncoder().encode(s);

describe("ApiClient.put", () => {
  it("returns the new version on success", async () => {
    const f = stubFetch(() => json({ path: "a.md", version: 1 }, 201));
    try {
      const res = await new ApiClient(cfg).put(
        "a.md",
        enc("hi"),
        { create: true },
        "text/markdown",
      );
      expect(res).toEqual({ ok: true, version: 1 });
    } finally {
      f.restore();
    }
  });

  it("returns a typed conflict on 412", async () => {
    const f = stubFetch(() =>
      json({ current_version: 3, conflict_copy_path: "a (conflicted).md" }, 412),
    );
    try {
      const res = await new ApiClient(cfg).put(
        "a.md",
        enc("hi"),
        { baseVersion: 1 },
        "text/markdown",
      );
      expect(res).toMatchObject({ ok: false, conflict: true, currentVersion: 3 });
    } finally {
      f.restore();
    }
  });

  it("throws a clear over-limit error on 507, including usage detail", async () => {
    const f = stubFetch(() =>
      json({ error: "quota_exceeded", used_bytes: 5, limit_bytes: 10 }, 507),
    );
    try {
      await expect(
        new ApiClient(cfg).put("a.md", enc("hi"), { create: true }, "text/markdown"),
      ).rejects.toThrow(/workspace storage limit reached \(using 5 of 10 bytes\)/);
    } finally {
      f.restore();
    }
  });

  it("throws a generic over-limit error on 507 with an unparseable body", async () => {
    const f = stubFetch(
      () => new Response("not json", { status: 507, headers: { "content-type": "text/plain" } }),
    );
    try {
      await expect(
        new ApiClient(cfg).put("a.md", enc("hi"), { create: true }, "text/markdown"),
      ).rejects.toThrow(/workspace storage limit reached$/);
    } finally {
      f.restore();
    }
  });
});
describe("ApiClient auth-failure reason", () => {
  it("carries the API's reason code into the AuthError message", async () => {
    const f = stubFetch(() =>
      json({ data: { error: "invalid_api_key", reason: "KEY_NOT_FOUND" } }, 401),
    );
    try {
      await new ApiClient(cfg).put("a.md", new Uint8Array([1]), { create: true }, "text/plain");
      throw new Error("expected AuthError");
    } catch (e) {
      // Without the reason, a deleted key, an expired key and a failed
      // key-lookup all read as the same bare "401" in the daemon log.
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).reason).toBe("KEY_NOT_FOUND");
      expect((e as AuthError).message).toContain("KEY_NOT_FOUND");
    } finally {
      f.restore();
    }
  });

  it("still throws AuthError when the 401 body is not JSON (proxy-generated)", async () => {
    const f = stubFetch(() => new Response("<html>401</html>", { status: 401 }));
    try {
      await expect(new ApiClient(cfg).changes(0)).rejects.toBeInstanceOf(AuthError);
    } finally {
      f.restore();
    }
  });
});
describe("ApiClient.get version header", () => {
  const bytes = () => new Response(new Uint8Array([65]), { status: 200, headers: HDRS });
  let HDRS: Record<string, string> = {};

  it("prefers x-treehouse-version over the ETag", async () => {
    HDRS = { "x-treehouse-version": "7", etag: 'W/"3"' };
    const f = stubFetch(bytes);
    try {
      expect((await new ApiClient(cfg).get("a.md"))?.version).toBe(7);
    } finally {
      f.restore();
    }
  });

  it("falls back to a weak ETag when the server predates the header", async () => {
    HDRS = { etag: 'W/"3"' };
    const f = stubFetch(bytes);
    try {
      expect((await new ApiClient(cfg).get("a.md"))?.version).toBe(3);
    } finally {
      f.restore();
    }
  });

  it("throws (never version 0) when a proxy strips every version header", async () => {
    // Cloudflare in front of the API drops the ETag outright; silently treating
    // that as version 0 would poison the index and 412 every later push.
    HDRS = {};
    const f = stubFetch(bytes);
    try {
      await expect(new ApiClient(cfg).get("a.md")).rejects.toThrow(/no usable version header/);
    } finally {
      f.restore();
    }
  });
});

describe("ApiClient.get through the byte Worker", () => {
  const WORKER = "https://blobs.test/b/t1.grant";

  /** A fetch stub that records each request's URL and init. */
  function stubCalls(handler: (url: string) => Response) {
    const orig = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.href;
      calls.push({ url, init });
      return Promise.resolve(handler(url));
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = orig) };
  }

  const redirect = (location = WORKER) =>
    new Response(null, {
      status: 307,
      headers: { location, "x-treehouse-byte-handoff": "1" },
    });
  const keyOf = (init?: RequestInit) =>
    ((init?.headers ?? {}) as Record<string, string>)["x-api-key"];
  const file = (version = "4") =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "x-treehouse-version": version } });
  const API_FILE = "https://api.test/api/workspaces/ws1/files/media/a.bin";

  it("never puts a grant URL into an error, whatever fails on the way to it", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.href;
      if (url === WORKER) throw new TypeError(`fetch failed: ${url}`, { cause: url });
      return redirect();
    }) as typeof fetch;
    try {
      const err = (await new ApiClient(cfg).get("media/a.bin").catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(`${err.message} ${JSON.stringify(err.cause ?? "")} ${err.stack ?? ""}`).not.toContain(
        "t1.grant",
      );
    } finally {
      globalThis.fetch = orig;
    }
    // An unparseable Location is not echoed either.
    const bad = stubCalls(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://[t1.grant", "x-treehouse-byte-handoff": "1" },
        }),
    );
    try {
      const err = (await new ApiClient(cfg).get("media/a.bin").catch((e: unknown) => e)) as Error;
      expect(err.message).not.toContain("t1.grant");
    } finally {
      bad.restore();
    }
  });

  it("follows a handoff without the key even when it points at the API's own origin", async () => {
    const sameOrigin = "https://api.test/b/t1.grant";
    const f = stubCalls((url) => (url === sameOrigin ? file() : redirect(sameOrigin)));
    try {
      expect((await new ApiClient(cfg).get("media/a.bin"))?.version).toBe(4);
      expect(keyOf(f.calls[1]!.init)).toBeUndefined();
    } finally {
      f.restore();
    }
  });

  describe("ordinary redirects (the Worker off, a proxy in front of the API)", () => {
    const CANONICAL = "https://api.test/v2/files/media/a.bin";
    const ELSEWHERE = "https://cdn.example/files/media/a.bin";

    it.each([301, 302, 303, 307, 308])(
      "follows a same-origin %i with the key, as fetch used to",
      async (status) => {
        const f = stubCalls((url) =>
          url === CANONICAL
            ? file("6")
            : new Response(null, { status, headers: { location: CANONICAL } }),
        );
        try {
          expect((await new ApiClient(cfg).get("media/a.bin"))?.version).toBe(6);
          expect(f.calls.map((c) => c.url)).toEqual([API_FILE, CANONICAL]);
          expect(keyOf(f.calls[1]!.init)).toBe("k");
        } finally {
          f.restore();
        }
      },
    );

    it("never sends the key to another origin, and reads its 401 as an error, not a revoked key", async () => {
      const f = stubCalls((url) =>
        url === ELSEWHERE
          ? new Response(null, { status: 401 })
          : new Response(null, { status: 302, headers: { location: ELSEWHERE } }),
      );
      try {
        const err = await new ApiClient(cfg).get("media/a.bin").catch((e: unknown) => e);
        expect(keyOf(f.calls[1]!.init)).toBeUndefined();
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(AuthError);
      } finally {
        f.restore();
      }
    });

    it("still reads the API's own 404 and 401 after a same-origin redirect", async () => {
      for (const [status, outcome] of [
        [404, "null"],
        [401, "auth"],
      ] as const) {
        const f = stubCalls((url) =>
          url === CANONICAL
            ? new Response(null, { status })
            : new Response(null, { status: 308, headers: { location: CANONICAL } }),
        );
        try {
          const got = await new ApiClient(cfg).get("media/a.bin").catch((e: unknown) => e);
          if (outcome === "null") expect(got).toBeNull();
          else expect(got).toBeInstanceOf(AuthError);
        } finally {
          f.restore();
        }
      }
    });

    it("gives up on a redirect loop", async () => {
      const f = stubCalls(
        () => new Response(null, { status: 302, headers: { location: API_FILE } }),
      );
      try {
        await expect(new ApiClient(cfg).get("media/a.bin")).rejects.toThrow(/too many redirects/);
      } finally {
        f.restore();
      }
    });
  });

  it("opts in, then follows the redirect itself WITHOUT the API key", async () => {
    const f = stubCalls((url) =>
      url === WORKER
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { "x-treehouse-version": "4" } })
        : redirect(),
    );
    try {
      const got = await new ApiClient(cfg).get("media/a.bin");
      expect(got?.version).toBe(4);
      expect(Array.from(await collect(got!.body))).toEqual([1, 2, 3]);
      const [api, worker] = f.calls;
      const sent = api!.init!.headers as Record<string, string>;
      expect(sent["x-treehouse-byte-redirect"]).toBe("1");
      expect(api!.init!.redirect).toBe("manual");
      expect(worker!.url).toBe(WORKER);
      expect(JSON.stringify(worker!.init ?? {})).not.toContain("x-api-key");
    } finally {
      f.restore();
    }
  });

  it("treats a Worker failure as an error, never as a deleted file or a revoked key", async () => {
    for (const status of [404, 403, 502]) {
      const f = stubCalls((url) => (url === WORKER ? new Response(null, { status }) : redirect()));
      try {
        const err = await new ApiClient(cfg).get("media/a.bin").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(AuthError);
        expect(String(err)).toContain(String(status));
      } finally {
        f.restore();
      }
    }
  });
});

describe("ApiClient streaming bodies", () => {
  it("returns a file's contents as a stream", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const f = stubFetch(
      () => new Response(payload, { status: 200, headers: { "x-treehouse-version": "2" } }),
    );
    try {
      const got = await new ApiClient(cfg).get("clip.mov");
      expect(got?.version).toBe(2);
      expect(Array.from(await collect(got!.body))).toEqual([1, 2, 3, 4, 5]);
    } finally {
      f.restore();
    }
  });

  it("uploads a stream over node:http and reads the reply like any other", async () => {
    const received: Buffer[] = [];
    let reply: { status: number; body: unknown } = { status: 201, body: { version: 1 } };
    const server = createServer((req, res) => {
      req.on("data", (c: Buffer) => received.push(c));
      req.on("end", () => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const api = new ApiClient({ ...cfg, apiBase: `http://127.0.0.1:${port}` });
    const pieces = () =>
      (async function* () {
        for (let i = 0; i < 5; i++) yield new Uint8Array(100_000).fill(i);
      })();
    try {
      expect(await api.put("clip.mov", pieces(), { create: true }, "video/mp4")).toEqual({
        ok: true,
        version: 1,
      });
      expect(Buffer.concat(received).byteLength).toBe(500_000);

      reply = { status: 412, body: { current_version: 3, conflict_copy_path: "clip (copy).mov" } };
      expect(await api.put("clip.mov", pieces(), { baseVersion: 2 }, "video/mp4")).toEqual({
        ok: false,
        conflict: true,
        currentVersion: 3,
        conflictCopyPath: "clip (copy).mov",
      });
    } finally {
      server.close();
    }
  });

  it("gives up on a streamed upload that stalls, instead of hanging", async () => {
    // Accepts the request, reads it, never answers.
    const server = createServer((req) => req.resume());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const api = new ApiClient({ ...cfg, apiBase: `http://127.0.0.1:${port}` });
    process.env.TREEHOUSE_UPLOAD_IDLE_MS = "200";
    try {
      const body = (async function* () {
        yield new Uint8Array(1000);
      })();
      await expect(api.put("clip.mov", body, { create: true }, "video/mp4")).rejects.toThrow(
        /upload stalled/,
      );
    } finally {
      delete process.env.TREEHOUSE_UPLOAD_IDLE_MS;
      server.closeAllConnections();
      server.close();
    }
  });

  it("keeps an early 401 as an auth failure even when the connection then drops", async () => {
    // Refuses on sight, before taking the body: the 401 headers go out, then
    // the connection drops while the reply body is still arriving.
    const server = createServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.flushHeaders();
      res.write('{"code":"KEY_');
      setTimeout(() => req.socket.destroy(), 50);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const api = new ApiClient({ ...cfg, apiBase: `http://127.0.0.1:${port}` });
    try {
      const body = (async function* () {
        for (let i = 0; i < 400; i++) yield new Uint8Array(64 * 1024);
      })();
      await expect(api.put("clip.mov", body, { create: true }, "video/mp4")).rejects.toBeInstanceOf(
        AuthError,
      );
    } finally {
      server.close();
    }
  });

  it("sends bytes in memory through fetch as they are", async () => {
    const orig = globalThis.fetch;
    let seen: RequestInit | undefined;
    globalThis.fetch = ((_: unknown, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(json({ version: 2 }, 200));
    }) as typeof fetch;
    try {
      const bytes = new Uint8Array([1]);
      await new ApiClient(cfg).put("a.md", bytes, { baseVersion: 1 }, "text/markdown");
      expect(seen?.body).toBe(bytes);
    } finally {
      globalThis.fetch = orig;
    }
  });
});