import { describe, expect, it } from "vite-plus/test";
import { serverAvailable } from "./env";

// Route-level integration test against a RUNNING api dev server. Exercises the
// share-management routes incl. the KTD4 cookie-vs-key matrix (public/password
// links require a cookie session, never an API key) and the fail-closed refusal
// to let a folder link run scripts.
//
// Server-gated, which means a plain `vp test` SKIPS all of it — and a skip reads
// exactly like a pass. These boundaries only exist over HTTP, so prove them with
// `pnpm --filter api run test:server`, which refuses to run without an API
// rather than reporting green (scripts/test-server-backed.mjs).

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
// Under REQUIRE_SERVER=1 this THROWS instead of returning false, so a suite that
// exists to prove an authorization boundary fails rather than skipping to green
// — including when the server disappears for only part of a run. It also carries
// a deadline, so a peer that connects and then says nothing cannot hang the gate.
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

const PASSWORD = "correct-horse-battery";

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const email = `sh${stamp}@example.test`;
  const { user } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "SH" } });
  const org = await db.organization.create({ data: { id: `org_sh_${stamp}`, name: "SH Org" } });
  await db.member.create({
    data: {
      id: `mem_sh_${stamp}`,
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
      name: "sh-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, email, key: key.key };
}

// better-auth rejects sign-in POSTs whose Origin isn't trusted; send the app
// origin (override via SMOKE_APP_ORIGIN to match the server's APP_URL).
const APP_ORIGIN = process.env.SMOKE_APP_ORIGIN ?? "http://localhost:3000";

async function cookieFor(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

describe.skipIf(!serverUp)("share routes (HTTP)", () => {
  it("member link creates via API key; public/password rejected via key (KTD4)", async () => {
    const { ws, key } = await setup();
    const h = { "x-api-key": key, "content-type": "application/json" };

    const member = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ path: "doc.md", kind: "file", access: "member" }),
    });
    expect(member.status).toBe(201);

    const pub = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ path: "doc.md", kind: "file", access: "public" }),
    });
    expect(pub.status).toBe(403);

    const pw = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ path: "doc.md", kind: "file", access: "member", password: "x" }),
    });
    expect(pw.status).toBe(403);
  });

  it("creates a public link via cookie session, lists it without passwordHash, and revokes it", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);

    const created = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "dir", kind: "folder", access: "public", password: "secret" }),
    });
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as {
      share: { id: string; token: string; hasPassword: boolean };
    };
    expect(share.token).toBeTruthy();
    expect(share.hasPassword).toBe(true);
    expect(share).not.toHaveProperty("passwordHash");

    // List (via key) — present, no passwordHash leaked.
    const list = await fetch(
      `${BASE}/api/workspaces/${ws.id}/shares?path=${encodeURIComponent("dir")}`,
      { headers: { "x-api-key": key } },
    );
    const { shares } = (await list.json()) as { shares: { id: string }[] };
    expect(shares.some((s) => s.id === share.id)).toBe(true);
    expect(JSON.stringify(shares)).not.toContain("passwordHash");

    // Revoke (via key) — gone from the list.
    const del = await fetch(`${BASE}/api/workspaces/${ws.id}/shares/${share.id}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    expect(del.status).toBe(200);
    const list2 = await fetch(
      `${BASE}/api/workspaces/${ws.id}/shares?path=${encodeURIComponent("dir")}`,
      { headers: { "x-api-key": key } },
    );
    const { shares: after } = (await list2.json()) as { shares: { id: string }[] };
    expect(after.some((s) => s.id === share.id)).toBe(false);
  });

  it("derives the pinned content hash server-side, and refuses one that disagrees", async () => {
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    const fh = { "x-api-key": key, "content-type": "text/markdown" };
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/pin.md`, {
      method: "PUT",
      headers: { ...fh, "if-none-match": "*" },
      body: "old",
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/pin.md`, {
      method: "PUT",
      headers: { ...fh, "if-match": '"1"' },
      body: "new",
    });

    // A client hash is a PRECONDITION, never a value: it says "these are the
    // bytes I was looking at". One that does not match what the server derives
    // is refused rather than quietly ignored — silently pinning something else
    // is how a link ends up serving (and, with scripts, executing) content
    // nobody reviewed.
    const bogus = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "pin.md",
        kind: "file",
        access: "public",
        pinnedVersion: 1,
        pinnedContentHash: "deadbeefdeadbeef",
      }),
    });
    expect(bogus.status).toBe(409);

    // Without one, the server still derives v1's real hash itself.
    const created = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "pin.md", kind: "file", access: "public", pinnedVersion: 1 }),
    });
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as { share: { token: string; pinnedVersion: number } };
    expect(share.pinnedVersion).toBe(1);

    const served = await fetch(`${BASE}/api/share/${share.token}/file`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("old"); // v1 bytes, not the bogus hash
  });

  it("only lets a cookie session mint a link that runs scripts (KTD4)", async () => {
    // Letting a link execute is as sensitive as opening one: a leaked agent or
    // CLI key must not be able to turn a quiet public link into one that runs
    // code in a visitor's browser.
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);

    const viaKey = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        path: "deck.html",
        kind: "file",
        access: "member",
        allowScripts: true,
      }),
    });
    expect(viaKey.status).toBe(403);

    const created = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "deck.html",
        kind: "file",
        access: "public",
        allowScripts: true,
      }),
    });
    expect(created.status).toBe(201);
    const { share } = (await created.json()) as {
      share: { id: string; token: string; allowScripts: boolean };
    };
    expect(share.allowScripts).toBe(true);

    // The visitor's viewer reads the setting off the public metadata.
    const meta = await fetch(`${BASE}/api/share/${share.token}/meta`);
    expect(((await meta.json()) as { allowScripts: boolean }).allowScripts).toBe(true);
  });

  it("defaults to inert, and toggles on an existing link without changing its URL", async () => {
    // The reason this route exists: the link is usually already with the person
    // reporting that the page does not respond.
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);

    const created = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "deck.html", kind: "file", access: "public" }),
    });
    const { share } = (await created.json()) as {
      share: { id: string; token: string; allowScripts: boolean };
    };
    expect(share.allowScripts).toBe(false);

    const viaKey = await fetch(`${BASE}/api/workspaces/${ws.id}/shares/${share.id}`, {
      method: "PATCH",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ allowScripts: true }),
    });
    expect(viaKey.status).toBe(403);

    const patched = await fetch(`${BASE}/api/workspaces/${ws.id}/shares/${share.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ allowScripts: true }),
    });
    expect(patched.status).toBe(200);
    const updated = (await patched.json()) as { share: { token: string; allowScripts: boolean } };
    expect(updated.share.allowScripts).toBe(true);
    expect(updated.share.token).toBe(share.token); // same link, new capability

    // And back off again — this one may travel by key, since it only takes away.
    const off = await fetch(`${BASE}/api/workspaces/${ws.id}/shares/${share.id}`, {
      method: "PATCH",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ allowScripts: false }),
    });
    expect(off.status).toBe(200);
    const meta = await fetch(`${BASE}/api/share/${share.token}/meta`);
    expect(((await meta.json()) as { allowScripts: boolean }).allowScripts).toBe(false);
  });

  it("refuses to let a folder link run scripts, on create and on patch", async () => {
    // Fail closed, not merely hidden in the UI. A folder share is the one case
    // where the viewer rewrites sibling references, and those URLs carry this
    // link's own token — so a folder page that could execute could read the
    // token out of its own DOM and hand a stranger the whole shared subtree.
    const { ws, email } = await setup();
    const cookie = await cookieFor(email);
    const h = { cookie, "content-type": "application/json" };

    const atCreate = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ path: "dir", kind: "folder", access: "public", allowScripts: true }),
    });
    expect(atCreate.status).toBe(400);

    const created = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ path: "dir", kind: "folder", access: "public" }),
    });
    const { share } = (await created.json()) as { share: { id: string } };

    const atPatch = await fetch(`${BASE}/api/workspaces/${ws.id}/shares/${share.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ allowScripts: true }),
    });
    expect(atPatch.status).toBe(400);
  });

  it("rejects a non-boolean allowScripts instead of silently storing false", async () => {
    // `body` is a TypeScript shape over untyped JSON: "true" used to be truthy
    // enough to count as sensitive, yet stored as false.
    const { ws, email } = await setup();
    const cookie = await cookieFor(email);
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "deck.html",
        kind: "file",
        access: "public",
        allowScripts: "true",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("will not create an executable pinned link without naming its content", async () => {
    // A version is not an identity — delete-and-recreate reuses it — so "pin
    // version 1 and run it" could execute bytes the caller never reviewed.
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/pinme.html`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/html", "if-none-match": "*" },
      body: "<h1>hi</h1><script>go()</script>",
    });
    const incomplete = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "pinme.html",
        kind: "file",
        access: "public",
        allowScripts: true,
        pinnedVersion: 1,
      }),
    });
    expect(incomplete.status).toBe(400);
  });

  it("refuses a pin whose hash does not match the version it names", async () => {
    // The delete-and-recreate case, which is why the identity is a hash and not
    // a version: the viewer caches a body under path + version forever, and a
    // recreated file reuses version 1 — so a member can be looking at the
    // ORIGINAL while the path now holds a replacement. Pinning "version 1" here
    // must refuse rather than silently pin (and publicly execute) the bytes
    // nobody reviewed.
    const { ws, email, key } = await setup();
    const cookie = await cookieFor(email);
    const fh = { "x-api-key": key, "content-type": "text/html" };

    await fetch(`${BASE}/api/workspaces/${ws.id}/files/reused.html`, {
      method: "PUT",
      headers: { ...fh, "if-none-match": "*" },
      body: "<h1>the one that was reviewed</h1>",
    });
    // The identity the viewer would have been holding for that render.
    const first = await fetch(`${BASE}/api/workspaces/${ws.id}/files/reused.html`, {
      headers: { "x-api-key": key },
    });
    const reviewedHash = first.headers.get("x-treehouse-content-hash");
    expect(reviewedHash).toBeTruthy();

    // Deleted and recreated: version 1 again, different bytes.
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/reused.html`, {
      method: "DELETE",
      headers: { "x-api-key": key, "if-match": '"1"' },
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/reused.html`, {
      method: "PUT",
      headers: { ...fh, "if-none-match": "*" },
      body: "<h1>a replacement</h1><script>evil()</script>",
    });
    const again = await fetch(`${BASE}/api/workspaces/${ws.id}/files/reused.html`, {
      headers: { "x-api-key": key },
    });
    expect(again.headers.get("x-treehouse-version")).toBe("1"); // the reuse
    expect(again.headers.get("x-treehouse-content-hash")).not.toBe(reviewedHash);

    // Creating a pinned link against the reviewed identity is refused...
    const created = await fetch(`${BASE}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "reused.html",
        kind: "file",
        access: "public",
        pinnedVersion: 1,
        pinnedContentHash: reviewedHash,
      }),
    });
    expect(created.status).toBe(409);
  });

  it("serves the identity of the bytes it returns, so a caller can name them", async () => {
    const { ws, key } = await setup();
    await fetch(`${BASE}/api/workspaces/${ws.id}/files/ident.html`, {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/html", "if-none-match": "*" },
      body: "<h1>hi</h1>",
    });
    const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/ident.html`, {
      headers: { "x-api-key": key },
    });
    expect(res.headers.get("x-treehouse-content-hash")).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("will not flip a flag on another workspace's link", async () => {
    const a = await setup();
    const b = await setup();
    const cookieA = await cookieFor(a.email);
    const created = await fetch(`${BASE}/api/workspaces/${a.ws.id}/shares`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ path: "deck.html", kind: "file", access: "public" }),
    });
    const { share } = (await created.json()) as { share: { id: string } };

    const cookieB = await cookieFor(b.email);
    const crossed = await fetch(`${BASE}/api/workspaces/${b.ws.id}/shares/${share.id}`, {
      method: "PATCH",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({ allowScripts: true }),
    });
    expect(crossed.status).toBe(404);
  });

  it("enforces auth + workspace scoping", async () => {
    const { ws } = await setup();
    const noauth = await fetch(`${BASE}/api/workspaces/${ws.id}/shares?path=doc.md`);
    expect(noauth.status).toBe(401);
  });
});