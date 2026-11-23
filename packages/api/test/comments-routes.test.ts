import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import "./env";

// Comment-thread routes (U3), integration-tested against a RUNNING api dev
// server like files-routes.test.ts: real HTTP, real Postgres, real anchor
// resolution, real concurrency. Gated on the server being reachable so
// `vp test` stays green without one — start `pnpm dev:api` (and set SMOKE_BASE
// if not on :3001) to run it.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

// The forced-interleaving tests below park a transaction on a TABLE-level lock
// to hit a race window deterministically. That is not safe to run alongside
// other suites: the MCP suite mutates the same tables, so its blocked sessions
// satisfy this suite's "has it parked yet?" waits and the lock is released a
// statement early — the resolve test then wins the race it is supposed to lose.
// They pass reliably on their own, so they run when asked for rather than
// flaking the parallel suite:
//
//   COMMENT_RACE_TESTS=1 vp test packages/api/test/comments-routes.test.ts
const raceTests = process.env.COMMENT_RACE_TESTS === "1";

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { setNodePrivate } = await import("../server/utils/acl");
const db = usePrismaClient();

// The dev server runs the local FS blob driver with cwd packages/api, so the
// pinned blob for (workspace, content) lives at this path — the blob-gone test
// deletes it out from under the server, as a GC bug or R2 loss would.
const BLOB_ROOT = fileURLToPath(new URL("../.data/blobs", import.meta.url));
const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

async function setup() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user } = await auth.api.signUpEmail({
    body: { email: `cm${stamp}@example.test`, password: "correct-horse-battery", name: "CM" },
  });
  const org = await db.organization.create({ data: { id: `org_cm_${stamp}`, name: "CM Org" } });
  await db.member.create({
    data: {
      id: `mem_cm_${stamp}`,
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
      name: "cm-agent",
      metadata: { workspaceId: ws.id, actorType: "agent" },
    },
  });
  const key2 = await auth.api.createApiKey({
    body: {
      userId: user.id,
      name: "cm-agent-2",
      metadata: { workspaceId: ws2.id, actorType: "agent" },
    },
  });
  return { ws, ws2, key: key.key, keyId: key.id, key2: key2.key, ownerId: user.id };
}

// Owner + plain member of one org sharing a workspace (for ACL scenarios).
async function setupTwoMembers() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const { user: owner } = await auth.api.signUpEmail({
    body: { email: `co${stamp}@example.test`, password: "correct-horse-battery", name: "Owner" },
  });
  const { user: member } = await auth.api.signUpEmail({
    body: { email: `cn${stamp}@example.test`, password: "correct-horse-battery", name: "Member" },
  });
  const org = await db.organization.create({ data: { id: `org_ca_${stamp}`, name: "CA Org" } });
  for (const [i, u] of [owner, member].entries()) {
    await db.member.create({
      data: {
        id: `mem_ca_${stamp}_${i}`,
        organizationId: org.id,
        userId: u.id,
        role: i === 0 ? "owner" : "member",
        createdAt: new Date(),
      },
    });
  }
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Shared" } });
  const ownerKey = await auth.api.createApiKey({
    body: { userId: owner.id, name: "own", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  const memberKey = await auth.api.createApiKey({
    body: { userId: member.id, name: "mem", metadata: { workspaceId: ws.id, actorType: "human" } },
  });
  return { ws, owner, member, ownerKey: ownerKey.key, memberKey: memberKey.key };
}

// Mint a real cookie session in-process (asResponse exposes Set-Cookie), the
// device-flow test's idiom, for the session-vs-key parity scenario.
async function signUpSession() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const res = await auth.api.signUpEmail({
    body: { email: `cs${stamp}@example.test`, password: "correct-horse-battery", name: "CS" },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!cookie || !userId) throw new Error(`sign-up failed (${res.status})`);
  const org = await db.organization.create({ data: { id: `org_cs_${stamp}`, name: "CS Org" } });
  await db.member.create({
    data: {
      id: `mem_cs_${stamp}`,
      organizationId: org.id,
      userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
  const key = await auth.api.createApiKey({
    body: { userId, name: "cs-agent", metadata: { workspaceId: ws.id, actorType: "agent" } },
  });
  return { ws, cookie, userId, key: key.key, keyId: key.id };
}

// ---- HTTP helpers ----------------------------------------------------------

type Auth = { "x-api-key": string } | { cookie: string };

// Encode per segment — encoding the whole path would send `a%2Fb` as ONE path
// segment and silently create a file at the wrong (slashless) path.
const putFile = (
  wsId: string,
  a: Auth,
  path: string,
  body: string,
  ifMatch?: number,
  contentType = "text/markdown",
) =>
  fetch(
    `${BASE}/api/workspaces/${wsId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      headers: {
        ...a,
        "content-type": contentType,
        ...(ifMatch === undefined ? { "if-none-match": "*" } : { "if-match": `"${ifMatch}"` }),
      },
      body,
    },
  );

const createComment = (wsId: string, a: Auth, payload: object) =>
  fetch(`${BASE}/api/workspaces/${wsId}/comments`, {
    method: "POST",
    headers: { ...a, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

interface ThreadView {
  id: string;
  path: string;
  status: string;
  resolvedAt: string | null;
  resolvedAtVersion: number | null;
  resolvedBy: { principal: string; actorId: string | null; actorKeyId: string | null } | null;
  anchorKind: string;
  quote: string;
  pinnedVersion: number;
  anchorStatus: string;
  currentText: string | null;
  createdBy: { principal: string; actorId: string | null; actorKeyId: string | null };
  updatedAt: string;
  entries: { id: string; body: string; author: { principal: string; actorId: string | null } }[];
  entryCount: number;
  hasMoreEntries: boolean;
}

interface ListBody {
  threads: ThreadView[];
  total: number;
  nextOffset: number | null;
  truncated: boolean;
}

const listComments = async (wsId: string, a: Auth, qs = "") => {
  const res = await fetch(`${BASE}/api/workspaces/${wsId}/comments${qs}`, { headers: { ...a } });
  return { status: res.status, body: (await res.json()) as ListBody };
};

const reply = (wsId: string, a: Auth, threadId: string, body: string, dedupeKey?: string) =>
  fetch(`${BASE}/api/workspaces/${wsId}/comments/${threadId}/replies`, {
    method: "POST",
    headers: { ...a, "content-type": "application/json" },
    body: JSON.stringify({ body, dedupeKey }),
  });

const putResolved = (wsId: string, a: Auth, threadId: string, resolved: boolean) =>
  fetch(`${BASE}/api/workspaces/${wsId}/comments/${threadId}/resolved`, {
    method: "PUT",
    headers: { ...a, "content-type": "application/json" },
    body: JSON.stringify({ resolved }),
  });

const pinnedContent = (wsId: string, a: Auth, threadId: string) =>
  fetch(`${BASE}/api/workspaces/${wsId}/comments/${threadId}/pinned-content`, {
    headers: { ...a },
  });

type ChangesBody = {
  changes: {
    op: string;
    path: string;
    seq: number;
    version: number | null;
    principal: string;
    actorKeyId: string | null;
    actorLabel: string | null;
  }[];
  head: number;
  nextSeq?: number;
};
const getChanges = (wsId: string, a: Auth, qs: string) =>
  fetch(`${BASE}/api/workspaces/${wsId}/changes${qs}`, { headers: { ...a } }).then(
    (r) => r.json() as Promise<ChangesBody>,
  );

const created = async (res: Response): Promise<ThreadView> => {
  expect(res.status).toBe(201);
  return ((await res.json()) as { thread: ThreadView }).thread;
};

// ---- Forced-interleaving helpers -------------------------------------------
// Racing two requests and hoping to land in the window proves nothing. A held
// table lock is a deterministic pause button instead: it parks a request at a
// KNOWN statement (its first write to that table) with everything before that
// statement already done, so the interleaving is constructed rather than raced.
// The tables are chosen so the paused operation and its counterpart don't share
// the pause point — see each test for which window it opens.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take an EXCLUSIVE lock on `table` and hold it until the returned release. */
async function holdTableLock(table: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let acquired!: () => void;
  const held = new Promise<void>((r) => {
    acquired = r;
  });
  const tx = db.$transaction(
    async (t) => {
      await t.$executeRawUnsafe(`LOCK TABLE "${table}" IN EXCLUSIVE MODE`);
      acquired();
      await gate;
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  await Promise.race([held, tx]);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    release();
    await tx;
  };
}

/**
 * Sessions in this database parked on a lock. The lock HOLDER above waits on
 * nothing, so it never counts itself. `pattern` (SQL ILIKE) narrows to the
 * statement a specific operation is expected to be parked on.
 */
async function blockedSessions(pattern = "%"): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
  return Number(rows[0]?.n ?? 0);
}

async function waitFor(cond: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Blocks of `comment_entry` TOAST touched so far — the fat reply bodies below
 * live there, so this counts "how much reply payload did the server actually
 * pull?", which is the difference between paging replies and slicing them.
 *
 * A backend publishes its stats only at the end of a transaction, and only once
 * a second, so an idle connection can sit on its counters for many seconds.
 * `nudge` is given cheap requests to push through the pool: each one ends a
 * transaction on a connection and flushes whatever it was holding.
 */
async function toastBlocks(nudge: () => Promise<unknown>): Promise<number> {
  await sleep(1_200);
  for (let i = 0; i < 15; i++) await nudge();
  await sleep(600);
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT (coalesce(toast_blks_hit, 0) + coalesce(toast_blks_read, 0))::bigint AS n
      FROM pg_statio_user_tables WHERE relname = 'comment_entry'`;
    const n = Number(rows[0]?.n ?? 0);
    if (n === last) return n;
    last = n;
    await sleep(300);
  }
  return last;
}

// ---- Content fixtures ------------------------------------------------------

const V1 = "# Doc\n\nAlpha beta gamma delta paragraph one.\n\nAnother line entirely here.\n";
const QUOTE = "beta gamma delta";
/** A second, non-overlapping quote in V1, for two threads on one file. */
const QUOTE_B = "Another line entirely";
// A rewrite sharing no phrasing with V1, so the anchor cascade lands outdated.
const V2 = "# Doc\n\nCompletely rewritten with nothing in common anymore.\n";

describe.skipIf(!serverUp)("comment routes (HTTP)", () => {
  it("create at v-old, rewrite removing the quote: outdated with original quote; pinned + move keep original bytes", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    expect((await putFile(ws.id, a, "a.md", V1)).status).toBe(201);
    const thread = await created(
      await createComment(ws.id, a, {
        path: "a.md",
        body: "tighten this",
        quote: QUOTE,
        kind: "range",
      }),
    );
    expect(thread.anchorStatus).toBe("anchored");
    expect(thread.currentText).toBe(QUOTE);
    expect(thread.pinnedVersion).toBe(1);

    expect((await putFile(ws.id, a, "a.md", V2, 1)).status).toBe(200);
    const after = await listComments(ws.id, a, "?path=a.md");
    expect(after.status).toBe(200);
    expect(after.body.threads).toHaveLength(1);
    expect(after.body.threads[0]!.anchorStatus).toBe("outdated");
    expect(after.body.threads[0]!.quote).toBe(QUOTE); // original quote survives
    expect(after.body.threads[0]!.currentText).toBeNull();

    // Pinned content is the ORIGINAL bytes, not the rewrite.
    const pin = await pinnedContent(ws.id, a, thread.id);
    expect(pin.status).toBe(200);
    expect(await pin.text()).toBe(V1);
    expect(pin.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pin.headers.get("content-security-policy")).toContain("sandbox");

    // Move resets the version number to 1 at the new path; the hash pin must
    // not care. The thread follows the file.
    const moved = await fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
      method: "POST",
      headers: { ...a, "content-type": "application/json" },
      body: JSON.stringify({ from: "a.md", to: "b.md" }),
    });
    expect(moved.ok).toBe(true);
    const atNew = await listComments(ws.id, a, "?path=b.md");
    expect(atNew.body.threads.map((t) => t.id)).toEqual([thread.id]);
    const atOld = await listComments(ws.id, a, "?path=a.md");
    expect(atOld.body.total).toBe(0);
    const pin2 = await pinnedContent(ws.id, a, thread.id);
    expect(pin2.status).toBe(200);
    expect(await pin2.text()).toBe(V1);
  });

  it("ambiguous create (quote x3, no context) returns structured ambiguity and no row", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    const tripled = "repeat phrase here.\n\nrepeat phrase here.\n\nrepeat phrase here.\n";
    await putFile(ws.id, a, "amb.md", tripled);
    const res = await createComment(ws.id, a, {
      path: "amb.md",
      body: "which one?",
      quote: "repeat phrase here.",
      kind: "range",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; occurrences: number };
    expect(body.error).toBe("anchor_ambiguous");
    expect(body.occurrences).toBe(3);
    expect((await listComments(ws.id, a, "?path=amb.md")).body.total).toBe(0);
  });

  it("stale baseVersion whose text moved meaningfully returns a conflict shape and no row", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "c.md", V1);
    await putFile(ws.id, a, "c.md", V2, 1);
    const res = await createComment(ws.id, a, {
      path: "c.md",
      body: "note on old text",
      quote: QUOTE,
      kind: "range",
      baseVersion: 1,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      base_version: number;
      current_version: number;
    };
    expect(body.error).toBe("base_version_conflict");
    expect(body.base_version).toBe(1);
    expect(body.current_version).toBe(2);
    expect((await listComments(ws.id, a, "?path=c.md")).body.total).toBe(0);
  });

  it("thread create emits an attributed event with a NON-NULL version; non-opted polls never see it", async () => {
    const { ws, key, keyId } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "e.md", V1);
    await created(
      await createComment(ws.id, a, { path: "e.md", body: "hello", quote: QUOTE, kind: "range" }),
    );

    const opted = await getChanges(ws.id, a, "?sinceSeq=0&includeComments=1");
    const ev = opted.changes.find((c) => c.op === "comment_created");
    expect(ev).toBeDefined();
    expect(ev!.path).toBe("e.md");
    // Load-bearing: a null version reads as a remote delete to fielded CLIs.
    expect(ev!.version).toBe(1);
    expect(ev!.principal).toBe("agent");
    expect(ev!.actorKeyId).toBe(keyId);
    expect(ev!.actorLabel).toBe("cm-agent");

    const plain = await getChanges(ws.id, a, "?sinceSeq=0");
    expect(plain.changes.some((c) => c.op.startsWith("comment_"))).toBe(false);
  });

  it("a window containing only comment events still returns nextSeq === head", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "w.md", V1);
    const before = await getChanges(ws.id, a, "?sinceSeq=0");
    const cursor = before.head;
    const t = await created(
      await createComment(ws.id, a, { path: "w.md", body: "one", quote: QUOTE, kind: "range" }),
    );
    await reply(ws.id, a, t.id, "two");
    await reply(ws.id, a, t.id, "three");

    const page = await getChanges(ws.id, a, `?sinceSeq=${cursor}`);
    expect(page.changes).toEqual([]); // all three events are comment traffic
    // seq is a global sequence, so the three events need not be consecutive —
    // the invariant is that head advanced and the cursor lands ON it, so a
    // comment-only window can never stall a non-opted poller.
    expect(page.head).toBeGreaterThan(cursor);
    expect(page.nextSeq).toBe(page.head);
  });

  it("windowed desc reads are not crowded out by ~30 comment events", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "hist.md", V1);
    const t = await created(
      await createComment(ws.id, a, {
        path: "hist.md",
        body: "start",
        quote: QUOTE,
        kind: "range",
      }),
    );
    for (let i = 0; i < 30; i++) await reply(ws.id, a, t.id, `chatter ${i}`);

    const desc = await getChanges(ws.id, a, "?order=desc&limit=10");
    expect(desc.changes.length).toBeGreaterThan(0);
    expect(desc.changes.every((c) => !c.op.startsWith("comment_"))).toBe(true);
    expect(desc.changes.some((c) => c.op === "write")).toBe(true);

    // Opted-in, the same window IS the comment traffic (sanity of the opt-in).
    const optedDesc = await getChanges(ws.id, a, "?order=desc&limit=10&includeComments=1");
    expect(optedDesc.changes.some((c) => c.op === "comment_replied")).toBe(true);
  });

  it("reply + resolve stamp actor and version; double-resolve is idempotent; reopen works", async () => {
    const { ws, key, keyId, ownerId } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "r.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "r.md", body: "root", quote: QUOTE, kind: "range" }),
    );

    const rep = await reply(ws.id, a, t.id, "a reply");
    expect(rep.status).toBe(201);
    const repBody = (await rep.json()) as {
      entry: { author: { principal: string; actorId: string } };
      deduped: boolean;
    };
    expect(repBody.deduped).toBe(false);
    expect(repBody.entry.author.principal).toBe("agent");
    expect(repBody.entry.author.actorId).toBe(ownerId);

    const res1 = await putResolved(ws.id, a, t.id, true);
    expect(res1.status).toBe(200);
    const r1 = (await res1.json()) as {
      resolved: boolean;
      resolvedAtVersion: number;
      resolvedBy: { principal: string; actorKeyId: string };
      changed: boolean;
    };
    expect(r1.resolved).toBe(true);
    expect(r1.changed).toBe(true);
    expect(r1.resolvedAtVersion).toBe(1);
    expect(r1.resolvedBy.principal).toBe("agent");
    expect(r1.resolvedBy.actorKeyId).toBe(keyId);

    // Second resolve: success, no state change, no second event.
    const res2 = await putResolved(ws.id, a, t.id, true);
    const r2 = (await res2.json()) as { resolved: boolean; changed: boolean };
    expect(r2).toMatchObject({ resolved: true, changed: false });

    const reopen = await putResolved(ws.id, a, t.id, false);
    const r3 = (await reopen.json()) as { resolved: boolean; changed: boolean; resolvedAt: null };
    expect(r3).toMatchObject({ resolved: false, changed: true, resolvedAt: null });

    const feed = await getChanges(ws.id, a, "?sinceSeq=0&includeComments=1&limit=1000");
    expect(feed.changes.filter((c) => c.op === "comment_resolved")).toHaveLength(1);
    expect(feed.changes.filter((c) => c.op === "comment_reopened")).toHaveLength(1);
    const listed = await listComments(ws.id, a, `?threadId=${t.id}`);
    expect(listed.body.threads[0]!.status).toBe("open");
  });

  it("CONCURRENT duplicate replies with one dedupeKey insert once and emit one event", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "dk.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "dk.md", body: "root", quote: QUOTE, kind: "range" }),
    );

    const [x, y] = await Promise.all([
      reply(ws.id, a, t.id, "same retry", "retry-1"),
      reply(ws.id, a, t.id, "same retry", "retry-1"),
    ]);
    expect(x.status).toBe(201);
    expect(y.status).toBe(201);
    const bx = (await x.json()) as { entry: { id: string } };
    const by = (await y.json()) as { entry: { id: string } };
    expect(bx.entry.id).toBe(by.entry.id); // one surviving row, returned to both

    const listed = await listComments(ws.id, a, `?threadId=${t.id}`);
    expect(listed.body.threads[0]!.entryCount).toBe(2); // root body + one reply
    const feed = await getChanges(ws.id, a, "?sinceSeq=0&includeComments=1&limit=1000");
    expect(feed.changes.filter((c) => c.op === "comment_replied")).toHaveLength(1);
  });

  it("concurrent move and reply do not deadlock; the thread ends at exactly one path", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "m1.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "m1.md", body: "root", quote: QUOTE, kind: "range" }),
    );

    const [mv, rp] = await Promise.all([
      fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
        method: "POST",
        headers: { ...a, "content-type": "application/json" },
        body: JSON.stringify({ from: "m1.md", to: "m2.md" }),
      }),
      reply(ws.id, a, t.id, "racing reply"),
    ]);
    expect(mv.ok).toBe(true);
    expect(rp.status).toBe(201);

    const rows = await db.commentThread.findMany({ where: { id: t.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("m2.md");
    const listed = await listComments(ws.id, a, `?threadId=${t.id}`);
    expect(listed.body.threads[0]!.entryCount).toBe(2);

    // The event's path is not free-form: whichever way the two linearized, the
    // reply is stamped with a path the file genuinely occupied at that moment —
    // never a third value — and with a non-null version (a null one reads as a
    // remote delete). Which of the two it is, is the race's to decide; the
    // forced-interleaving test below pins the private-destination case exactly.
    const feed = await getChanges(ws.id, a, "?sinceSeq=0&includeComments=1&limit=1000");
    const replied = feed.changes.filter((c) => c.op === "comment_replied");
    expect(replied).toHaveLength(1);
    expect(["m1.md", "m2.md"]).toContain(replied[0]!.path);
    expect(replied[0]!.version).not.toBeNull();
  });

  it.skipIf(!raceTests)(
    "FORCED INTERLEAVING: a move landing mid-create cannot strand the thread at the old path",
    async () => {
      const { ws, key } = await setup();
      const a = { "x-api-key": key };
      await putFile(ws.id, a, "i1.md", V1);

      // Pause point: comment_entry. A create writes comment_thread and THEN
      // comment_entry, while move() never touches comment_entry at all — so the
      // lock parks the create with its thread row written-but-uncommitted and
      // lets a whole move run through the exact window the race needs.
      const unlock = await holdTableLock("comment_entry");
      try {
        const creating = createComment(ws.id, a, {
          path: "i1.md",
          body: "root",
          quote: QUOTE,
          kind: "range",
        });
        await waitFor(
          async () => (await blockedSessions("%comment_entry%")) >= 1,
          "the create to park on comment_entry",
        );

        const moving = fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
          method: "POST",
          headers: { ...a, "content-type": "application/json" },
          body: JSON.stringify({ from: "i1.md", to: "i2.md" }),
        });
        // The move either runs straight through (nothing serializes it) or parks
        // behind the create's file_node lock. Racing the two outcomes keeps the
        // schedule deterministic without a guessed sleep either way.
        await Promise.race([
          moving,
          waitFor(async () => (await blockedSessions("%file_node%")) >= 1, "the move to park"),
        ]);
        await unlock();

        const [cRes, mRes] = await Promise.all([creating, moving]);
        expect(mRes.ok).toBe(true);
        const thread = await created(cRes);

        // The comment must be attached to the file it was written on, wherever
        // that file now lives — not left behind at a path nothing occupies.
        const row = await db.commentThread.findUnique({ where: { id: thread.id } });
        expect(row!.path).toBe("i2.md");
        expect((await listComments(ws.id, a, "?path=i2.md")).body.threads.map((t) => t.id)).toEqual(
          [thread.id],
        );
        expect((await listComments(ws.id, a, "?path=i1.md")).body.total).toBe(0);

        // Exactly one create event, stamped with the path the file held when the
        // create linearized (it won the serialization), and a live version.
        const feed = await getChanges(ws.id, a, "?sinceSeq=0&includeComments=1&limit=1000");
        const evs = feed.changes.filter((c) => c.op === "comment_created");
        expect(evs).toHaveLength(1);
        expect(evs[0]!.path).toBe("i1.md");
        expect(evs[0]!.version).toBe(1);
      } finally {
        await unlock();
      }
    },
  );

  it.skipIf(!raceTests)(
    "FORCED INTERLEAVING: a retype to text/plain mid-create cannot strand a thread on a non-markdown file",
    async () => {
      const { ws, key } = await setup();
      const a = { "x-api-key": key };
      await putFile(ws.id, a, "r1.md", V1);

      // The window is between the create's plain markdown check and its locked
      // re-read, and nothing lockable sits in between — so it is opened with a
      // FIRST create instead. Parked on comment_entry, that create holds the
      // file_node row locked, and Postgres queues the two requests behind it in
      // arrival order: the retype, then the second create.
      const unlock = await holdTableLock("comment_entry");
      let secondCreate: Promise<Response>;
      try {
        const first = createComment(ws.id, a, {
          path: "r1.md",
          body: "first",
          quote: QUOTE,
          kind: "range",
        });
        await waitFor(
          async () => (await blockedSessions("%comment_entry%")) >= 1,
          "the first create to park on comment_entry",
        );

        // Queued behind the lock: retypes the SAME node to text/plain.
        const retype = putFile(ws.id, a, "r1.md", V1, 1, "text/plain");
        await waitFor(
          async () => (await blockedSessions("%file_node%")) >= 1,
          "the retype to park on file_node",
        );

        // Queued behind the retype: reads markdown (the retype has not committed
        // yet), then blocks — so its locked re-read runs against text/plain.
        secondCreate = createComment(ws.id, a, {
          path: "r1.md",
          body: "second",
          quote: QUOTE_B,
          kind: "range",
        });
        await waitFor(
          async () => (await blockedSessions("%file_node%")) >= 2,
          "the second create to park behind the retype",
        );
        await unlock();

        expect((await first).status).toBe(201);
        expect((await retype).ok).toBe(true);
      } finally {
        await unlock();
      }

      // The second create saw markdown when it looked and text/plain when it
      // committed. It must land on the same answer a serial request would.
      const res = await secondCreate;
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("not_markdown");
      expect((await listComments(ws.id, a, "?path=r1.md")).body.total).toBe(1);
    },
  );

  it.skipIf(!raceTests)(
    "FORCED INTERLEAVING: a reply cannot commit against a path a move just made private",
    async () => {
      const { ws, owner, ownerKey, memberKey } = await setupTwoMembers();
      const o = { "x-api-key": ownerKey };
      const m = { "x-api-key": memberKey };
      await setNodePrivate({
        workspaceId: ws.id,
        path: "vault",
        kind: "folder",
        ownerId: owner.id,
      });
      await putFile(ws.id, o, "open.md", V1);
      const t = await created(
        await createComment(ws.id, o, {
          path: "open.md",
          body: "root",
          quote: QUOTE,
          kind: "range",
        }),
      );
      expect((await reply(ws.id, m, t.id, "before the move")).status).toBe(201);

      // Pause point: change_event. move() records its two change events AFTER it
      // re-paths comment_thread, so the lock parks the move holding the thread
      // row already carrying the new, private path — precisely the state a reply
      // must not be allowed to read past.
      const unlock = await holdTableLock("change_event");
      try {
        const moving = fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
          method: "POST",
          headers: { ...o, "content-type": "application/json" },
          body: JSON.stringify({ from: "open.md", to: "vault/open.md" }),
        });
        await waitFor(
          async () => (await blockedSessions("%change_event%")) >= 1,
          "the move to park on change_event",
        );

        const replying = reply(ws.id, m, t.id, "after the move");
        await waitFor(
          async () => (await blockedSessions("%comment_thread%")) >= 1,
          "the reply to park on comment_thread",
        );
        await unlock();

        const [mRes, rRes] = await Promise.all([moving, replying]);
        expect(mRes.ok).toBe(true);
        // The member can no longer read the file the thread hangs off, so the
        // reply must fail-as-404 and leave nothing behind.
        expect(rRes.status).toBe(404);
        const entries = await db.commentEntry.findMany({
          where: { threadId: t.id },
          orderBy: { createdAt: "asc" },
        });
        expect(entries.map((e) => e.body)).toEqual(["root", "before the move"]);

        const feed = await getChanges(ws.id, o, "?sinceSeq=0&includeComments=1&limit=1000");
        const replied = feed.changes.filter((c) => c.op === "comment_replied");
        expect(replied).toHaveLength(1);
        expect(replied[0]!.path).toBe("open.md"); // the pre-move reply, not the racing one

        // Sequential parity: the same denial once the move is plainly committed.
        expect((await reply(ws.id, m, t.id, "later")).status).toBe(404);
        expect((await putResolved(ws.id, m, t.id, true)).status).toBe(404);
        expect((await listComments(ws.id, m, `?threadId=${t.id}`)).status).toBe(404);
        // …and the owner, who can still read the destination, is unaffected.
        expect((await reply(ws.id, o, t.id, "owner reply")).status).toBe(201);
      } finally {
        await unlock();
      }
    },
  );

  it.skipIf(!raceTests)(
    "FORCED INTERLEAVING: a resolve cannot commit against a path a move just made private",
    async () => {
      const { ws, owner, ownerKey, memberKey } = await setupTwoMembers();
      const o = { "x-api-key": ownerKey };
      const m = { "x-api-key": memberKey };
      await setNodePrivate({
        workspaceId: ws.id,
        path: "vault",
        kind: "folder",
        ownerId: owner.id,
      });
      await putFile(ws.id, o, "res.md", V1);
      const t = await created(
        await createComment(ws.id, o, {
          path: "res.md",
          body: "root",
          quote: QUOTE,
          kind: "range",
        }),
      );

      const unlock = await holdTableLock("change_event");
      try {
        const moving = fetch(`${BASE}/api/workspaces/${ws.id}/move`, {
          method: "POST",
          headers: { ...o, "content-type": "application/json" },
          body: JSON.stringify({ from: "res.md", to: "vault/res.md" }),
        });
        await waitFor(
          async () => (await blockedSessions("%change_event%")) >= 1,
          "the move to park on change_event",
        );

        const resolving = putResolved(ws.id, m, t.id, true);
        await waitFor(
          async () => (await blockedSessions("%comment_thread%")) >= 1,
          "the resolve to park on comment_thread",
        );
        await unlock();

        const [mRes, rRes] = await Promise.all([moving, resolving]);
        expect(mRes.ok).toBe(true);
        expect(rRes.status).toBe(404);

        const row = await db.commentThread.findUnique({ where: { id: t.id } });
        expect(row!.path).toBe("vault/res.md");
        expect(row!.resolvedAt).toBeNull(); // no state change committed
        const feed = await getChanges(ws.id, o, "?sinceSeq=0&includeComments=1&limit=1000");
        expect(feed.changes.some((c) => c.op === "comment_resolved")).toBe(false);
      } finally {
        await unlock();
      }
    },
  );

  it("thread paging: page two is reachable, the cursor is exposed, nothing is lost or doubled", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    const n = 55;
    const tok = (i: number) => `token-${String(i).padStart(3, "0")}`;
    const doc = Array.from({ length: n }, (_, i) => `Paragraph ${i} ${tok(i)} ends here.`);
    await putFile(ws.id, a, "page.md", `# Doc\n\n${doc.join("\n\n")}\n`);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = await created(
        await createComment(ws.id, a, {
          path: "page.md",
          body: `note ${i}`,
          quote: tok(i),
          kind: "range",
        }),
      );
      ids.push(t.id);
    }

    const first = await listComments(ws.id, a, "?path=page.md&limit=50");
    expect(first.body.threads).toHaveLength(50);
    expect(first.body.total).toBe(n);
    expect(first.body.nextOffset).toBe(50);
    const second = await listComments(ws.id, a, `?path=page.md&limit=50&offset=${50}`);
    expect(second.body.threads).toHaveLength(5);
    expect(second.body.nextOffset).toBeNull();
    // Thread 51 — the reviewer's example — is reachable, and the two pages are
    // exactly the set of threads, in creation order, with no overlap.
    expect([...first.body.threads, ...second.body.threads].map((t) => t.id)).toEqual(ids);

    // The anchorStatus filter can only be applied after resolution, so it pages
    // over a bounded scan rather than in SQL — page two must still be reachable.
    const filtered = await listComments(ws.id, a, "?path=page.md&anchorStatus=anchored&offset=50");
    expect(filtered.body.total).toBe(n);
    expect(filtered.body.threads.map((t) => t.id)).toEqual(ids.slice(50));
    expect(filtered.body.truncated).toBe(false);
  });

  // Longer budget than the default: the toast-block readings below have to wait
  // out Postgres' asynchronous stats flush four times.
  it("reply paging: the 21st reply is reachable and a listing does not load every reply", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "fat.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "fat.md", body: "root", quote: QUOTE, kind: "range" }),
    );

    // Bulk-insert fat replies straight into the database — the read path is what
    // is under test. ~30 KB of incompressible body per row lands in TOAST, which
    // makes "did the server pull them all?" a measurable quantity.
    const replies = 200;
    const base = Date.now() + 60_000;
    await db.commentEntry.createMany({
      data: Array.from({ length: replies }, (_, i) => ({
        workspaceId: ws.id,
        threadId: t.id,
        body: `r${String(i).padStart(3, "0")} ${randomBytes(22_000).toString("base64")}`,
        principal: "agent",
        createdAt: new Date(base + i),
      })),
    });

    // A listing of a path with no threads at all: enough to end a transaction
    // on a pooled connection (which publishes its stats), and it reads no
    // entries of its own, so it can't pollute the measurement.
    const nudge = () => listComments(ws.id, a, "?path=empty.md");

    const before = await toastBlocks(nudge);
    const first = await listComments(ws.id, a, `?threadId=${t.id}`);
    const pageCost = (await toastBlocks(nudge)) - before;

    expect(first.body.threads[0]!.entries).toHaveLength(20);
    expect(first.body.threads[0]!.entryCount).toBe(replies + 1);
    expect(first.body.threads[0]!.hasMoreEntries).toBe(true);
    expect(first.body.threads[0]!.entries.at(-1)!.body.startsWith("r018")).toBe(true);

    // Reply 21 is reachable.
    const page2 = await listComments(ws.id, a, `?threadId=${t.id}&entriesOffset=20&entriesLimit=5`);
    const shown = page2.body.threads[0]!.entries;
    expect(shown).toHaveLength(5);
    expect(shown[0]!.body.startsWith("r019")).toBe(true);
    expect(shown.at(-1)!.body.startsWith("r023")).toBe(true);
    expect(page2.body.threads[0]!.entryCount).toBe(replies + 1);

    // Bounded work, with a guard against a vacuous threshold: pulling every
    // entry the way an unpaged read does costs far more than the page did.
    const beforeAll = await toastBlocks(nudge);
    await db.commentEntry.findMany({ where: { threadId: t.id } });
    const fullCost = (await toastBlocks(nudge)) - beforeAll;
    expect(fullCost).toBeGreaterThan(400);
    expect(pageCost).toBeLessThan(fullCost / 4);
  }, 60_000);

  it("deleted file: threads listable as outdated, pinned serves; recreate re-anchors against new content", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "d.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "d.md", body: "root", quote: QUOTE, kind: "range" }),
    );
    const del = await fetch(`${BASE}/api/workspaces/${ws.id}/files/d.md`, {
      method: "DELETE",
      headers: { ...a, "if-match": '"1"' },
    });
    expect(del.status).toBe(204);

    const gone = await listComments(ws.id, a, "?path=d.md");
    expect(gone.body.threads[0]!.anchorStatus).toBe("outdated");
    expect(gone.body.threads[0]!.currentText).toBeNull();
    expect((await reply(ws.id, a, t.id, "still here")).status).toBe(201);
    const pin = await pinnedContent(ws.id, a, t.id);
    expect(await pin.text()).toBe(V1);

    // Recreate the path with DIFFERENT content that still contains the quote:
    // the thread re-anchors against the new incarnation (status per matcher).
    const V3 = `# Reborn\n\nNew intro line.\n\nStill mentions beta gamma delta once.\n`;
    expect((await putFile(ws.id, a, "d.md", V3)).status).toBe(201);
    const back = await listComments(ws.id, a, "?path=d.md");
    expect(back.body.threads[0]!.anchorStatus).toBe("anchored");
    expect(back.body.threads[0]!.currentText).toBe(QUOTE);
    expect(back.body.threads[0]!.pinnedVersion).toBe(1); // still labels the ORIGINAL pin
  });

  it("removed pinned blob: thread lists, mutations work, pinned-content is 410, currentText never fabricated", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "pb.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "pb.md", body: "root", quote: QUOTE, kind: "range" }),
    );
    await putFile(ws.id, a, "pb.md", V2, 1); // current no longer needs the V1 blob

    const blobPath = join(BLOB_ROOT, ws.id, sha256(V1));
    expect(existsSync(blobPath)).toBe(true); // layout guard: fail loudly, not vacuously
    rmSync(blobPath);
    rmSync(`${blobPath}.ct`, { force: true });

    const listed = await listComments(ws.id, a, "?path=pb.md");
    expect(listed.body.threads).toHaveLength(1);
    expect(listed.body.threads[0]!.anchorStatus).toBe("outdated");
    expect(listed.body.threads[0]!.currentText).toBeNull();
    expect((await reply(ws.id, a, t.id, "reply survives")).status).toBe(201);
    expect((await putResolved(ws.id, a, t.id, true)).status).toBe(200);
    expect((await pinnedContent(ws.id, a, t.id)).status).toBe(410);
  });

  it("nulling the resolution cache between two list calls yields identical responses", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "cc.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "cc.md", body: "root", quote: QUOTE, kind: "range" }),
    );
    // Drift the content so the cached (creation-time) resolution is stale and
    // the first list exercises a real re-resolve + cache write.
    await putFile(ws.id, a, "cc.md", `${V1}\nAppended trailing line.\n`, 1);

    const strip = (r: { threads: ThreadView[]; total: number }) => ({
      ...r,
      threads: r.threads.map((th) => ({ ...th, updatedAt: undefined })),
    });
    const first = await listComments(ws.id, a, "?path=cc.md");
    await db.commentThread.update({
      where: { id: t.id },
      data: { lastResolvedHash: null, resolvedStart: null, resolvedEnd: null, anchorStatus: null },
    });
    const second = await listComments(ws.id, a, "?path=cc.md");
    expect(strip(second.body)).toEqual(strip(first.body)); // cache is pure latency
  });

  it("a conflicted-copy save leaves zero threads on the copy path", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "s.md", V1);
    await created(
      await createComment(ws.id, a, { path: "s.md", body: "root", quote: QUOTE, kind: "range" }),
    );
    await putFile(ws.id, a, "s.md", V2, 1);
    const stale = await putFile(ws.id, a, "s.md", "# stale edit\n", 1);
    expect(stale.status).toBe(412);
    const copyPath = ((await stale.json()) as { conflict_copy_path: string }).conflict_copy_path;
    expect(copyPath).toBeTruthy();

    const onCopy = await listComments(ws.id, a, `?path=${encodeURIComponent(copyPath)}`);
    expect(onCopy.body.total).toBe(0);
    const onOriginal = await listComments(ws.id, a, "?path=s.md");
    expect(onOriginal.body.total).toBe(1);
  });

  it("ACL: a private path's threads are 404 for a non-reader on every route and filtered from their feed", async () => {
    const { ws, owner, ownerKey, memberKey } = await setupTwoMembers();
    const o = { "x-api-key": ownerKey };
    const m = { "x-api-key": memberKey };
    await setNodePrivate({ workspaceId: ws.id, path: "priv", kind: "folder", ownerId: owner.id });
    expect((await putFile(ws.id, o, "priv/doc.md", V1)).status).toBe(201);
    const t = await created(
      await createComment(ws.id, o, {
        path: "priv/doc.md",
        body: "secret",
        quote: QUOTE,
        kind: "range",
      }),
    );

    expect((await listComments(ws.id, m, "?path=priv%2Fdoc.md")).status).toBe(404);
    expect((await listComments(ws.id, m, `?threadId=${t.id}`)).status).toBe(404);
    expect((await reply(ws.id, m, t.id, "hi")).status).toBe(404);
    expect((await putResolved(ws.id, m, t.id, true)).status).toBe(404);
    expect((await pinnedContent(ws.id, m, t.id)).status).toBe(404);
    // The unfiltered list simply omits the private thread for the member.
    expect((await listComments(ws.id, m)).body.total).toBe(0);

    const memberFeed = await getChanges(ws.id, m, "?sinceSeq=0&includeComments=1&limit=1000");
    expect(memberFeed.changes.some((c) => c.op.startsWith("comment_"))).toBe(false);
    const ownerFeed = await getChanges(ws.id, o, "?sinceSeq=0&includeComments=1&limit=1000");
    expect(ownerFeed.changes.some((c) => c.op === "comment_created")).toBe(true);

    // The owner still has full access.
    expect((await listComments(ws.id, o, `?threadId=${t.id}`)).status).toBe(200);
  });

  it("ACL: a member's own file inside someone else's private folder still lists", async () => {
    // The listing now expresses canRead as SQL so it can page in the database.
    // The subtle case that predicate has to get right is the one where the
    // NEAREST ACL re-opens what an ancestor closed: a deny on the folder must
    // not swallow a file inside it that the reader owns outright.
    const { ws, owner, member, ownerKey, memberKey } = await setupTwoMembers();
    const o = { "x-api-key": ownerKey };
    const m = { "x-api-key": memberKey };
    await setNodePrivate({ workspaceId: ws.id, path: "shed", kind: "folder", ownerId: owner.id });
    expect((await putFile(ws.id, o, "shed/theirs.md", V1)).status).toBe(201);
    expect((await putFile(ws.id, o, "shed/mine.md", V1)).status).toBe(201);
    await setNodePrivate({
      workspaceId: ws.id,
      path: "shed/mine.md",
      kind: "file",
      ownerId: member.id,
    });
    const theirs = await created(
      await createComment(ws.id, o, {
        path: "shed/theirs.md",
        body: "hidden",
        quote: QUOTE,
        kind: "range",
      }),
    );
    const mine = await created(
      await createComment(ws.id, m, {
        path: "shed/mine.md",
        body: "visible to me",
        quote: QUOTE,
        kind: "range",
      }),
    );

    const seen = await listComments(ws.id, m);
    expect(seen.body.threads.map((t) => t.id)).toEqual([mine.id]);
    expect(seen.body.total).toBe(1);
    expect((await listComments(ws.id, m, `?threadId=${mine.id}`)).status).toBe(200);
    expect((await listComments(ws.id, m, `?threadId=${theirs.id}`)).status).toBe(404);
    // The owner sees both: the nested file ACL doesn't hide it from them here
    // (they own the folder), and the count matches the rows.
    const all = await listComments(ws.id, o);
    expect(all.body.total).toBe(all.body.threads.length);
  });

  it("a thread id from another workspace is 404 on all three thread routes", async () => {
    const { ws, ws2, key, key2 } = await setup();
    const a = { "x-api-key": key };
    const a2 = { "x-api-key": key2 };
    await putFile(ws.id, a, "x.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "x.md", body: "root", quote: QUOTE, kind: "range" }),
    );

    expect((await reply(ws2.id, a2, t.id, "cross")).status).toBe(404);
    expect((await putResolved(ws2.id, a2, t.id, true)).status).toBe(404);
    expect((await pinnedContent(ws2.id, a2, t.id)).status).toBe(404);
    expect((await listComments(ws2.id, a2, `?threadId=${t.id}`)).status).toBe(404);
  });

  it("session and API key auth both perform all four operations with correct attribution", async () => {
    const { ws, cookie, userId, key, keyId } = await signUpSession();
    const s: Auth = { cookie };
    const k: Auth = { "x-api-key": key };
    expect((await putFile(ws.id, s, "auth.md", V1)).status).toBe(201);

    // Create via cookie session → human, no key id.
    const t = await created(
      await createComment(ws.id, s, {
        path: "auth.md",
        body: "from browser",
        quote: QUOTE,
        kind: "range",
      }),
    );
    expect(t.createdBy).toMatchObject({ principal: "human", actorId: userId, actorKeyId: null });

    // Reply via API key → agent with the key id.
    const rep = await reply(ws.id, k, t.id, "from agent");
    expect(rep.status).toBe(201);
    const repBody = (await rep.json()) as {
      entry: { author: { principal: string; actorKeyId: string } };
    };
    expect(repBody.entry.author.principal).toBe("agent");
    expect(repBody.entry.author.actorKeyId).toBe(keyId);

    // Resolve via cookie, reopen via key; list via both.
    const res = await putResolved(ws.id, s, t.id, true);
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { resolvedBy: { principal: string; actorKeyId: null } };
    expect(resBody.resolvedBy).toMatchObject({ principal: "human", actorKeyId: null });
    expect((await putResolved(ws.id, k, t.id, false)).status).toBe(200);
    expect((await listComments(ws.id, s)).status).toBe(200);
    expect((await listComments(ws.id, k)).status).toBe(200);
    expect((await pinnedContent(ws.id, s, t.id)).status).toBe(200);
  });

  it("workspace delete with threads and entries cascades cleanly", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "z.md", V1);
    const t = await created(
      await createComment(ws.id, a, { path: "z.md", body: "root", quote: QUOTE, kind: "range" }),
    );
    await reply(ws.id, a, t.id, "one");
    await reply(ws.id, a, t.id, "two");

    await db.workspace.delete({ where: { id: ws.id } });
    expect(await db.commentThread.count({ where: { workspaceId: ws.id } })).toBe(0);
    expect(await db.commentEntry.count({ where: { workspaceId: ws.id } })).toBe(0);
  });

  it("body/quote/context size limits and non-markdown paths return structured errors", async () => {
    const { ws, key } = await setup();
    const a = { "x-api-key": key };
    await putFile(ws.id, a, "lim.md", V1);

    const bigBody = await createComment(ws.id, a, {
      path: "lim.md",
      body: "b".repeat(64 * 1024 + 1),
      quote: QUOTE,
      kind: "range",
    });
    expect(bigBody.status).toBe(400);
    expect(((await bigBody.json()) as { error: string }).error).toBe("body_too_large");

    const bigQuote = await createComment(ws.id, a, {
      path: "lim.md",
      body: "note",
      quote: "q".repeat(4 * 1024 + 1),
      kind: "range",
    });
    expect(bigQuote.status).toBe(400);
    expect(((await bigQuote.json()) as { error: string }).error).toBe("quote_too_large");

    const bigCtx = await createComment(ws.id, a, {
      path: "lim.md",
      body: "note",
      quote: QUOTE,
      contextBefore: "c".repeat(513),
      kind: "range",
    });
    expect(bigCtx.status).toBe(400);
    expect(((await bigCtx.json()) as { error: string }).error).toBe("context_too_large");

    const t = await created(
      await createComment(ws.id, a, { path: "lim.md", body: "root", quote: QUOTE, kind: "range" }),
    );
    const bigReply = await reply(ws.id, a, t.id, "r".repeat(64 * 1024 + 1));
    expect(bigReply.status).toBe(400);
    expect(((await bigReply.json()) as { error: string }).error).toBe("body_too_large");

    await fetch(`${BASE}/api/workspaces/${ws.id}/files/plain.txt`, {
      method: "PUT",
      headers: { ...a, "content-type": "text/plain", "if-none-match": "*" },
      body: "just text with beta gamma delta in it",
    });
    const nonMd = await createComment(ws.id, a, {
      path: "plain.txt",
      body: "note",
      quote: QUOTE,
      kind: "range",
    });
    expect(nonMd.status).toBe(400);
    expect(((await nonMd.json()) as { error: string }).error).toBe("not_markdown");

    // Commenting a nonexistent path reads as 404 (fail-as-404 parity).
    const missing = await createComment(ws.id, a, {
      path: "nope.md",
      body: "note",
      quote: QUOTE,
      kind: "range",
    });
    expect(missing.status).toBe(404);
  });

  // Comments are a WRITE path. After the merge with main, billing's read-only
  // state gated FileService.write but not this service, which left a fully
  // writable collaboration channel inside a workspace the billing surface
  // promises is paused.
  //
  // The invariant asserted is PARITY with the file-write gate rather than a
  // hardcoded 402: whether a given deployment's billing config actually
  // produces a read-only workspace is main's concern, not this service's. When
  // it does, all three comment mutations must refuse exactly as a write does;
  // when it doesn't, the gate must be inert rather than half-blocking.
  //
  // Read-only from creation, because the API server caches entitlements for 30s
  // in its OWN process — clearing the cache from here would never reach it.
  it("a read-only workspace refuses create, reply and resolve", async (ctx) => {
    const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    const { user } = await auth.api.signUpEmail({
      body: { email: `ro${stamp}@example.test`, password: "correct-horse-battery", name: "RO" },
    });
    // Created as paid, checkout never finished: no subscription row plus
    // `awaitingPayment` on the org (see plans.ts) is the read-only case.
    const org = await db.organization.create({
      data: {
        id: `org_ro_${stamp}`,
        name: "RO Org",
        metadata: JSON.stringify({ awaitingPayment: true }),
      },
    });
    await db.member.create({
      data: {
        id: `mem_ro_${stamp}`,
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const ws = await db.workspace.create({ data: { organizationId: org.id, name: "Locked" } });
    const key = await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: "ro-agent",
        metadata: { workspaceId: ws.id, actorType: "agent" },
      },
    });
    const a = { "x-api-key": key.key };
    const someThread = "00000000-0000-4000-8000-000000000000";

    await putFile(ws.id, a, "billed.md", V1);
    const create = await createComment(ws.id, a, {
      path: "billed.md",
      body: "gated",
      quote: QUOTE,
      kind: "range",
    });
    // Without the gate, a create is 201 and the two below are 404 (no such
    // thread) — so a 402 on any of them can only have come from the gate.
    const replied = await reply(ws.id, a, someThread, "gated");
    const resolvedRes = await putResolved(ws.id, a, someThread, true);

    // No read-only state exists unless the SERVER runs with BILLING_ENABLED=1,
    // and that is its env, not this process's — so it is detected rather than
    // assumed. Skipped visibly rather than passed vacuously.
    if (create.status !== 402) {
      ctx.skip(
        `server has billing off (create returned ${create.status}); ` +
          "start the api with BILLING_ENABLED=1 to exercise the read-only gate",
      );
      return;
    }

    expect(((await create.json()) as { error: string }).error).toBe("workspace_read_only");
    expect(replied.status).toBe(402);
    expect(resolvedRes.status).toBe(402);

    // Reading stays open — a locked workspace is readable — and none of the
    // three refusals wrote anything or emitted an event.
    expect((await listComments(ws.id, a, "?path=billed.md")).status).toBe(200);
    const feed = await getChanges(ws.id, a, "?sinceSeq=0&includeComments=1&limit=1000");
    expect(feed.changes.filter((c) => c.op.startsWith("comment_"))).toHaveLength(0);

    // Noted, not asserted: main's own write gate did NOT refuse `write` under
    // these exact conditions, though it reads the same `limitsForWorkspace`.
    // That asymmetry is in files.ts, not here, and is reported separately
    // rather than pinned by this suite.
  });
});