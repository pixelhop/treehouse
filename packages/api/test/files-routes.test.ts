import { describe, expect, it } from "vite-plus/test";
import { useTempBlobDir } from "./blob-env";
import { serverAvailable } from "./env";

// Route-level integration test against a RUNNING api dev server. It exercises
// the real HTTP path (api-key auth, route params, raw body, ETag, conflict
// status codes). It is gated on the server being reachable so `vp test` stays
// green in environments without one — start the server with
// `pnpm --filter api dev` (and set SMOKE_BASE if not on :3001) to run it.

useTempBlobDir("treehouse-routes-");

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
// Under REQUIRE_SERVER=1 this THROWS instead of returning false, so a suite that
// exists to prove an authorization boundary fails rather than skipping to green
// — including when the server disappears for only part of a run. It also carries
// a deadline, so a peer that connects and then says nothing cannot hang the gate.
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { setNodePrivate } = await import("../server/utils/acl");
const db = usePrismaClient();

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `rt${stamp}@example.test`, password: "correct-horse-battery", name: "RT" },
  });
  const org = await db.organization.create({ data: { id: `org_rt_${stamp}`, name: "RT Org" } });
  await db.member.create({
    data: {
      id: `mem_rt_${stamp}`,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const ws2 = await db.workspace.create({ data: { organizationId: org.id, name: "Other" } });
  const key = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "rt-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, ws2, key: key.key, ownerId: user.id };
}

// A workspace with two members of the same org, each holding a workspace-scoped
// key — for exercising the per-requester ACL filter on the change feed.
async function setupTwoMembers() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user: owner } = await auth.api.signUpEmail({
    body: { email: `own${stamp}@example.test`, password: "correct-horse-battery", name: "Owner" },
  });
  const { user: member } = await auth.api.signUpEmail({
    body: { email: `mem${stamp}@example.test`, password: "correct-horse-battery", name: "Member" },
  });
  const org = await db.organization.create({ data: { id: `org_tm_${stamp}`, name: "TM Org" } });
  await db.member.create({
    data: {
      id: `mem_own_${stamp}`,
      organizationId: org.id,
      userId: owner.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
  await db.member.create({
    data: {
      id: `mem_mem_${stamp}`,
      organizationId: org.id,
      userId: member.id,
      role: "member",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Shared" } });
  const ownerKey = await auth.api.createApiKey({
    body: { userId: owner.id, name: "own", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  const memberKey = await auth.api.createApiKey({
    body: { userId: member.id, name: "mem", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  return { ws, owner, member, ownerKey: ownerKey.key, memberKey: memberKey.key };
}

describe.skipIf(!serverUp)("file routes (HTTP)", () => {
  it("creates then reads a file with ETag and agent attribution", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key };

    const put = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes.md`, {
      method: "PUT",
      headers: { ...h, "content-type": "text/markdown", "if-none-match": "*" },
      body: "# Smoke",
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("etag")).toBe('"1"');

    const get = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes.md`, { headers: h });
    expect(get.status).toBe(200);
    // Version first (older clients parse it from here), then the content hash,
    // which makes it a sound validator across a delete and recreate.
    expect(get.headers.get("etag")).toMatch(/^"1-[0-9a-f]{64}"$/);
    // The version also travels under a name no CDN claims: a proxy that
    // compresses or transforms the response can weaken the ETag to W/"1" or drop
    // it entirely (Cloudflare does exactly that to text/html), and a client that
    // can only learn the version from the ETag then cannot read a single file.
    expect(get.headers.get("x-treehouse-version")).toBe("1");
    expect(await get.text()).toBe("# Smoke");

    const changes = (await (
      await fetch(`${BASE}/api/workspaces/${ws.id}/changes`, { headers: h })
    ).json()) as {
      changes: { op: string; principal: string }[];
    };
    expect(changes.changes.some((c) => c.op === "write" && c.principal === "agent")).toBe(true);
  });

  it("serves ?download=1 as an attachment, everything else inline", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key };
    // Every RFC 5987 straggler in one name: encodeURIComponent leaves ' ( ) *
    // literal, but they are not attr-chars, and a strict client would reject
    // the whole UTF-8 filename over any one of them.
    const name = "Bob's file (v2)* — final.md";
    const url = `${BASE}/api/workspaces/${ws.id}/files/${encodeURIComponent(name)}`;

    await fetch(url, {
      method: "PUT",
      headers: { ...h, "content-type": "text/markdown", "if-none-match": "*" },
      body: "# Bytes",
    });

    // The app is cross-origin from the API, where an anchor's `download`
    // attribute is ignored — the server's `attachment` is what makes the
    // browser save instead of navigate.
    const dl = await fetch(`${url}?download=1`, { headers: h });
    expect(dl.status).toBe(200);
    const disposition = dl.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    // ASCII fallback: the non-ASCII dash flattened, the quote-breaking
    // apostrophe swapped; the real name travels in filename*.
    expect(disposition).toContain(`filename="Bob's file (v2)* _ final.md"`);
    expect(disposition).toContain(
      "filename*=UTF-8''Bob%27s%20file%20%28v2%29%2A%20%E2%80%94%20final.md",
    );
    expect(await dl.text()).toBe("# Bytes");

    // A plain read stays viewable in the tab — and so does anything that isn't
    // exactly download=1, which is the documented contract.
    for (const suffix of ["", "?download=0", "?download=true"]) {
      const view = await fetch(`${url}${suffix}`, { headers: h });
      expect(view.status).toBe(200);
      expect(view.headers.get("content-disposition")).toBeNull();
    }
  });

  it("serves media synced as octet-stream under its real type, live and as a prior version", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key };
    const url = `${BASE}/api/workspaces/${ws.id}/files/clips/demo.mp4`;
    // What the sync CLI stored for an .mp4 before the file-type table knew it.
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...h, "content-type": "application/octet-stream", "if-none-match": "*" },
      body: "not really a video",
    });
    expect(put.status).toBe(201);

    const live = await fetch(url, { headers: h });
    expect(live.headers.get("content-type")).toBe("video/mp4");
    await live.arrayBuffer();

    const version = `${BASE}/api/workspaces/${ws.id}/version?path=clips/demo.mp4&version=1`;
    const old = await fetch(version, { headers: { ...h, range: "bytes=0-2" } });
    expect(old.status).toBe(206);
    expect(old.headers.get("content-type")).toBe("video/mp4");
    expect(old.headers.get("content-disposition")).toBeNull();
    expect(await old.text()).toBe("not");

    // `download=1` saves a prior version too, rather than playing it.
    const dl = await fetch(`${version}&download=1`, { headers: h });
    expect(dl.headers.get("content-disposition")).toContain('attachment; filename="demo.mp4"');
    await dl.arrayBuffer();

    // Only media is renamed on the way out: other bytes stay what they were stored as.
    const page = `${BASE}/api/workspaces/${ws.id}/files/page.html`;
    await fetch(page, {
      method: "PUT",
      headers: { ...h, "content-type": "application/octet-stream", "if-none-match": "*" },
      body: "<p>hi</p>",
    });
    const pageRes = await fetch(page, { headers: h });
    expect(pageRes.headers.get("content-type")).toBe("application/octet-stream");
    await pageRes.arrayBuffer();
  });

  it("names the reason when a key is rejected", async () => {
    const { ws } = await setup();

    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes.md`, {
      headers: { "x-api-key": "th_not_a_real_key" },
    });

    expect(res.status).toBe(401);
    // better-auth never THROWS from verifyApiKey — a missing key, an expired
    // key, a usage cap and a failed database lookup all come back as
    // `valid: false` — so without this code every cause reaches the client as an
    // indistinguishable bare 401 and reads as "your key was revoked".
    const body = (await res.json()) as { data?: { error?: string; reason?: string } };
    expect(body.data?.error).toBe("invalid_api_key");
    expect(body.data?.reason).toBe("INVALID_API_KEY");
  });

  it("returns 412 + a conflicted copy on a stale write", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/p.md`, {
      method: "PUT",
      headers: { ...h, "if-none-match": "*" },
      body: "v1",
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/p.md`, {
      method: "PUT",
      headers: { ...h, "if-match": '"1"' },
      body: "v2",
    });
    const stale = await fetch(`${BASE}/api/workspaces/${ws.id}/files/p.md`, {
      method: "PUT",
      headers: { ...h, "if-match": '"1"' },
      body: "stale",
    });
    expect(stale.status).toBe(412);
    const bodyJson = (await stale.json()) as { error: string; conflict_copy_path: string };
    expect(bodyJson.error).toBe("version_conflict");
    expect(bodyJson.conflict_copy_path).toContain("conflicted copy");
  });

  it("enforces auth + workspace scoping", async () => {
    const { ws, ws2, key } = await setup();
    const noauth = await fetch(`${BASE}/api/workspaces/${ws.id}/files/notes.md`);
    expect(noauth.status).toBe(401);
    const mismatch = await fetch(`${BASE}/api/workspaces/${ws2.id}/files/notes.md`, {
      headers: { "x-api-key": key },
    });
    expect(mismatch.status).toBe(403);
  });

  it("rejects path traversal", async () => {
    const { ws, key } = await setup();
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/..%2f..%2fescape`, {
      headers: { "x-api-key": key },
    });
    expect([400, 404]).toContain(res.status);
  });

  type ChangesBody = {
    changes: { op: string; path: string; seq: number; createdAt: string }[];
    head: number;
    nextSeq?: number;
  };
  const getChanges = (ws: string, key: string, qs: string) =>
    fetch(`${BASE}/api/workspaces/${ws}/changes${qs}`, {
      headers: { "x-api-key": key },
    }).then((r) => r.json()) as Promise<ChangesBody>;

  it("exposes a numeric seq cursor + head; sinceSeq returns only newer events", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/a.md`, {
      method: "PUT",
      headers: h,
      body: "a",
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/b.md`, {
      method: "PUT",
      headers: h,
      body: "b",
    });

    const first = await getChanges(ws.id, key, "?sinceSeq=0");
    expect(first.changes.length).toBeGreaterThanOrEqual(2);
    // seq is a JS number (not a BigInt-stringified value) and strictly ascending.
    for (const c of first.changes) expect(typeof c.seq).toBe("number");
    const seqs = first.changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    // With sinceSeq=0 and the default limit, the page reaches head.
    expect(typeof first.head).toBe("number");
    expect(first.head).toBe(seqs[seqs.length - 1]);

    // Polling from the last seq is caught up: no new events, head unchanged.
    const next = await getChanges(ws.id, key, `?sinceSeq=${first.head}`);
    expect(next.changes).toEqual([]);
    expect(next.head).toBe(first.head);
  });

  it("reports head 0 and no changes for a fresh workspace", async () => {
    const { ws, key } = await setup();
    const body = await getChanges(ws.id, key, "?sinceSeq=0");
    expect(body.changes).toEqual([]);
    expect(body.head).toBe(0);
  });

  it("records a move as two events with distinct seq (delete before move)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/m.md`, {
      method: "PUT",
      headers: { ...h, "if-none-match": "*" },
      body: "m",
    });
    const moved = await fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ from: "m.md", to: "n.md" }),
    });
    expect(moved.ok).toBe(true);

    const { changes } = await getChanges(ws.id, key, "?sinceSeq=0");
    const del = changes.find((c) => c.op === "delete" && c.path === "m.md");
    const mv = changes.find((c) => c.op === "move" && c.path === "n.md");
    expect(del).toBeDefined();
    expect(mv).toBeDefined();
    // Same transaction, two distinct seqs — delete is recorded before move.
    expect(mv!.seq).not.toBe(del!.seq);
    expect(mv!.seq).toBeGreaterThan(del!.seq);
  });

  it("restores a prior version as a new head version (U4)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/r.md`, {
      method: "PUT",
      headers: { ...h, "if-none-match": "*" },
      body: "v1",
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/r.md`, {
      method: "PUT",
      headers: { ...h, "if-match": '"1"' },
      body: "v2",
    });
    const restore = await fetch(`${BASE}/api/workspaces/${ws.id}/restore`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ path: "r.md", targetVersion: 1 }),
    });
    expect(restore.status).toBe(200);
    const body = (await restore.json()) as { version: number; restoredFrom: number };
    expect(body).toMatchObject({ version: 3, restoredFrom: 1 });
    const cur = await fetch(`${BASE}/api/workspaces/${ws.id}/files/r.md`, { headers: h });
    expect(await cur.text()).toBe("v1");
  });

  it("reads a prior version's bytes via ?path&version (U4)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/v.md`, {
      method: "PUT",
      headers: { ...h, "if-none-match": "*" },
      body: "old",
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/v.md`, {
      method: "PUT",
      headers: { ...h, "if-match": '"1"' },
      body: "new",
    });
    const v1 = await fetch(
      `${BASE}/api/workspaces/${ws.id}/version?path=${encodeURIComponent("v.md")}&version=1`,
      { headers: { "x-api-key": key } },
    );
    expect(v1.status).toBe(200);
    expect(await v1.text()).toBe("old");
  });

  it("returns org members with name + image and no email (U4)", async () => {
    const { ws, key } = await setup();
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/members`, {
      headers: { "x-api-key": key },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Record<string, unknown>[] };
    expect(body.members.length).toBeGreaterThanOrEqual(1);
    for (const m of body.members) {
      expect(m).toHaveProperty("id");
      expect(m).toHaveProperty("name");
      expect(m).not.toHaveProperty("email");
    }
  });

  it("keeps the legacy ?since (ISO) + ?order=desc path working", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/x.md`, {
      method: "PUT",
      headers: h,
      body: "x",
    });

    const iso = new Date(Date.now() - 60_000).toISOString();
    const byTime = await getChanges(ws.id, key, `?since=${encodeURIComponent(iso)}`);
    expect(byTime.changes.some((c) => c.op === "write" && c.path === "x.md")).toBe(true);
    // seq is still present (as a number) on the legacy path, and head is returned.
    expect(typeof byTime.head).toBe("number");
    for (const c of byTime.changes) expect(typeof c.seq).toBe("number");

    const desc = await getChanges(ws.id, key, "?order=desc");
    const descSeqs = desc.changes.map((c) => c.seq);
    expect(descSeqs).toEqual([...descSeqs].sort((a, b) => b - a));
  });

  it("returns nextSeq = last scanned seq on the sinceSeq path (U1)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/a.md`, {
      method: "PUT",
      headers: h,
      body: "a",
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/b.md`, {
      method: "PUT",
      headers: h,
      body: "b",
    });

    const page = await getChanges(ws.id, key, "?sinceSeq=0");
    const lastSeq = page.changes[page.changes.length - 1]!.seq;
    // All events are visible to this single member, so nextSeq is the last seq.
    expect(page.nextSeq).toBe(lastSeq);
    expect(page.nextSeq).toBe(page.head);
  });

  it("returns nextSeq = the request cursor on an empty feed (U1)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/a.md`, {
      method: "PUT",
      headers: h,
      body: "a",
    });
    const first = await getChanges(ws.id, key, "?sinceSeq=0");
    // Poll from head: nothing new, nextSeq stays put at the cursor (no regress).
    const caught = await getChanges(ws.id, key, `?sinceSeq=${first.head}`);
    expect(caught.changes).toEqual([]);
    expect(caught.nextSeq).toBe(first.head);
  });

  it("omits nextSeq on the time/desc path (U1)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/a.md`, {
      method: "PUT",
      headers: h,
      body: "a",
    });
    const desc = await getChanges(ws.id, key, "?order=desc");
    expect(desc.nextSeq).toBeUndefined();
  });

  it("nextSeq carries a member past a fully ACL-filtered page to the visible event (U1)", async () => {
    const { ws, owner, ownerKey, memberKey } = await setupTwoMembers();
    // Owner makes a folder private, then writes three files into it. Those three
    // write events are visible only to the owner.
    await setNodePrivate({ workspaceId: ws.id, path: "priv", kind: "folder", ownerId: owner.id });
    const oh = { "x-api-key": ownerKey, "content-type": "text/markdown", "if-none-match": "*" };
    for (const name of ["a", "b", "c"]) {
      const r = await fetch(`${BASE}/api/workspaces/${ws.id}/files/priv/${name}.md`, {
        method: "PUT",
        headers: oh,
        body: name,
      });
      expect(r.status).toBe(201);
    }
    // A shared file everyone can see, recorded after the three private writes.
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/shared.md`, {
      method: "PUT",
      headers: oh,
      body: "shared",
    });

    // The member scans the first three (all private) with limit=3: the page is
    // fully filtered to [], but nextSeq covers the scanned rows.
    const filtered = await getChanges(ws.id, memberKey, "?sinceSeq=0&limit=3");
    expect(filtered.changes).toEqual([]);
    expect(filtered.nextSeq).toBeGreaterThan(0);

    // Polling from nextSeq reaches the visible event beyond the filtered window.
    const next = await getChanges(ws.id, memberKey, `?sinceSeq=${filtered.nextSeq}`);
    expect(next.changes.some((c) => c.path === "shared.md")).toBe(true);
  });

  it("usage endpoint reports used bytes and unlimited limit, reflecting writes", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key };

    const before = (await (
      await fetch(`${BASE}/api/workspaces/${ws.id}/usage`, { headers: h })
    ).json()) as {
      usedBytes: number;
      limitBytes: number | null;
      remainingBytes: number | null;
      warning: boolean;
    };
    expect(before).toMatchObject({
      usedBytes: 0,
      limitBytes: null,
      remainingBytes: null,
      warning: false,
    });

    await fetch(`${BASE}/api/workspaces/${ws.id}/files/u.md`, {
      method: "PUT",
      headers: { ...h, "content-type": "text/markdown", "if-none-match": "*" },
      body: "12345",
    });
    const after = (await (
      await fetch(`${BASE}/api/workspaces/${ws.id}/usage`, { headers: h })
    ).json()) as {
      usedBytes: number;
    };
    expect(after.usedBytes).toBe(5);
  });

  it("usage endpoint rejects a key scoped to a different workspace (403)", async () => {
    const { ws2, key } = await setup();
    const res = await fetch(`${BASE}/api/workspaces/${ws2.id}/usage`, {
      headers: { "x-api-key": key },
    });
    expect(res.status).toBe(403);
  });

  it("usage endpoint requires authentication (401)", async () => {
    const { ws } = await setup();
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/usage`);
    expect(res.status).toBe(401);
  });

  it("list returns nextCursor: null and accepts reserved limit/cursor params (U3)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/a.md`, {
      method: "PUT",
      headers: h,
      body: "a",
    });

    const plain = (await (
      await fetch(`${BASE}/api/workspaces/${ws.id}/list`, { headers: { "x-api-key": key } })
    ).json()) as { entries: { path: string }[]; nextCursor: unknown };
    expect(plain.nextCursor).toBeNull();
    expect(plain.entries.some((e) => e.path === "a.md")).toBe(true);

    // Passing the reserved params is accepted (no error), still nextCursor null.
    const paged = await fetch(`${BASE}/api/workspaces/${ws.id}/list?limit=50&cursor=abc`, {
      headers: { "x-api-key": key },
    });
    expect(paged.status).toBe(200);
    expect(((await paged.json()) as { nextCursor: unknown }).nextCursor).toBeNull();

    // A malformed limit is rejected (400), so a real implementation can rely on it.
    const bad = await fetch(`${BASE}/api/workspaces/${ws.id}/list?limit=notanumber`, {
      headers: { "x-api-key": key },
    });
    expect(bad.status).toBe(400);
  });

  it("list adds dates, modifier and new-ness only when asked with details=1", async () => {
    const { ws, key } = await setup();
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/a.md`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
      body: "a",
    });
    type Entry = { path: string; createdAt?: string; modifiedBy?: unknown; unseen?: boolean };
    const list = async (qs: string) =>
      (
        (await (
          await fetch(`${BASE}/api/workspaces/${ws.id}/list${qs}`, {
            headers: { "x-api-key": key },
          })
        ).json()) as { entries: Entry[] }
      ).entries.find((e) => e.path === "a.md");

    // Sync clients list constantly and get the lean shape they always had.
    expect(Object.keys((await list("")) ?? {}).sort()).toEqual([
      "contentType",
      "path",
      "size",
      "version",
    ]);
    const detailed = await list("?details=1");
    expect(detailed?.createdAt).toEqual(expect.any(String));
    expect(detailed?.modifiedBy).toMatchObject({ principal: "agent", actorLabel: "rt-agent" });
    // Written by an agent, so it is new to the key's own owner too.
    expect(detailed?.unseen).toBe(true);
  });
});

// Upload size cap (U2). These assert HTTP 413 behavior, so they need the api
// server booted with a small, known MAX_FILE_BYTES. To exercise them, start the
// server with e.g. `MAX_FILE_BYTES=1024` and run the suite with
// `SMOKE_MAX_FILE_BYTES=1024` set; otherwise they skip (a default-config server
// would need a 100 MB body to trip the cap).
const SMALL_LIMIT = process.env.SMOKE_MAX_FILE_BYTES
  ? Number.parseInt(process.env.SMOKE_MAX_FILE_BYTES, 10)
  : undefined;

describe.skipIf(!serverUp || SMALL_LIMIT === undefined)("upload size cap (U2)", () => {
  const limit = SMALL_LIMIT as number;

  it("rejects a declared Content-Length over the limit with 413", async () => {
    const { ws, key } = await setup();
    // A fixed-size body → fetch sets Content-Length; the route rejects before
    // buffering it.
    const body = new Uint8Array(limit + 1).fill(97);
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/big.bin`, {
      method: "PUT",
      headers: {
        "x-api-key": key,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  it("aborts a chunked upload with no Content-Length mid-stream (413, no partial row)", async () => {
    const { ws, key } = await setup();
    // A ReadableStream body has no known length → undici sends it chunked (no
    // Content-Length), so only the mid-stream counter can catch the overflow.
    const half = Math.ceil(limit / 2) + 1;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(half).fill(98));
        controller.enqueue(new Uint8Array(half).fill(98)); // total > limit
        controller.close();
      },
    });
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/stream.bin`, {
      method: "PUT",
      headers: {
        "x-api-key": key,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
      body: stream,
      // Required by undici for a stream request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(413);

    // No FileNode row was committed for the aborted upload.
    const get = await fetch(`${BASE}/api/workspaces/${ws.id}/files/stream.bin`, {
      headers: { "x-api-key": key },
    });
    expect(get.status).toBe(404);
  });

  it("accepts a body at exactly the limit", async () => {
    const { ws, key } = await setup();
    const body = new Uint8Array(limit).fill(99);
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/exact.bin`, {
      method: "PUT",
      headers: {
        "x-api-key": key,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
      body,
    });
    expect(res.status).toBe(201);
  });
});