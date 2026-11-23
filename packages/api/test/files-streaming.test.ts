import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { useTempBlobDir } from "./blob-env";
import { serverAvailable } from "./env";

// Streaming uploads and byte ranges over real HTTP, against a RUNNING api dev
// server (see files-routes.test.ts). The body is larger than the in-memory spool
// threshold, so the upload goes through a temp file, and ranges cross chunk
// boundaries of the encrypted format when the server runs with a BLOB_KEK.

useTempBlobDir("treehouse-streaming-");

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { createShare } = await import("../server/utils/shares");
const { monthKey } = await import("../server/utils/share-usage");
const db = usePrismaClient();

const MIB = 1024 * 1024;
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `st${stamp}@example.test`, password: "correct-horse-battery", name: "ST" },
  });
  const org = await db.organization.create({ data: { id: `org_st_${stamp}`, name: "ST Org" } });
  await db.member.create({
    data: {
      id: `mem_st_${stamp}`,
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
      name: "st-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, key: key.key, ownerId: user.id };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function same(actual: ArrayBuffer, expected: Uint8Array) {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

describe.skipIf(!serverUp)("streaming file routes (HTTP)", () => {
  // 12 MiB plus change: past the 4 MiB in-memory spool, across many 1 MiB chunks.
  const body = new Uint8Array(randomBytes(12 * MIB + 4321));
  let ctx: Awaited<ReturnType<typeof setup>>;
  let fileUrl: string;

  const get = (headers: Record<string, string> = {}) =>
    fetch(fileUrl, { headers: { "x-api-key": ctx.key, ...headers } });

  it("uploads a large body through the spool and reads it back whole", async () => {
    ctx = await setup();
    fileUrl = `${BASE}/api/workspaces/${ctx.ws.id}/files/media/clip.bin`;
    const put = await fetch(fileUrl, {
      method: "PUT",
      headers: {
        "x-api-key": ctx.key,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
      body,
    });
    expect(put.status).toBe(201);

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(body.byteLength));
    expect(res.headers.get("x-treehouse-content-hash")).toBe(sha(body));
    same(await res.arrayBuffer(), body);
  });

  it("serves a range across a chunk boundary as 206", async () => {
    const res = await get({ range: `bytes=${MIB - 10}-${MIB + 10}` });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes ${MIB - 10}-${MIB + 10}/${body.byteLength}`,
    );
    expect(res.headers.get("content-length")).toBe("21");
    same(await res.arrayBuffer(), body.subarray(MIB - 10, MIB + 11));
  });

  it("serves suffix and open-ended ranges", async () => {
    const tail = await get({ range: "bytes=-100" });
    expect(tail.status).toBe(206);
    same(await tail.arrayBuffer(), body.subarray(-100));

    const from = body.byteLength - 5000;
    const rest = await get({ range: `bytes=${from}-` });
    expect(rest.status).toBe(206);
    same(await rest.arrayBuffer(), body.subarray(from));
  });

  it("answers a range past the end with 416 and the real size", async () => {
    const res = await get({ range: `bytes=${body.byteLength}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${body.byteLength}`);
  });

  it("serves the whole file for several ranges, which it does not support", async () => {
    const res = await get({ range: "bytes=0-1,5-6" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(body.byteLength));
    await res.arrayBuffer();
  });

  it("honours If-Range: the range when the version matches, the whole file when not", async () => {
    const etag = (await get({ range: "bytes=0-0" })).headers.get("etag")!;
    const match = await get({ range: "bytes=0-9", "if-range": etag });
    expect(match.status).toBe(206);
    await match.arrayBuffer();
    const stale = await get({ range: "bytes=0-9", "if-range": '"999"' });
    expect(stale.status).toBe(200);
    same(await stale.arrayBuffer(), body);
  });

  it("refuses an If-Range resume across a delete and recreate that reuses the version", async () => {
    // A prefix downloaded from version 1 of one file...
    const first = await get({ range: "bytes=0-9" });
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();
    expect(etag).toMatch(/^"1-/);

    // ...then the path is deleted and recreated with different bytes, which is
    // version 1 again.
    const other = new Uint8Array(randomBytes(64 * 1024));
    const path = `${BASE}/api/workspaces/${ctx.ws.id}/files/media/reused.bin`;
    const put = (bytes: Uint8Array) =>
      fetch(path, {
        method: "PUT",
        headers: {
          "x-api-key": ctx.key,
          "content-type": "application/octet-stream",
          "if-none-match": "*",
        },
        body: new Uint8Array(bytes),
      });
    expect((await put(body.subarray(0, 64 * 1024))).status).toBe(201);
    const original = await fetch(path, { headers: { "x-api-key": ctx.key, range: "bytes=0-9" } });
    const originalEtag = original.headers.get("etag")!;
    await original.arrayBuffer();
    const del = await fetch(path, {
      method: "DELETE",
      headers: { "x-api-key": ctx.key, "if-match": '"1"' },
    });
    expect(del.status).toBe(204);
    expect((await put(other)).status).toBe(201);

    // Resuming with the old validator must get the whole NEW file, not a range of it.
    const resumed = await fetch(path, {
      headers: { "x-api-key": ctx.key, range: "bytes=10-", "if-range": originalEtag },
    });
    expect(resumed.headers.get("x-treehouse-version")).toBe("1");
    expect(resumed.status).toBe(200);
    same(await resumed.arrayBuffer(), other);
  });

  it("serves ranges of a prior version", async () => {
    const res = await fetch(
      `${BASE}/api/workspaces/${ctx.ws.id}/version?path=media/clip.bin&version=1`,
      { headers: { "x-api-key": ctx.key, range: "bytes=5-14" } },
    );
    expect(res.status).toBe(206);
    same(await res.arrayBuffer(), body.subarray(5, 15));
  });

  it("serves ranges on a public link and counts only the bytes sent", async () => {
    const share = await createShare({
      workspaceId: ctx.ws.id,
      path: "media/clip.bin",
      kind: "file",
      access: "public",
      createdBy: ctx.ownerId,
    });
    const usage = () =>
      db.shareUsage.findUnique({
        where: {
          workspaceId_kind_period: { workspaceId: ctx.ws.id, kind: "month", period: monthKey() },
        },
      });
    const before = Number((await usage())?.bytes ?? 0);

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "user-agent": BROWSER, range: `bytes=${3 * MIB}-${3 * MIB + 99}` },
    });
    expect(res.status).toBe(206);
    same(await res.arrayBuffer(), body.subarray(3 * MIB, 3 * MIB + 100));
    // Metered once the response has been sent, so it lands just after the
    // client has the bytes: wait for it rather than racing it.
    const charged = async () => Number((await usage())?.bytes ?? 0) - before;
    for (let i = 0; i < 40 && (await charged()) < 100; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await charged()).toBe(100);

    // A first-time visitor is counted even when their first request is a range:
    // a Range header proves nothing about an earlier view.
    const views = async () =>
      (await db.share.findUnique({ where: { id: share.id } }))?.viewCount ?? 0;
    const viewsBefore = await views();
    const stranger = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: {
        "user-agent": `${BROWSER} stranger`,
        "x-forwarded-for": "203.0.113.77",
        range: "bytes=-10",
      },
    });
    await stranger.arrayBuffer();
    expect(stranger.status).toBe(206);
    expect(await views()).toBe(viewsBefore + 1);
  });
});