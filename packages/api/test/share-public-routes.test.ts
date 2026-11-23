import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// Security characterization of the UNAUTHENTICATED public-share boundary against
// a RUNNING api dev server. Files are created over HTTP (so their bytes live in
// the server's blob store); shares are created via the service (shared DB).
// Server-gated.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
// Under REQUIRE_SERVER=1 this THROWS instead of returning false, so a suite that
// exists to prove an authorization boundary fails rather than skipping to green
// — including when the server disappears for only part of a run. It also carries
// a deadline, so a peer that connects and then says nothing cannot hang the gate.
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { createShare, revokeShare } = await import("../server/utils/shares");
const { setNodePrivate } = await import("../server/utils/acl");
const db = usePrismaClient();

const sha256 = (s: string) =>
  createHash("sha256").update(new TextEncoder().encode(s)).digest("hex");

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `ps${stamp}@example.test`, password: "correct-horse-battery", name: "PS" },
  });
  const org = await db.organization.create({ data: { id: `org_ps_${stamp}`, name: "PS Org" } });
  await db.member.create({
    data: {
      id: `mem_ps_${stamp}`,
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
      name: "ps-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, key: key.key, userId: user.id };
}

async function putFile(
  wsId: string,
  key: string,
  path: string,
  body: string,
  baseVersion?: number,
) {
  const headers: Record<string, string> = { "x-api-key": key, "content-type": "text/markdown" };
  if (baseVersion === undefined) headers["if-none-match"] = "*";
  else headers["if-match"] = `"${baseVersion}"`;
  const res = await fetch(`${BASE}/api/workspaces/${wsId}/files/${path}`, {
    method: "PUT",
    headers,
    body,
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
}

describe.skipIf(!serverUp)("public share routes (HTTP)", () => {
  it("serves a public file share with no login", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "open.md", "open bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "open.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const res = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("open bytes");
  });

  it("folder share: lists the subtree and serves files within, rejects outside scope", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "dir/a.md", "inside a");
    await putFile(ws.id, key, "dir/sub/b.md", "inside b");
    await putFile(ws.id, key, "dir2/secret.md", "SECRET");
    const share = await createShare({
      workspaceId: ws.id,
      path: "dir",
      kind: "folder",
      access: "public",
      createdBy: userId,
    });

    const list = await fetch(`${BASE}/api/share/${share.token}/list`);
    expect(list.status).toBe(200);
    const { entries } = (await list.json()) as { entries: { path: string }[] };
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["dir/a.md", "dir/sub/b.md"]);

    const inside = await fetch(
      `${BASE}/api/share/${share.token}/file?path=${encodeURIComponent("dir/sub/b.md")}`,
    );
    expect(inside.status).toBe(200);
    expect(await inside.text()).toBe("inside b");

    // Sibling-prefix and traversal escapes are denied.
    const sibling = await fetch(
      `${BASE}/api/share/${share.token}/file?path=${encodeURIComponent("dir2/secret.md")}`,
    );
    expect(sibling.status).toBe(404);
    const escape = await fetch(
      `${BASE}/api/share/${share.token}/file?path=${encodeURIComponent("../dir2/secret.md")}`,
    );
    expect(escape.status).toBe(404);
  });

  it("folder share: carries the tree's icons and order, scoped to the shared subtree", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "dir/a.md", "a");
    await putFile(ws.id, key, "dir/sub/b.md", "b");
    await putFile(ws.id, key, "dirty/c.md", "c");
    // Node metadata inside the share, plus two decoys: a sibling folder whose
    // name merely starts with the share path, and a file inside it.
    await usePrismaClient().nodeMeta.createMany({
      data: [
        { workspaceId: ws.id, path: "dir", icon: "📗" },
        { workspaceId: ws.id, path: "dir/a.md", icon: "🚀", order: 0 },
        { workspaceId: ws.id, path: "dir/sub", icon: "solar:pen-linear" },
        { workspaceId: ws.id, path: "dirty", icon: "🙈" },
        { workspaceId: ws.id, path: "dirty/c.md", icon: "🙈", order: 3 },
      ],
    });
    const share = await createShare({
      workspaceId: ws.id,
      path: "dir",
      kind: "folder",
      access: "public",
      createdBy: userId,
    });

    const res = await fetch(`${BASE}/api/share/${share.token}/list`);
    expect(res.status).toBe(200);
    const { icons, orders } = (await res.json()) as {
      icons: Record<string, string>;
      orders: Record<string, number>;
    };
    expect(icons).toEqual({ dir: "📗", "dir/a.md": "🚀", "dir/sub": "solar:pen-linear" });
    expect(orders).toEqual({ "dir/a.md": 0 });
  });

  it("folder share: lists an empty sub-folder's .keep so the viewer can show it", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "dir/a.md", "inside a");
    await putFile(ws.id, key, "dir/empty/.keep", "\n");
    await putFile(ws.id, key, "dir/hidden/.keep", "\n");
    await setNodePrivate({
      workspaceId: ws.id,
      path: "dir/hidden",
      kind: "folder",
      ownerId: userId,
    });
    const share = await createShare({
      workspaceId: ws.id,
      path: "dir",
      kind: "folder",
      access: "public",
      createdBy: userId,
    });

    const res = await fetch(`${BASE}/api/share/${share.token}/list`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { path: string }[] };
    // The empty folder exists for the visitor; a private one still does not.
    expect(entries.map((e) => e.path).sort()).toEqual(["dir/a.md", "dir/empty/.keep"]);
  });

  it("meta: serves the workspace theme, and the shared file's entry only once unlocked", async () => {
    const { ws, key, userId } = await setup();
    await usePrismaClient().workspace.update({
      where: { id: ws.id },
      data: { theme: "dracula", icon: "solar:notebook-bold-duotone", color: "wood" },
    });
    await putFile(ws.id, key, "note.md", "hello");
    const share = await createShare({
      workspaceId: ws.id,
      path: "note.md",
      kind: "file",
      access: "public",
      password: "hunter2",
      createdBy: userId,
    });

    // Locked: the theme still comes through (the gate is themed), the file
    // entry does not.
    const locked = (await (await fetch(`${BASE}/api/share/${share.token}/meta`)).json()) as {
      theme: string | null;
      workspace: { id: string | null; name: string; icon: string | null; color: string | null };
      file: unknown;
      unlocked: boolean;
    };
    expect(locked.theme).toBe("dracula");
    // The workspace's identity is branding, served before the gate so a locked
    // link already looks like where it came from. `id` is part of that: an
    // uploaded image icon is fetched from a workspace-scoped URL, so without it
    // a workspace with a logo would brand its own locked page with a blank
    // tile. It is not a credential — every workspace route still checks
    // membership, and the icon route only ever serves the current icon.
    expect(locked.workspace).toEqual({
      id: ws.id,
      name: "Default",
      icon: "solar:notebook-bold-duotone",
      color: "wood",
    });
    expect(locked.unlocked).toBe(false);
    expect(locked.file).toBeNull();

    const ok = await fetch(`${BASE}/api/share/${share.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    const cookie = (ok.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const open = (await (
      await fetch(`${BASE}/api/share/${share.token}/meta`, { headers: { cookie } })
    ).json()) as { file: { path: string; contentType: string; version: number } | null };
    expect(open.file?.path).toBe("note.md");
    expect(open.file?.version).toBe(1);
  });

  it("password gate: blocks content until unlocked, then a token-bound cookie admits reads", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "secret.md", "top secret");
    const share = await createShare({
      workspaceId: ws.id,
      path: "secret.md",
      kind: "file",
      access: "public",
      password: "hunter2",
      createdBy: userId,
    });

    // Locked.
    expect((await fetch(`${BASE}/api/share/${share.token}/file`)).status).toBe(401);
    // Wrong password.
    const wrong = await fetch(`${BASE}/api/share/${share.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrong.status).toBe(401);
    // Correct password → cookie.
    const ok = await fetch(`${BASE}/api/share/${share.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain(`sh_${share.token}`);
    // Unlocked read.
    const read = await fetch(`${BASE}/api/share/${share.token}/file`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("top secret");

    // That cookie must NOT unlock a different password share.
    await putFile(ws.id, key, "secret2.md", "other secret");
    const shareB = await createShare({
      workspaceId: ws.id,
      path: "secret2.md",
      kind: "file",
      access: "public",
      password: "diff",
      createdBy: userId,
    });
    const crossed = await fetch(`${BASE}/api/share/${shareB.token}/file`, { headers: { cookie } });
    expect(crossed.status).toBe(401);
  });

  it("revocation beats a still-valid unlock cookie", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "r.md", "revoke me");
    const share = await createShare({
      workspaceId: ws.id,
      path: "r.md",
      kind: "file",
      access: "public",
      password: "pw",
      createdBy: userId,
    });
    const ok = await fetch(`${BASE}/api/share/${share.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    const cookie = (ok.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    expect(
      (await fetch(`${BASE}/api/share/${share.token}/file`, { headers: { cookie } })).status,
    ).toBe(200);
    await revokeShare(ws.id, share.id);
    expect(
      (await fetch(`${BASE}/api/share/${share.token}/file`, { headers: { cookie } })).status,
    ).toBe(404);
  });

  it("throttles repeated wrong-password attempts", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "t.md", "x");
    const share = await createShare({
      workspaceId: ws.id,
      path: "t.md",
      kind: "file",
      access: "public",
      password: "pw",
      createdBy: userId,
    });
    let sawThrottle = false;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${BASE}/api/share/${share.token}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      if (res.status === 429) {
        sawThrottle = true;
        break;
      }
    }
    expect(sawThrottle).toBe(true);
  });

  it("serves a pinned version even after the file advances", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "pin.md", "old");
    await putFile(ws.id, key, "pin.md", "new", 1);
    const share = await createShare({
      workspaceId: ws.id,
      path: "pin.md",
      kind: "file",
      access: "public",
      pinnedVersion: 1,
      pinnedContentHash: sha256("old"),
      createdBy: userId,
    });
    const res = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("old");
  });

  // A pinned link addresses its bytes by content hash, so it outlives the path.
  // The metadata that lets the viewer pick a renderer has to outlive it too —
  // reading it off the live node would blank the viewer after a delete, and
  // describe the wrong file after a delete-and-recreate.
  it("describes a pinned file from its pinned bytes, not the live node", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "pin.md", "old");
    const share = await createShare({
      workspaceId: ws.id,
      path: "pin.md",
      kind: "file",
      access: "public",
      pinnedVersion: 1,
      pinnedContentHash: sha256("old"),
      createdBy: userId,
    });
    const metaOf = async () =>
      (await (await fetch(`${BASE}/api/share/${share.token}/meta`)).json()) as {
        file: { path: string; contentType: string; size: number; version: number } | null;
      };

    expect((await metaOf()).file).toMatchObject({ path: "pin.md", size: 3, version: 1 });

    // Delete the path: the link still serves the pinned bytes, so it must still
    // describe them.
    const del = await fetch(`${BASE}/api/workspaces/${ws.id}/files/pin.md`, {
      method: "DELETE",
      headers: { "x-api-key": key, "if-match": '"1"' },
    });
    expect(del.ok).toBe(true);
    expect((await fetch(`${BASE}/api/share/${share.token}/file`)).status).toBe(200);
    const afterDelete = await metaOf();
    expect(afterDelete.file).not.toBeNull();
    expect(afterDelete.file?.path).toBe("pin.md");
    expect(afterDelete.file?.version).toBe(1);

    // Recreate the path with different bytes and a different type: the pinned
    // link still serves the ORIGINAL, so it must not borrow the replacement's
    // size or content type.
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/pin.md`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/html", "if-none-match": "*" },
      body: "<h1>a totally different file</h1>",
    });
    const afterRecreate = await metaOf();
    expect(afterRecreate.file?.version).toBe(1);
    expect(afterRecreate.file?.size).not.toBe("<h1>a totally different file</h1>".length);
    expect(afterRecreate.file?.contentType).not.toBe("text/html");
  });

  it("serves an HTML file as a non-executable download (nosniff + attachment)", async () => {
    const { ws, key, userId } = await setup();
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/page.html`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/html", "if-none-match": "*" },
      body: "<script>alert(1)</script>",
    });
    const share = await createShare({
      workspaceId: ws.id,
      path: "page.html",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const res = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("plays audio and video inline, under their real type, and downloads on request", async () => {
    const { ws, key, userId } = await setup();
    const put = (path: string, type: string) =>
      fetch(`${BASE}/api/workspaces/${ws.id}/files/${path}`, {
        method: "PUT",
        headers: { "x-api-key": key, "content-type": type, "if-none-match": "*" },
        body: "0123456789",
      });
    await put("media/talk.mp3", "audio/mpeg");
    // Synced before the file-type table knew .webm: stored as bytes.
    await put("media/clip.webm", "application/octet-stream");
    const share = await createShare({
      workspaceId: ws.id,
      path: "media",
      kind: "folder",
      access: "public",
      createdBy: userId,
    });
    const file = (path: string) => `${BASE}/api/share/${share.token}/file?path=${path}`;

    const audio = await fetch(file("media/talk.mp3"));
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(audio.headers.get("content-disposition")).toBe("inline");
    expect(audio.headers.get("x-content-type-options")).toBe("nosniff");
    await audio.arrayBuffer();

    // nosniff means the type is all a browser goes on, so it has to be right.
    const video = await fetch(file("media/clip.webm"), { headers: { range: "bytes=4-" } });
    expect(video.status).toBe(206);
    expect(video.headers.get("content-type")).toBe("video/webm");
    expect(video.headers.get("content-disposition")).toBe("inline");
    expect(await video.text()).toBe("456789");

    const dl = await fetch(`${file("media/clip.webm")}&download=1`);
    expect(dl.headers.get("content-disposition")).toContain('attachment; filename="clip.webm"');
    await dl.arrayBuffer();
  });

  it("rejects write verbs and unknown tokens", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "ro.md", "read only");
    const share = await createShare({
      workspaceId: ws.id,
      path: "ro.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const put = await fetch(`${BASE}/api/share/${share.token}/file`, {
      method: "PUT",
      body: "hack",
    });
    expect(put.ok).toBe(false); // no write handler exists on the public route
    expect((await fetch(`${BASE}/api/share/not-a-real-token/file`)).status).toBe(404);
  });
});
describe.skipIf(!serverUp)("public share conditional requests (HTTP)", () => {
  it("returns 304 for a matching validator, with no body", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "cached.md", "cached bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "cached.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });

    const first = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "if-none-match": etag as string },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("caches as private, never public", async () => {
    // Asserted explicitly so a future change to `public` fails here rather than
    // silently letting a shared cache serve a revoked link until its TTL.
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "cc.md", "bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "cc.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const res = await fetch(`${BASE}/api/share/${share.token}/file`);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("private");
    expect(cc).not.toContain("public");
    expect(cc).toContain("must-revalidate");
  });

  it("serves 200 with fresh bytes when the file changed since the validator", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "moving.md", "v1 bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "moving.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const first = await fetch(`${BASE}/api/share/${share.token}/file`);
    const stale = first.headers.get("etag") as string;

    await putFile(ws.id, key, "moving.md", "v2 bytes", 1);

    const second = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "if-none-match": stale },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("v2 bytes");
  });

  it("REVOCATION BEATS THE VALIDATOR: a revoked share 404s even with a matching ETag", async () => {
    // The whole reason the conditional check sits below share re-resolution. If
    // the 304 short-circuit ran first, a revoked link would keep answering to
    // anyone holding a validator.
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "revoked.md", "secret bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "revoked.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const first = await fetch(`${BASE}/api/share/${share.token}/file`);
    const etag = first.headers.get("etag") as string;
    expect(first.status).toBe(200);

    await revokeShare(ws.id, share.id);

    const after = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "if-none-match": etag },
    });
    expect(after.status).toBe(404);
    expect(await after.text()).not.toContain("secret bytes");
  });

  it("a pinned permalink keeps a stable validator across later edits", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "pin.md", "pinned v1");
    const share = await createShare({
      workspaceId: ws.id,
      path: "pin.md",
      kind: "file",
      access: "public",
      createdBy: userId,
      pinnedVersion: 1,
      // The util takes the pointer explicitly; only the HTTP route derives it
      // from (path, version).
      pinnedContentHash: sha256("pinned v1"),
    });
    const first = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("pinned v1");
    const etag = first.headers.get("etag") as string;

    await putFile(ws.id, key, "pin.md", "edited v2", 1);

    const second = await fetch(`${BASE}/api/share/${share.token}/file`, {
      headers: { "if-none-match": etag },
    });
    // The pinned bytes did not change, so the validator still matches.
    expect(second.status).toBe(304);
  });

  it("keeps the hardening headers on a 200 response", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "hard.md", "bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "hard.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const res = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-disposition")).toBeTruthy();
  });
});

describe.skipIf(!serverUp)("conditional requests respect the password gate", () => {
  it("a locked share does not answer a conditional request", async () => {
    // Ordering risk: if the 304 short-circuit ran above assertUnlocked, someone
    // without the password could probe a locked share's validator and learn
    // when its contents changed.
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "locked.md", "locked bytes");
    const share = await createShare({
      workspaceId: ws.id,
      path: "locked.md",
      kind: "file",
      access: "public",
      createdBy: userId,
      password: "hunter2hunter2",
    });

    const cold = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(cold.status).toBe(401);

    // Even guessing the validator format must not produce a 304.
    for (const guess of ['"v-1"', '"v-2"', 'W/"v-1"']) {
      const probe = await fetch(`${BASE}/api/share/${share.token}/file`, {
        headers: { "if-none-match": guess },
      });
      expect(probe.status).toBe(401);
    }
  });
});
describe.skipIf(!serverUp)("password-gated shares are never cached", () => {
  it("an UNLOCKED password share sends no-store and no validator", async () => {
    // `must-revalidate` still permits the browser to write the body to disk, so
    // deliberately secret content would survive on a shared machine. Give up the
    // 304 saving for these and store nothing.
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "secret.md", "behind a password");
    const share = await createShare({
      workspaceId: ws.id,
      path: "secret.md",
      kind: "file",
      access: "public",
      createdBy: userId,
      password: "hunter2hunter2",
    });

    const unlock = await fetch(`${BASE}/api/share/${share.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2hunter2" }),
    });
    expect(unlock.status).toBe(200);
    const cookie = (unlock.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

    const res = await fetch(`${BASE}/api/share/${share.token}/file`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("behind a password");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });

  it("a share WITHOUT a password still gets the validator and private caching", async () => {
    const { ws, key, userId } = await setup();
    await putFile(ws.id, key, "open2.md", "no password here");
    const share = await createShare({
      workspaceId: ws.id,
      path: "open2.md",
      kind: "file",
      access: "public",
      createdBy: userId,
    });
    const res = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("cache-control")).toContain("private");
  });
});