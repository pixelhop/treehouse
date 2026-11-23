import { uploadedIconHash } from "shared";
import { describe, expect, it } from "vite-plus/test";
import { serverAvailable, SMOKE_BASE } from "./env";

// Route-level integration test for the workspace icon endpoints against a
// RUNNING api dev server (same gating as files-routes.test.ts — start one with
// `pnpm --filter api dev`, setting SMOKE_BASE to its port).
//
// What only an HTTP test can show: the upload's mid-stream size abort actually
// reaching the client as a 413, the GET serving bytes with NO credentials (the
// invite preview depends on that), and a hash the workspace no longer wears
// being a 404 rather than someone else's icon.

const BASE = SMOKE_BASE;
// Shared gate: under REQUIRE_SERVER=1 it THROWS rather than returning false, so
// this suite — which exists partly to prove the upload's auth boundary — fails
// instead of skipping to a green that proved nothing.
const serverUp = await serverAvailable(BASE);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { MAX_ICON_BYTES } = await import("../server/utils/workspaceIcon");
const db = usePrismaClient();

// A real 1x1 PNG: valid enough to pass magic-byte sniffing.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `ic${stamp}@example.test`, password: "correct-horse-battery", name: "IC" },
  });
  const org = await db.organization.create({ data: { id: `org_ic_${stamp}`, name: "IC Org" } });
  await db.member.create({
    data: {
      id: `mem_ic_${stamp}`,
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
      name: "ic-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  return { ws, key: key.key };
}

// The bytes URL is keyed by the icon's hash, not by the `upload:<hash>` value —
// parsed with the same helper the app uses rather than by slicing a prefix
// length the test would have to keep in step by hand.
function iconUrl(workspaceId: string, icon: string): string {
  return `${BASE}/api/workspaces/${workspaceId}/icon/${uploadedIconHash(icon)}`;
}

function upload(workspaceId: string, key: string, body: BodyInit, contentType = "image/png") {
  return fetch(`${BASE}/api/workspaces/${workspaceId}/icon`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": contentType },
    body,
  });
}

describe.skipIf(!serverUp)("workspace icon routes", () => {
  it("uploads an image and serves it back without credentials", async () => {
    const { ws, key } = await setup();

    const res = await upload(ws.id, key, PNG_1x1);
    expect(res.status).toBe(200);
    const { icon } = (await res.json()) as { icon: string };
    expect(icon.startsWith("upload:")).toBe(true);

    // No api key, no cookie — this is what an <img> sends cross-origin, and what
    // an invited non-member's browser sends on the invite preview.
    const bytes = await fetch(iconUrl(ws.id, icon));
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(bytes.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await bytes.arrayBuffer()).equals(PNG_1x1)).toBe(true);
  });

  it("stops serving an icon the workspace no longer wears", async () => {
    const { ws, key } = await setup();
    const { icon } = (await (await upload(ws.id, key, PNG_1x1)).json()) as { icon: string };
    const url = iconUrl(ws.id, icon);
    expect((await fetch(url)).status).toBe(200);

    await db.workspace.update({ where: { id: ws.id }, data: { icon: "🌳" } });
    expect((await fetch(url)).status).toBe(404);
  });

  it("rejects a non-image, an unauthenticated upload, and a foreign workspace", async () => {
    const { ws, key } = await setup();
    const other = await setup();

    const svg = await upload(ws.id, key, "<svg onload=alert(1)>", "image/svg+xml");
    expect(svg.status).toBe(400);

    const anon = await fetch(`${BASE}/api/workspaces/${ws.id}/icon`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG_1x1,
    });
    expect(anon.status).toBe(401);

    // A workspace-scoped key is locked to its own workspace.
    const foreign = await upload(other.ws.id, key, PNG_1x1);
    expect(foreign.status).toBe(403);
  });

  it("refuses an invented upload: pointer on PATCH but allows echoing the current one", async () => {
    const { ws, key } = await setup();
    const { icon } = (await (await upload(ws.id, key, PNG_1x1)).json()) as { icon: string };

    const patch = (body: unknown) =>
      fetch(`${BASE}/api/workspaces/${ws.id}`, {
        method: "PATCH",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Echoing the current icon while renaming is what the edit dialog does.
    expect((await patch({ name: "Renamed", icon })).status).toBe(200);
    // Pointing at bytes this workspace never uploaded is not.
    const invented = await patch({ icon: `upload:${"b".repeat(64)}` });
    expect(invented.status).toBe(400);

    // Switching to an emoji frees the blob AND the old URL dies with it.
    expect((await patch({ icon: "🌳" })).status).toBe(200);
    expect((await fetch(iconUrl(ws.id, icon))).status).toBe(404);
  });
  // Last on purpose. Answering mid-upload means the rest of the body is never
  // read, so the connection can't be reused (the route says so with
  // `Connection: close`) — and a pooling client that already queued its next
  // request on that socket sees the reset, not the 413. Keeping this case at the
  // end means that artefact of the CLIENT can't be mistaken for a server bug in
  // the tests above.
  it("refuses an oversized image by declared length AND mid-stream", async () => {
    const { ws, key } = await setup();

    // Declared: a fixed-size body gives undici a Content-Length, so the route
    // rejects before reading a byte.
    const declared = await upload(ws.id, key, new Uint8Array(MAX_ICON_BYTES + 1).fill(97));
    expect(declared.status).toBe(413);

    // Undeclared: a stream body is sent chunked, so only the mid-stream counter
    // can catch it — and the 413 still has to reach the client rather than the
    // connection dying under it.
    const half = Math.ceil(MAX_ICON_BYTES / 2) + 1;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(half).fill(97));
        controller.enqueue(new Uint8Array(half).fill(97));
        controller.close();
      },
    });
    const streamed = await fetch(`${BASE}/api/workspaces/${ws.id}/icon`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "image/png" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(streamed.status).toBe(413);

    // Neither attempt left the workspace pointing at anything.
    const after = await db.workspace.findUnique({ where: { id: ws.id } });
    expect(after?.icon).toBeNull();
  });
});