import { describe, expect, it } from "vite-plus/test";
import "./env";

// Per-file read state (U7): the return recap and the track-changes base.
// Route-level integration against a RUNNING api dev server, like
// comments-routes.test.ts — real HTTP, real Postgres, real anchor resolution.
// Gated on the server being reachable so `vp test` stays green without one.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

/** A cookie session plus a workspace and an agent key scoped to it. */
async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const res = await auth.api.signUpEmail({
    body: { email: `fr${stamp}@example.test`, password: "correct-horse-battery", name: "FR" },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const userId = ((await res.json()) as { user?: { id?: string } }).user?.id;
  if (!cookie || !userId) throw new Error(`sign-up failed (${res.status})`);
  const org = await db.organization.create({ data: { id: `org_fr_${stamp}`, name: "FR Org" } });
  await db.member.create({
    data: {
      id: `mem_fr_${stamp}`,
      organizationId: org.id,
      userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: { userId, name: "fr-agent", metadata: { workspaceId: ws.id, actorType: "agent" } },
  });
  return { ws, cookie, userId, key: key.key, orgId: org.id };
}

type Auth = { "x-api-key": string } | { cookie: string };

const putFile = (wsId: string, a: Auth, path: string, body: string, ifMatch?: number) =>
  fetch(
    `${BASE}/api/workspaces/${wsId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      headers: {
        ...a,
        "content-type": "text/markdown",
        ...(ifMatch === undefined ? { "if-none-match": "*" } : { "if-match": `"${ifMatch}"` }),
      },
      body,
    },
  );

const deleteFile = (wsId: string, a: Auth, path: string, version: number) =>
  fetch(
    `${BASE}/api/workspaces/${wsId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "DELETE", headers: { ...a, "if-match": `"${version}"` } },
  );

interface ReadStateBody {
  path: string;
  firstVisit: boolean;
  staleBase: boolean;
  changed: boolean;
  lastSeenVersion: number | null;
  currentVersion: number | null;
  base: { version: number; text: string } | null;
  recap: {
    versions: number;
    newThreads: number;
    replies: number;
    resolved: number;
    reopened: number;
    newlyOutdated: number;
    actors: { principal: string; actorLabel: string | null }[];
    since: string | null;
  } | null;
}

const getState = async (wsId: string, a: Auth, path: string) => {
  const res = await fetch(
    `${BASE}/api/workspaces/${wsId}/file-read-state?path=${encodeURIComponent(path)}`,
    { headers: { ...a } },
  );
  return { status: res.status, body: (await res.json()) as ReadStateBody };
};

const putState = (wsId: string, a: Auth, path: string, version?: number) =>
  fetch(`${BASE}/api/workspaces/${wsId}/file-read-state`, {
    method: "PUT",
    headers: { ...a, "content-type": "application/json" },
    body: JSON.stringify(version === undefined ? { path } : { path, version }),
  });

const createComment = (wsId: string, a: Auth, payload: object) =>
  fetch(`${BASE}/api/workspaces/${wsId}/comments`, {
    method: "POST",
    headers: { ...a, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

const V11 = "# Launch\n\nThe launch is on September 12th.\n\nWe will announce it on the blog.\n";
const V12 = "# Launch\n\nThe launch is on October 3rd.\n\nWe will announce it on the blog.\n";

describe.skipIf(!serverUp)("file read state routes (HTTP)", () => {
  it("shows no recap on a first-ever visit, and seeds only when asked", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);

    const first = await getState(ws.id, a, "doc.md");
    expect(first.status).toBe(200);
    expect(first.body.firstVisit).toBe(true);
    expect(first.body.recap).toBeNull();
    // The GET must never write — a refresh before dismissal still reads as new.
    expect((await getState(ws.id, a, "doc.md")).body.firstVisit).toBe(true);

    expect((await putState(ws.id, a, "doc.md")).status).toBe(200);
    const seeded = await getState(ws.id, a, "doc.md");
    expect(seeded.body.firstVisit).toBe(false);
    expect(seeded.body.changed).toBe(false);
    expect(seeded.body.lastSeenVersion).toBe(1);
  });

  // The banner case: the file changed under an open reader who never reloaded.
  // Recording "latest" on the way out swallowed the recap for exactly the
  // version they never saw.
  it("records the version the reader had on screen, not the one that landed while they were there", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11); // v1 — what they opened and read
    await putFile(ws.id, a, "doc.md", V12, 1); // v2 — arrives while they are on v1

    // They navigate away without reloading: the client states v1.
    const put = (await (await putState(ws.id, a, "doc.md", 1)).json()) as {
      lastSeenVersion: number;
    };
    expect(put.lastSeenVersion).toBe(1);

    // Coming back, v2 is genuinely new to them.
    const back = await getState(ws.id, a, "doc.md");
    expect(back.body.changed).toBe(true);
    expect(back.body.lastSeenVersion).toBe(1);
    expect(back.body.currentVersion).toBe(2);
    expect(back.body.recap?.versions).toBe(1);
    // …and the diff base is the bytes they actually read, not v2's.
    expect(back.body.base?.version).toBe(1);
    expect(back.body.base?.text).toBe(V11);
  });

  it("records the newer version once the reader reloads past the banner", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);
    await putFile(ws.id, a, "doc.md", V12, 1);

    // They hit Reload, so v2 is what was on screen when they left.
    await putState(ws.id, a, "doc.md", 2);
    const back = await getState(ws.id, a, "doc.md");
    expect(back.body.changed).toBe(false);
    expect(back.body.lastSeenVersion).toBe(2);
  });

  it("falls back to current for a version this path never had", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);
    // A client claiming the future gets the honest answer, not an invented one.
    const put = (await (await putState(ws.id, a, "doc.md", 99)).json()) as {
      lastSeenVersion: number;
    };
    expect(put.lastSeenVersion).toBe(1);
    expect((await getState(ws.id, a, "doc.md")).body.changed).toBe(false);
  });

  it("recaps the delta and hands back the last-seen bytes as the diff base", async () => {
    const { ws, cookie, key } = await setup();
    const me = { cookie };
    const agent = { "x-api-key": key };
    await putFile(ws.id, me, "doc.md", V11);

    const thread = (await (
      await createComment(ws.id, me, {
        path: "doc.md",
        body: "Is this date right?",
        kind: "range",
        quote: "September 12th",
      })
    ).json()) as { thread: { id: string } };
    await putState(ws.id, me, "doc.md");

    // The agent's pass: a rewrite, a reply, and a resolution.
    await putFile(ws.id, agent, "doc.md", V12, 1);
    await fetch(`${BASE}/api/workspaces/${ws.id}/comments/${thread.thread.id}/replies`, {
      method: "POST",
      headers: { ...agent, "content-type": "application/json" },
      body: JSON.stringify({ body: "Fixed — it moved to October." }),
    });
    await fetch(`${BASE}/api/workspaces/${ws.id}/comments/${thread.thread.id}/resolved`, {
      method: "PUT",
      headers: { ...agent, "content-type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });

    const state = await getState(ws.id, me, "doc.md");
    expect(state.body.firstVisit).toBe(false);
    expect(state.body.changed).toBe(true);
    expect(state.body.lastSeenVersion).toBe(1);
    expect(state.body.currentVersion).toBe(2);
    // Base is located by the STORED hash, so it is exactly what they last saw.
    expect(state.body.base?.text).toBe(V11);
    expect(state.body.recap?.versions).toBe(1);
    expect(state.body.recap?.replies).toBe(1);
    expect(state.body.recap?.resolved).toBe(1);
    expect(state.body.recap?.actors.some((x) => x.principal === "agent")).toBe(true);

    // A refresh must not discard a pending recap.
    expect((await getState(ws.id, me, "doc.md")).body.recap?.replies).toBe(1);
  });

  it("counts a thread the rewrite unanchored as newly outdated", async () => {
    const { ws, cookie, key } = await setup();
    const me = { cookie };
    await putFile(ws.id, me, "doc.md", V11);
    await createComment(ws.id, me, {
      path: "doc.md",
      body: "check this",
      kind: "range",
      quote: "September 12th",
    });
    await putState(ws.id, me, "doc.md");
    await putFile(ws.id, { "x-api-key": key }, "doc.md", V12, 1);

    const state = await getState(ws.id, me, "doc.md");
    expect(state.body.recap?.newlyOutdated).toBe(1);
  });

  it("reads a revert back to the same bytes as no change, whatever the version", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);
    await putState(ws.id, a, "doc.md");
    await putFile(ws.id, a, "doc.md", V12, 1);
    await putFile(ws.id, a, "doc.md", V11, 2); // same bytes, v3

    const state = await getState(ws.id, a, "doc.md");
    expect(state.body.currentVersion).toBe(3);
    expect(state.body.lastSeenVersion).toBe(1);
    expect(state.body.changed).toBe(false); // hashes match — nothing to show
    expect(state.body.base).toBeNull();
  });

  it("degrades to a first visit when the path was recreated as a different file", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);
    await putState(ws.id, a, "doc.md");

    await deleteFile(ws.id, a, "doc.md", 1);
    await putFile(ws.id, a, "doc.md", "# Something else entirely\n\nUnrelated words.\n");

    const state = await getState(ws.id, a, "doc.md");
    expect(state.body.staleBase).toBe(true);
    expect(state.body.firstVisit).toBe(true);
    expect(state.body.base).toBeNull(); // never diff a stranger's document
    expect(state.body.recap).toBeNull();
  });

  it("degrades the same way after a move away and a recreate at the old path", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);
    await putState(ws.id, a, "doc.md");

    await fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
      method: "POST",
      headers: { ...a, "content-type": "application/json" },
      body: JSON.stringify({ from: "doc.md", to: "moved.md" }),
    });
    await putFile(ws.id, a, "doc.md", "# A new doc\n\nWith new words.\n");

    const state = await getState(ws.id, a, "doc.md");
    expect(state.body.staleBase).toBe(true);
    expect(state.body.base).toBeNull();
  });

  it("advances monotonically on seq, and never blocks on a reset version number", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    await putFile(ws.id, a, "doc.md", V11);
    await putFile(ws.id, a, "doc.md", V12, 1);
    await putFile(ws.id, a, "doc.md", V11, 2);
    const high = (await (await putState(ws.id, a, "doc.md")).json()) as {
      lastSeenSeq: number;
      lastSeenVersion: number;
    };
    expect(high.lastSeenVersion).toBe(3);

    // A second write with nothing new in between never lowers the watermark.
    const again = (await (await putState(ws.id, a, "doc.md")).json()) as { lastSeenSeq: number };
    expect(again.lastSeenSeq).toBe(high.lastSeenSeq);

    // Delete + recreate resets the version to 1. Version is NOT monotonic: the
    // row must follow it down, or the recap would be wedged on this file.
    await deleteFile(ws.id, a, "doc.md", 3);
    await putFile(ws.id, a, "doc.md", "# Fresh\n\nBrand new.\n");
    const reset = (await (await putState(ws.id, a, "doc.md")).json()) as {
      lastSeenSeq: number;
      lastSeenVersion: number;
    };
    expect(reset.lastSeenVersion).toBe(1);
    expect(reset.lastSeenSeq).toBeGreaterThan(high.lastSeenSeq);
  });

  it("rejects API-key auth on both verbs (agents get no read state)", async () => {
    const { ws, cookie, key } = await setup();
    await putFile(ws.id, { cookie }, "doc.md", V11);
    const a = { "x-api-key": key };
    expect((await putState(ws.id, a, "doc.md")).status).toBe(403);
    expect((await getState(ws.id, a, "doc.md")).status).toBe(403);
  });

  it("404s a path that isn't there, and 400s a missing path", async () => {
    const { ws, cookie } = await setup();
    const a = { cookie };
    expect((await putState(ws.id, a, "nope.md")).status).toBe(404);
    const bad = await fetch(`${BASE}/api/workspaces/${ws.id}/file-read-state`, { headers: a });
    expect(bad.status).toBe(400);
  });

  it("rejects a non-member of the workspace", async () => {
    const owner = await setup();
    const other = await setup();
    await putFile(owner.ws.id, { cookie: owner.cookie }, "doc.md", V11);
    const res = await getState(owner.ws.id, { cookie: other.cookie }, "doc.md");
    expect(res.status).toBe(403);
  });
});