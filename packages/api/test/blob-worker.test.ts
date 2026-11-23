import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { frameSpan, openFrames, sealedLayout } from "blob-io/blob-crypto";
import { type BlobGrant, grantKeyRing, openGrant, sealUsageReport } from "blob-io/blob-grant";
import { collect, single } from "blob-io/byte-stream";
import { createApp, createRouter, type H3Event, toNodeListener } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

// The byte-Worker handoff on the API side: which requests are redirected, what
// the grant carries, that its key opens exactly the stored bytes (the Worker's
// half is in packages/blob-worker), and the usage-report route. The three byte
// routes and the report route run in-process on an h3 app over real HTTP, so
// no dev server has to be started with the Worker configured.

const BLOB_DIR = useTempBlobDir("treehouse-blob-worker-");
process.env.BLOB_KEK = `v1:${randomBytes(32).toString("base64")}`;
delete process.env.BLOB_KEK_RETIRED;
delete process.env.BLOB_WORKER_URL;
delete process.env.BLOB_WORKER_TOKEN_KEY;

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { useFileService } = await import("../server/utils/files");
const { createShare, shareCookieName, signShareUnlock } = await import("../server/utils/shares");
const { monthKey } = await import("../server/utils/share-usage");
const {
  HANDOFF_MIN_BYTES,
  handOff,
  resolveBlobWorker,
  setBlobWorkerForTesting,
  wantsByteRedirect,
  worthHandingOff,
} = await import("../server/utils/blob-worker");
const fileGet = (await import("../server/routes/api/workspaces/[workspaceId]/files/[...path].get"))
  .default;
const versionGet = (await import("../server/routes/api/workspaces/[workspaceId]/version.get"))
  .default;
const shareGet = (await import("../server/routes/api/share/[token]/file.get")).default;
const usagePost = (await import("../server/routes/api/internal/blob-usage.post")).default;

const db = usePrismaClient();
const svc = useFileService();

const KEY = `t1:${randomBytes(32).toString("base64")}`;
const ring = grantKeyRing(KEY, undefined)!;
const WORKER = { url: "https://blobs.test", ring };
const MIB = 1024 * 1024;
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const OPT_IN = { "x-treehouse-byte-redirect": "1" };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let server: Server;
let base = "";

beforeAll(async () => {
  const router = createRouter()
    .get("/api/workspaces/:workspaceId/files/**:path", fileGet)
    .get("/api/workspaces/:workspaceId/version", versionGet)
    .get("/api/share/:token/file", shareGet)
    .post("/api/internal/blob-usage", usagePost);
  const app = createApp();
  app.use(router);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setBlobWorkerForTesting(undefined);
  await new Promise((resolve) => server?.close(resolve));
});

beforeEach(() => setBlobWorkerForTesting(WORKER));

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `bw${stamp}@example.test`, password: "correct-horse-battery", name: "BW" },
  });
  const org = await db.organization.create({ data: { id: `org_bw_${stamp}`, name: "BW Org" } });
  await db.member.create({
    data: {
      id: `mem_bw_${stamp}`,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "bw-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, apiKey: key.key, ownerId: user.id };
}

const ctx = await setup();
const clip = new Uint8Array(randomBytes(2 * MIB + 4321));
const clipHash = sha(clip);
await svc.write({
  workspaceId: ctx.ws.id,
  path: "media/clip.mp4",
  body: clip,
  contentType: "video/mp4",
  actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
  nowIso: new Date().toISOString(),
});

// A video as the sync CLI stores it: no type, so octet-stream. It must still
// reach the Worker as video, or nothing will play it under nosniff.
const synced = new Uint8Array(randomBytes(MIB + 99));
await svc.write({
  workspaceId: ctx.ws.id,
  path: "media/synced.mp4",
  body: synced,
  contentType: "application/octet-stream",
  actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
  nowIso: new Date().toISOString(),
});

const asAgent = (extra: Record<string, string> = {}) => ({ "x-api-key": ctx.apiKey, ...extra });

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers, redirect: "manual" });
}

/** The grant a redirect carries, opened as the Worker would. */
function grantOf(res: Response): BlobGrant {
  expect(res.status).toBe(307);
  // The one redirect API clients follow without credentials says so.
  expect(res.headers.get("x-treehouse-byte-handoff")).toBe("1");
  const location = res.headers.get("location")!;
  expect(location.startsWith(`${WORKER.url}/b/`)).toBe(true);
  const grant = openGrant(ring, location.slice(`${WORKER.url}/b/`.length), Date.now() / 1000);
  expect(grant).not.toBeNull();
  return grant!;
}

/** Decrypt the stored object with nothing but the grant: the Worker's view. */
async function openWithGrant(grant: BlobGrant): Promise<Uint8Array> {
  const stored = new Uint8Array(
    await readFile(join(BLOB_DIR, grant.workspaceId, grant.contentHash)),
  );
  const layout = sealedLayout(grant.header, grant.size)!;
  const span = frameSpan(layout, null);
  return collect(
    openFrames(
      grant.header,
      layout,
      span.first,
      span.last,
      single(stored.subarray(span.storedStart, span.storedEnd + 1)),
      grant.key,
    ),
  );
}

const filePath = `/api/workspaces/${ctx.ws.id}/files/media/clip.mp4`;

describe("byte-Worker handoff: the file route", () => {
  it("redirects an opted-in client with a grant that opens exactly these bytes", async () => {
    const res = await get(filePath, asAgent(OPT_IN));
    const grant = grantOf(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    expect(grant).toMatchObject({
      workspaceId: ctx.ws.id,
      contentHash: clipHash,
      size: clip.byteLength,
      etag: `"1-${clipHash}"`,
      meter: false,
      headers: {
        "content-type": "video/mp4",
        "cache-control": "private, max-age=0, must-revalidate",
        "x-treehouse-version": "1",
        "x-treehouse-content-hash": clipHash,
      },
    });
    expect(grant.expiresAt - Date.now() / 1000).toBeGreaterThan(4 * 3600 - 5);
    expect(sha(await openWithGrant(grant))).toBe(clipHash);
  });

  it("carries the download disposition into the grant", async () => {
    const grant = grantOf(await get(`${filePath}?download=1`, asAgent(OPT_IN)));
    expect(grant.headers["content-disposition"]).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });

  it("gives a video stored without a type its media type in the grant", async () => {
    const grant = grantOf(
      await get(`/api/workspaces/${ctx.ws.id}/files/media/synced.mp4`, asAgent(OPT_IN)),
    );
    expect(grant.headers["content-type"]).toBe("video/mp4");
  });

  it("serves a download directly when its grant would be too long for the Worker", async () => {
    // A long non-ASCII name: the disposition carries it twice, percent-encoded.
    // Video, so the size rule hands it off and the grant length is what's tested.
    const name = `${"🌳".repeat(800)}.mp4`;
    const body = new Uint8Array(randomBytes(5000));
    await svc.write({
      workspaceId: ctx.ws.id,
      path: `media/${name}`,
      body,
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    const url = `/api/workspaces/${ctx.ws.id}/files/media/${encodeURIComponent(name)}`;
    const download = await get(`${url}?download=1`, asAgent(OPT_IN));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(sha(new Uint8Array(await download.arrayBuffer()))).toBe(sha(body));
    // The same file viewed (no disposition) still fits, and is handed off.
    expect((await get(url, asAgent(OPT_IN))).status).toBe(307);
  });

  it("serves an API client that did not opt in directly, as before", async () => {
    const res = await get(filePath, asAgent());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-treehouse-byte-handoff")).toBeNull();
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(clipHash);
  });

  it("serves a small file that isn't media here, even to a client that opted in", async () => {
    const body = new Uint8Array(randomBytes(200_000));
    await svc.write({
      workspaceId: ctx.ws.id,
      path: "pics/photo.png",
      body,
      contentType: "image/png",
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    const res = await get(`/api/workspaces/${ctx.ws.id}/files/pics/photo.png`, asAgent(OPT_IN));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-treehouse-byte-handoff")).toBeNull();
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(body));
  });

  it("hands off a small video named without an extension, by its stored type", async () => {
    const body = new Uint8Array(randomBytes(200_000));
    await svc.write({
      workspaceId: ctx.ws.id,
      path: "media/recording",
      body,
      contentType: "video/mp4",
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    const res = await get(`/api/workspaces/${ctx.ws.id}/files/media/recording`, asAgent(OPT_IN));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-treehouse-byte-handoff")).toBe("1");
  });

  it("hands off audio whose shared blob was re-uploaded under a playable type", async () => {
    const body = new Uint8Array(randomBytes(120_000));
    const write = (path: string, contentType: string) =>
      svc.write({
        workspaceId: ctx.ws.id,
        path,
        body,
        contentType,
        actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
        nowIso: new Date().toISOString(),
      });
    // The same bytes twice: one blob, now typed by the second upload, while
    // the first file's row keeps the type it was written with.
    await write("media/talk.m4a", "audio/x-m4a");
    await write("media/copy.m4a", "audio/mp4");
    const res = await get(`/api/workspaces/${ctx.ws.id}/files/media/talk.m4a`, asAgent(OPT_IN));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-treehouse-byte-handoff")).toBe("1");
  });

  it("hands off small audio uploaded under a type only its extension explains", async () => {
    for (const [path, contentType] of [
      ["media/safari.m4a", "audio/x-m4a"],
      ["media/take.wav", "audio/x-wav"],
    ]) {
      await svc.write({
        workspaceId: ctx.ws.id,
        path,
        body: new Uint8Array(randomBytes(90_000)),
        contentType,
        actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
        nowIso: new Date().toISOString(),
      });
      const res = await get(`/api/workspaces/${ctx.ws.id}/files/${path}`, asAgent(OPT_IN));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("x-treehouse-byte-handoff"), path).toBe("1");
    }
  });

  it("keeps a small HTML file served here inert, as the Worker would", async () => {
    await svc.write({
      workspaceId: ctx.ws.id,
      path: "pages/page.html",
      body: new TextEncoder().encode("<script>fetch('/api/workspace')</script>"),
      contentType: "text/html",
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    for (const url of [
      `/api/workspaces/${ctx.ws.id}/files/pages/page.html`,
      `/api/workspaces/${ctx.ws.id}/version?path=pages/page.html&version=1`,
    ]) {
      const res = await get(url, asAgent(OPT_IN));
      expect(res.status, url).toBe(200);
      expect(res.headers.get("x-treehouse-byte-handoff"), url).toBeNull();
      expect(res.headers.get("content-security-policy"), url).toBe("sandbox");
      expect(res.headers.get("x-content-type-options"), url).toBe("nosniff");
      await res.arrayBuffer();
    }
  });

  it("answers a matching If-None-Match with 304 here, without a redirect", async () => {
    const res = await get(filePath, asAgent({ ...OPT_IN, "if-none-match": `"1-${clipHash}"` }));
    expect(res.status).toBe(304);
  });

  it("still applies every gate first: an unknown path is a 404, not a grant", async () => {
    const res = await get(`/api/workspaces/${ctx.ws.id}/files/nope.bin`, asAgent(OPT_IN));
    expect(res.status).toBe(404);
  });

  it("serves directly when the Worker is not configured", async () => {
    setBlobWorkerForTesting(null);
    const res = await get(filePath, asAgent(OPT_IN));
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("keeps a legacy plaintext blob on the API, which alone can check it whole", async () => {
    // Audio by its path, so the size rule doesn't serve it first.
    const legacy = new TextEncoder().encode("# notes from before encryption\n");
    await svc.write({
      workspaceId: ctx.ws.id,
      path: "media/old.mp3",
      body: legacy,
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    await writeFile(join(BLOB_DIR, ctx.ws.id, sha(legacy)), legacy);
    const res = await get(`/api/workspaces/${ctx.ws.id}/files/media/old.mp3`, asAgent(OPT_IN));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(legacy);
  });
});

describe("byte-Worker handoff: the version route", () => {
  it("redirects a prior version with that version's validator", async () => {
    const grant = grantOf(
      await get(
        `/api/workspaces/${ctx.ws.id}/version?path=media/clip.mp4&version=1`,
        asAgent(OPT_IN),
      ),
    );
    expect(grant.etag).toBe(`"1-${clipHash}"`);
    expect(grant.headers).toEqual({ "content-type": "video/mp4" });
    expect(sha(await openWithGrant(grant))).toBe(clipHash);
  });

  it("carries the media type and a download disposition into a version's grant", async () => {
    const grant = grantOf(
      await get(
        `/api/workspaces/${ctx.ws.id}/version?path=media/synced.mp4&version=1&download=1`,
        asAgent(OPT_IN),
      ),
    );
    expect(grant.headers).toEqual({
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="synced.mp4"; filename*=UTF-8''synced.mp4`,
    });
  });

  it("answers an unknown version with 404, not a grant", async () => {
    const res = await get(
      `/api/workspaces/${ctx.ws.id}/version?path=media/clip.mp4&version=9`,
      asAgent(OPT_IN),
    );
    expect(res.status).toBe(404);
  });
});

describe("byte-Worker handoff: public share links", () => {
  const browser = (dest: string, extra: Record<string, string> = {}) => ({
    "user-agent": BROWSER,
    "sec-fetch-dest": dest,
    ...extra,
  });

  it("redirects a browser loading the bytes, metered, with the hardened headers", async () => {
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/clip.mp4",
      kind: "file",
      access: "public",
      createdBy: ctx.ownerId,
    });
    const views = async () => (await db.share.findUnique({ where: { id: share.id } }))!.viewCount;
    const before = await views();
    const grant = grantOf(await get(`/api/share/${share.token}/file`, browser("video")));
    expect(grant.meter).toBe(true);
    expect(grant.etag).toBe(`"v-1-${clipHash}"`);
    expect(grant.headers).toEqual({
      "content-type": "video/mp4",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // Video plays in the page, as on the direct path.
      "content-disposition": "inline",
      "cache-control": "private, max-age=0, must-revalidate",
    });
    // The view is still counted here, at the API, before the redirect.
    expect(await views()).toBe(before + 1);
  });

  it("turns a shared video into a download with ?download=1, typed even when stored without one", async () => {
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/synced.mp4",
      kind: "file",
      access: "public",
      createdBy: ctx.ownerId,
    });
    const played = grantOf(await get(`/api/share/${share.token}/file`, browser("video")));
    expect(played.headers["content-type"]).toBe("video/mp4");
    expect(played.headers["content-disposition"]).toBe("inline");
    const saved = grantOf(
      await get(`/api/share/${share.token}/file?download=1`, browser("document")),
    );
    expect(saved.headers["content-disposition"]).toBe(
      `attachment; filename="synced.mp4"; filename*=UTF-8''synced.mp4`,
    );
  });

  it("serves a small shared image directly, not through the Worker", async () => {
    const body = new Uint8Array(randomBytes(150_000));
    await svc.write({
      workspaceId: ctx.ws.id,
      path: "pics/shared.png",
      body,
      contentType: "image/png",
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "pics/shared.png",
      kind: "file",
      access: "public",
      createdBy: ctx.ownerId,
    });
    const res = await get(`/api/share/${share.token}/file`, browser("image"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-treehouse-byte-handoff")).toBeNull();
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(body));
  });

  it("hands off a small shared video named without an extension, by its stored type", async () => {
    await svc.write({
      workspaceId: ctx.ws.id,
      path: "media/shared-recording",
      body: new Uint8Array(randomBytes(150_000)),
      contentType: "video/mp4",
      actor: { principal: "agent", actorId: ctx.ownerId, access: asMember(ctx.ownerId) },
      nowIso: new Date().toISOString(),
    });
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/shared-recording",
      kind: "file",
      access: "public",
      createdBy: ctx.ownerId,
    });
    const res = await get(`/api/share/${share.token}/file`, browser("video"));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-treehouse-byte-handoff")).toBe("1");
  });

  it("serves a script read (Sec-Fetch-Dest: empty) directly", async () => {
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/clip.mp4",
      kind: "file",
      access: "public",
      createdBy: ctx.ownerId,
    });
    const res = await get(`/api/share/${share.token}/file`, browser("empty"));
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("gives a pinned permalink its immutable validator", async () => {
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/clip.mp4",
      kind: "file",
      access: "public",
      pinnedVersion: 1,
      pinnedContentHash: clipHash,
      createdBy: ctx.ownerId,
    });
    const grant = grantOf(await get(`/api/share/${share.token}/file`, browser("image")));
    expect(grant.etag).toBe(`"p-${clipHash}"`);
    expect(sha(await openWithGrant(grant))).toBe(clipHash);
  });

  it("gives a password-gated link no validator and no storage, as the API would", async () => {
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/clip.mp4",
      kind: "file",
      access: "public",
      password: "open sesame",
      createdBy: ctx.ownerId,
    });
    const locked = await get(`/api/share/${share.token}/file`, browser("video"));
    expect(locked.status).toBe(401);
    const cookie = `${shareCookieName(share.token!)}=${signShareUnlock(share.token!)}`;
    const grant = grantOf(
      await get(`/api/share/${share.token}/file`, browser("video", { cookie })),
    );
    expect(grant.etag).toBeNull();
    expect(grant.headers["cache-control"]).toBe("no-store");
  });
});

describe("byte-Worker usage reports", () => {
  const usage = async () =>
    Number(
      (
        await db.shareUsage.findUnique({
          where: {
            workspaceId_kind_period: { workspaceId: ctx.ws.id, kind: "month", period: monthKey() },
          },
        })
      )?.bytes ?? 0,
    );
  const post = (body: string) => fetch(`${base}/api/internal/blob-usage`, { method: "POST", body });

  it("counts the bytes a sealed report says the Worker sent", async () => {
    const before = await usage();
    const report = sealUsageReport(ring, {
      workspaceId: ctx.ws.id,
      bytes: 12345,
      at: Math.floor(Date.now() / 1000),
    });
    expect((await post(report)).status).toBe(204);
    expect((await usage()) - before).toBe(12345);
  });

  it("refuses a forged, foreign or stale report, and counts nothing", async () => {
    const before = await usage();
    const other = grantKeyRing(`t1:${randomBytes(32).toString("base64")}`, undefined)!;
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      "",
      "t1.AAAA",
      sealUsageReport(other, { workspaceId: ctx.ws.id, bytes: 1, at: now }),
      sealUsageReport(ring, { workspaceId: ctx.ws.id, bytes: 1, at: now - 3600 }),
    ];
    for (const body of bad) expect((await post(body)).status).toBe(401);
    expect(await usage()).toBe(before);
  });

  it("refuses an oversized body while reading it, with or without a Content-Length", async () => {
    const before = await usage();
    const big = "x".repeat(64 * 1024);
    expect((await post(big)).status).toBe(413);
    // Chunked: no Content-Length to check up front, so the cap has to hold mid-stream.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 64; i++) controller.enqueue(new Uint8Array(1024).fill(120));
        controller.close();
      },
    });
    const res = await fetch(`${base}/api/internal/blob-usage`, {
      method: "POST",
      body: chunked,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await usage()).toBe(before);
  });

  it("does not exist while the Worker is off", async () => {
    setBlobWorkerForTesting(null);
    expect((await post("anything")).status).toBe(404);
  });
});

describe("byte-Worker config and policy", () => {
  const event = (headers: Record<string, string>) =>
    ({ node: { req: { headers } } }) as unknown as H3Event;

  it("hands off video and audio of any size, and anything else only when large", () => {
    expect(worthHandingOff(1, "video/mp4", "recording")).toBe(true);
    expect(worthHandingOff(1, "audio/mpeg", "a.mp3")).toBe(true);
    // A type the app doesn't know, with an extension it plays: the viewer plays
    // it, so it is media here too.
    expect(worthHandingOff(1, "audio/x-m4a", "talk.m4a")).toBe(true);
    expect(worthHandingOff(1, "audio/x-wav", "take.wav")).toBe(true);
    expect(worthHandingOff(1, "application/octet-stream", "old.mp4")).toBe(true);
    // A browser's misreading (video/mp2t for TypeScript) is shown as text.
    expect(worthHandingOff(1, "video/mp2t", "index.ts")).toBe(false);
    expect(worthHandingOff(HANDOFF_MIN_BYTES - 1, "image/png", "a.png")).toBe(false);
    expect(worthHandingOff(HANDOFF_MIN_BYTES - 1, "application/octet-stream", "notes")).toBe(false);
    expect(worthHandingOff(HANDOFF_MIN_BYTES, "application/pdf", "a.pdf")).toBe(true);
  });

  it("decides a small non-media file from its stored size and type, without reading R2", async () => {
    let reads = 0;
    const svc = {
      sealedBlob: async () => {
        reads++;
        return null;
      },
    };
    const h = {
      workspaceId: "w",
      contentHash: "h",
      etag: null,
      meter: false,
      headers: () => ({}),
    };
    const known = (path: string, expectedType: string) =>
      handOff({} as H3Event, WORKER, svc, { ...h, path, expectedSize: 10, expectedType });
    // Not media, size and type known and small: no R2 read at all.
    expect(await known("a.png", "image/png")).toBe(false);
    expect(await known("notes", "application/octet-stream")).toBe(false);
    expect(reads).toBe(0);
    // Media by its path, its stored type, or both: the blob is looked at.
    await known("a.mp4", "application/octet-stream");
    await known("recording", "video/mp4");
    await known("talk.m4a", "audio/x-m4a");
    expect(reads).toBe(3);
    // Size or type unknown (a version, a pinned share): the blob decides.
    await handOff({} as H3Event, WORKER, svc, { ...h, path: "a.png" });
    await handOff({} as H3Event, WORKER, svc, { ...h, path: "a.png", expectedSize: 10 });
    expect(reads).toBe(5);
  });

  it("sends only clients known to follow it without their credentials", () => {
    expect(wantsByteRedirect(event({ "sec-fetch-dest": "image" }))).toBe(true);
    expect(wantsByteRedirect(event({ "sec-fetch-dest": "video" }))).toBe(true);
    expect(wantsByteRedirect(event({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(wantsByteRedirect(event({ "x-api-key": "k", ...OPT_IN }))).toBe(true);
    // Script reads, plain API clients, and anything that cannot say.
    expect(wantsByteRedirect(event({ "sec-fetch-dest": "empty" }))).toBe(false);
    expect(wantsByteRedirect(event({ "x-api-key": "k" }))).toBe(false);
    expect(wantsByteRedirect(event({ "x-api-key": "k", "sec-fetch-dest": "image" }))).toBe(false);
    expect(wantsByteRedirect(event({ authorization: "Bearer k", "sec-fetch-dest": "image" }))).toBe(
      false,
    );
    expect(wantsByteRedirect(event({}))).toBe(false);
    // The desktop shell refuses navigations (and their redirects) off the app
    // and API origins, so its downloads and pages stay here; its media do not.
    const desktop = "Mozilla/5.0 Chrome/140.0 Electron/38.0 TreehouseDesktop/1.4.0";
    for (const dest of ["document", "iframe"]) {
      expect(wantsByteRedirect(event({ "sec-fetch-dest": dest, "user-agent": desktop }))).toBe(
        false,
      );
    }
    expect(wantsByteRedirect(event({ "sec-fetch-dest": "video", "user-agent": desktop }))).toBe(
      true,
    );
  });

  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

  it("is on only with a URL and a valid key, and never throws otherwise", () => {
    expect(resolveBlobWorker(env({}))).toEqual({ worker: null, ring: null, problem: null });
    // The rollout/rollback state: key set, URL not. Off, quietly, but the ring
    // is kept so grants already issued can still report their bytes.
    const keyOnly = resolveBlobWorker(env({ BLOB_WORKER_TOKEN_KEY: KEY }));
    expect(keyOnly.worker).toBeNull();
    expect(keyOnly.ring).not.toBeNull();
    expect(keyOnly.problem).toBeNull();
    // Half-set the other way, or malformed: off, with the reason for the log.
    const urlOnly = resolveBlobWorker(env({ BLOB_WORKER_URL: "https://b.test" }));
    expect(urlOnly).toMatchObject({ worker: null, ring: null });
    expect(urlOnly.problem).toMatch(/BLOB_WORKER_TOKEN_KEY is not/);
    const bad = resolveBlobWorker(
      env({ BLOB_WORKER_URL: "https://b.test", BLOB_WORKER_TOKEN_KEY: "t1:x" }),
    );
    expect(bad.worker).toBeNull();
    expect(bad.problem).toMatch(/malformed/);
    const notUrl = resolveBlobWorker(
      env({ BLOB_WORKER_URL: "b test", BLOB_WORKER_TOKEN_KEY: KEY }),
    );
    expect(notUrl.worker).toBeNull();
    expect(notUrl.problem).toMatch(/not a URL/);
    expect(
      resolveBlobWorker(env({ BLOB_WORKER_URL: "https://b.test/", BLOB_WORKER_TOKEN_KEY: KEY }))
        .worker?.url,
    ).toBe("https://b.test");
  });

  it("in production, stays off without https and an R2-backed store", () => {
    const prod = (url: string) =>
      env({ NODE_ENV: "production", BLOB_WORKER_URL: url, BLOB_WORKER_TOKEN_KEY: KEY });
    expect(resolveBlobWorker(prod("http://b.test"))).toMatchObject({
      worker: null,
      problem: expect.stringMatching(/https/),
    });
    // This suite's store is the filesystem driver, which the Worker cannot read.
    expect(resolveBlobWorker(prod("https://b.test"))).toMatchObject({
      worker: null,
      problem: expect.stringMatching(/not R2/),
    });
  });
});

describe("byte-Worker partial configuration never breaks serving", () => {
  const saved = { ...process.env };
  const configure = (vars: Record<string, string>) => {
    delete process.env.BLOB_WORKER_URL;
    delete process.env.BLOB_WORKER_TOKEN_KEY;
    Object.assign(process.env, vars);
    setBlobWorkerForTesting(undefined); // re-read the environment
  };
  afterAll(() => {
    process.env.BLOB_WORKER_URL = saved.BLOB_WORKER_URL;
    process.env.BLOB_WORKER_TOKEN_KEY = saved.BLOB_WORKER_TOKEN_KEY;
    if (saved.BLOB_WORKER_URL === undefined) delete process.env.BLOB_WORKER_URL;
    if (saved.BLOB_WORKER_TOKEN_KEY === undefined) delete process.env.BLOB_WORKER_TOKEN_KEY;
  });

  const configs: [string, Record<string, string>][] = [
    ["only the key (rollout, rollback)", { BLOB_WORKER_TOKEN_KEY: KEY }],
    ["only the URL", { BLOB_WORKER_URL: "https://blobs.test" }],
    ["a malformed key", { BLOB_WORKER_URL: "https://blobs.test", BLOB_WORKER_TOKEN_KEY: "t1:no" }],
  ];

  it.each(configs)("with %s, opted-in and browser reads are served by the API", async (_, vars) => {
    configure(vars);
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      for (const headers of [asAgent(OPT_IN), asAgent(), { "sec-fetch-dest": "image" }]) {
        const res = await get(filePath, headers);
        if ("x-api-key" in headers) {
          expect(res.status).toBe(200);
          expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(clipHash);
        } else {
          await res.arrayBuffer(); // a browser with no session: 401, as ever, never a 500
          expect(res.status).toBe(401);
        }
      }
    } finally {
      console.error = log;
    }
    // Logged at most once for the process, not once per request.
    expect(errors.length).toBeLessThanOrEqual(1);
  });

  it("still opens reports from grants issued before the URL was removed", async () => {
    configure({ BLOB_WORKER_TOKEN_KEY: KEY });
    const report = sealUsageReport(ring, {
      workspaceId: ctx.ws.id,
      bytes: 1,
      at: Math.floor(Date.now() / 1000),
    });
    const res = await fetch(`${base}/api/internal/blob-usage`, { method: "POST", body: report });
    expect(res.status).toBe(204);
  });
});