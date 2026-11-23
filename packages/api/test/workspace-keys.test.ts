import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { useTempBlobDir } from "./blob-env";
import "./env";

useTempBlobDir("treehouse-keys-");

const { usePrismaClient } = await import("db");
const {
  createWorkspaceKeyService,
  CURRENT_GENERATION_TTL_MS,
  destroyGeneration,
  issueGeneration,
  resolveKekRing,
  retiredGenerations,
  rewrapRetiredKeys,
  WorkspaceKeyError,
} = await import("../server/utils/workspace-keys");

const db = usePrismaClient();

const KEK_A = randomBytes(32).toString("base64");
const KEK_B = randomBytes(32).toString("base64");

function ringFrom(env: Record<string, string | undefined>) {
  const ring = resolveKekRing(env as NodeJS.ProcessEnv);
  if (!ring) throw new Error("expected a ring");
  return ring;
}

const firstGeneration = (workspaceId: string) => ({
  workspaceId_generation: { workspaceId, generation: 1 },
});

async function freshWorkspace(): Promise<string> {
  const org = await db.organization.create({
    data: { id: `org_${randomBytes(12).toString("hex")}`, name: "Keys" },
  });
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: "keys" } });
  return ws.id;
}

describe("KEK ring resolution", () => {
  it("returns null when unconfigured outside production (dev keeps working)", () => {
    expect(resolveKekRing({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("fails closed in production when unconfigured", () => {
    expect(() => resolveKekRing({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /BLOB_KEK is not set/,
    );
  });

  it("parses an active key", () => {
    const ring = ringFrom({ BLOB_KEK: `v1:${KEK_A}` });
    expect(ring.active.id).toBe("v1");
    expect(ring.active.key.byteLength).toBe(32);
  });

  it("makes retired keys available for unwrapping only", () => {
    const ring = ringFrom({ BLOB_KEK: `v2:${KEK_B}`, BLOB_KEK_RETIRED: `v1:${KEK_A}` });
    expect(ring.active.id).toBe("v2");
    expect([...ring.byId.keys()].sort()).toEqual(["v1", "v2"]);
  });

  it("never lets a retired entry shadow the active key", () => {
    const ring = ringFrom({ BLOB_KEK: `v1:${KEK_A}`, BLOB_KEK_RETIRED: `v1:${KEK_B}` });
    expect(ring.byId.get("v1")).toEqual(ring.active.key);
  });

  it.each([
    ["no id separator", "abcdef"],
    ["empty id", `:${KEK_A}`],
    ["empty key", "v1:"],
    ["key of the wrong length", `v1:${randomBytes(16).toString("base64")}`],
    ["not base64 at all", "v1:!!!!not-base64!!!!"],
  ])("rejects a malformed active key (%s)", (_label, value) => {
    expect(() => resolveKekRing({ BLOB_KEK: value } as NodeJS.ProcessEnv)).toThrow(
      WorkspaceKeyError,
    );
  });

  it("rejects a malformed retired entry", () => {
    expect(() =>
      resolveKekRing({
        BLOB_KEK: `v2:${KEK_B}`,
        BLOB_KEK_RETIRED: "garbage",
      } as NodeJS.ProcessEnv),
    ).toThrow(/BLOB_KEK_RETIRED/);
  });

  it("tolerates trailing separators in the retired list", () => {
    const ring = ringFrom({ BLOB_KEK: `v2:${KEK_B}`, BLOB_KEK_RETIRED: `v1:${KEK_A},` });
    expect(ring.byId.size).toBe(2);
  });
});

describe("workspace data keys", () => {
  const svc = () => createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v1:${KEK_A}` }));

  it("provisions a key on first use and reuses it thereafter", async () => {
    const ws = await freshWorkspace();
    const service = svc();
    const first = await service.dekFor(ws);
    const second = await service.dekFor(ws);

    expect(first.dek.byteLength).toBe(32);
    expect(second.dek).toEqual(first.dek);
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(1);
  });

  it("returns the same key from a cold service (unwrap path, not cache)", async () => {
    const ws = await freshWorkspace();
    const warm = await svc().dekFor(ws);
    const cold = await svc().dekFor(ws);
    expect(cold.dek).toEqual(warm.dek);
  });

  it("gives different workspaces different keys", async () => {
    const service = svc();
    const a = await service.dekFor(await freshWorkspace());
    const b = await service.dekFor(await freshWorkspace());
    expect(a.dek).not.toEqual(b.dek);
  });

  it("provisions exactly once under concurrent first use", async () => {
    const ws = await freshWorkspace();
    // Separate service instances so neither can serve the other from cache —
    // the race has to be resolved in the database.
    const results = await Promise.all([
      svc().dekFor(ws),
      svc().dekFor(ws),
      svc().dekFor(ws),
      svc().dekFor(ws),
    ]);
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(1);
    for (const r of results) expect(r.dek).toEqual(results[0]?.dek);
  });

  it("starts at generation 1", async () => {
    expect((await svc().dekFor(await freshWorkspace())).generation).toBe(1);
  });

  it("unwraps a key sealed under a since-retired KEK", async () => {
    const ws = await freshWorkspace();
    const before = await createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v1:${KEK_A}` })).dekFor(
      ws,
    );

    // v1 is retired, v2 becomes active — the existing row must still open.
    const after = await createWorkspaceKeyService(
      ringFrom({ BLOB_KEK: `v2:${KEK_B}`, BLOB_KEK_RETIRED: `v1:${KEK_A}` }),
    ).dekFor(ws);

    expect(after.dek).toEqual(before.dek);
  });

  it("refuses to open a key whose KEK is not in the ring", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    const stranded = createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v9:${KEK_B}` }));
    await expect(stranded.dekFor(ws)).rejects.toThrow(/unknown key/);
  });

  it("refuses to open a key with the wrong KEK material under a known id", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    // Same key id, different bytes — the tag must catch this.
    const wrong = createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v1:${KEK_B}` }));
    await expect(wrong.dekFor(ws)).rejects.toThrow(WorkspaceKeyError);
  });

  it("refuses to open a tampered wrapped key", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    const row = await db.workspaceKey.findUniqueOrThrow({ where: firstGeneration(ws) });
    const tampered = Buffer.from(row.wrappedDek);
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;
    await db.workspaceKey.update({ where: firstGeneration(ws), data: { wrappedDek: tampered } });

    await expect(svc().dekFor(ws)).rejects.toThrow(WorkspaceKeyError);
  });

  it("refuses to open a wrapped key moved from another workspace", async () => {
    // The wrap is bound to its workspace id, so copying a row's bytes onto a
    // different workspace must not redirect that workspace's files.
    const source = await freshWorkspace();
    const target = await freshWorkspace();
    const service = svc();
    await service.dekFor(source);
    await service.dekFor(target);
    const stolen = await db.workspaceKey.findUniqueOrThrow({ where: firstGeneration(source) });
    await db.workspaceKey.update({
      where: firstGeneration(target),
      data: { wrappedDek: stolen.wrappedDek, kekId: stolen.kekId },
    });

    await expect(svc().dekFor(target)).rejects.toThrow(WorkspaceKeyError);
  });

  it("crypto-shreds: deleting the workspace removes its key by cascade", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(1);

    await db.workspace.delete({ where: { id: ws } });
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(0);
  });
});

describe("data-key generations", () => {
  const ringA = () => ringFrom({ BLOB_KEK: `v1:${KEK_A}` });
  const svc = (clock?: () => number) => createWorkspaceKeyService(ringA(), clock);
  // A cutoff after every key the test has created, so each one counts as due.
  // Computed per call: one taken at load goes stale on a busy machine.
  const afterNow = () => new Date(Date.now() + 60_000);

  it("issues a new generation for writes and keeps the old one readable", async () => {
    const ws = await freshWorkspace();
    const first = await svc().dekFor(ws);

    expect((await issueGeneration(ringA(), ws, afterNow()))?.generation).toBe(2);

    const service = svc();
    const current = await service.dekFor(ws);
    expect(current.generation).toBe(2);
    expect(current.dek).not.toEqual(first.dek);
    expect((await service.dekForGeneration(ws, 1))?.dek).toEqual(first.dek);
  });

  it("marks the replaced generation retired, and only that one", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    const at = new Date("2026-10-29T10:00:00Z");
    await issueGeneration(ringA(), ws, afterNow(), at);

    const rows = await db.workspaceKey.findMany({
      where: { workspaceId: ws },
      orderBy: { generation: "asc" },
    });
    expect(rows.map((r) => [r.generation, r.retiredAt?.toISOString() ?? null])).toEqual([
      [1, at.toISOString()],
      [2, null],
    ]);
  });

  it("does not issue again once the key in use is newer than the cutoff", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 20));
    expect(await issueGeneration(ringA(), ws, cutoff)).toEqual({ generation: 2, issued: true });
    expect(await issueGeneration(ringA(), ws, cutoff)).toEqual({ generation: 2, issued: false });
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(2);
  });

  it("issues exactly one generation when several processes rotate at once", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    // A cutoff between generation 1 and the rotation, as an operator's is: a
    // generation one process issues is then newer than the cutoff for the rest.
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const results = await Promise.all(
      Array.from({ length: 4 }, () => issueGeneration(ringA(), ws, cutoff)),
    );
    expect(results.map((r) => r?.generation)).toEqual([2, 2, 2, 2]);
    expect(results.filter((r) => r?.issued)).toHaveLength(1);
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(2);
  });

  it("has nothing to rotate for a workspace that never stored a blob", async () => {
    expect(await issueGeneration(ringA(), await freshWorkspace(), afterNow())).toBeNull();
  });

  it("answers null, not an error, for a generation the workspace does not have", async () => {
    const ws = await freshWorkspace();
    const service = svc();
    await service.dekFor(ws);
    expect(await service.dekForGeneration(ws, 7)).toBeNull();
    expect(await service.dekForGeneration(ws, 0)).toBeNull();
    // A u32 from a lookalike header can exceed Postgres's integer range.
    expect(await service.dekForGeneration(ws, 4_000_000_000)).toBeNull();
  });

  it("notices a generation issued elsewhere once its cached pointer expires", async () => {
    const ws = await freshWorkspace();
    let now = 1_000_000;
    const service = svc(() => now);
    expect((await service.dekFor(ws)).generation).toBe(1);

    await issueGeneration(ringA(), ws, afterNow());
    // Still within the window: this process keeps writing under generation 1.
    now += CURRENT_GENERATION_TTL_MS - 1;
    expect((await service.dekFor(ws)).generation).toBe(1);
    now += 1;
    expect((await service.dekFor(ws)).generation).toBe(2);
  });

  it("lists retired generations only once they are older than the cutoff", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    const at = new Date("2026-10-29T10:00:00Z");
    await issueGeneration(ringA(), ws, afterNow(), at);
    expect(await retiredGenerations(ws, at)).toEqual([]);
    expect(await retiredGenerations(ws, new Date(at.getTime() + 1))).toEqual([1]);
  });

  it("destroys a retired generation, never the one in use", async () => {
    const ws = await freshWorkspace();
    await svc().dekFor(ws);
    await issueGeneration(ringA(), ws, afterNow());

    expect(await destroyGeneration(ws, 2)).toBe(false);
    expect(await destroyGeneration(ws, 1)).toBe(true);
    expect(await svc().dekForGeneration(ws, 1)).toBeNull();
    expect((await svc().dekFor(ws)).generation).toBe(2);
  });

  it("evicts an expired key that nothing asks for again", async () => {
    const ws = await freshWorkspace();
    let now = 1_000_000;
    const service = svc(() => now);
    await service.dekFor(ws);
    await issueGeneration(ringA(), ws, afterNow());
    await service.dekForGeneration(ws, 1);
    expect(service.cachedKeyCount()).toBe(1);

    // Generation 1 is never looked up again; other keys keep being used.
    now += 2 * 60 * 60_000;
    await service.dekFor(await freshWorkspace());
    service.evictExpired();
    expect(service.cachedKeyCount()).toBe(1); // only the fresh workspace's key
  });

  it("does not hand back a destroyed generation from a fresh cache", async () => {
    const ws = await freshWorkspace();
    const service = svc();
    await service.dekFor(ws);
    await issueGeneration(ringA(), ws, afterNow());
    await destroyGeneration(ws, 1);
    service.forget(ws);
    expect(await service.dekForGeneration(ws, 1)).toBeNull();
  });
});

describe("re-sealing under a new KEK", () => {
  const ringOld = () => ringFrom({ BLOB_KEK: `v1:${KEK_A}` });
  const ringNew = () => ringFrom({ BLOB_KEK: `v2:${KEK_B}`, BLOB_KEK_RETIRED: `v1:${KEK_A}` });

  it("moves every row to the active KEK without changing the data keys", async () => {
    const ws = await freshWorkspace();
    const before = await createWorkspaceKeyService(ringOld()).dekFor(ws);
    await issueGeneration(ringOld(), ws, new Date(Date.now() + 60_000));
    const second = await createWorkspaceKeyService(ringOld()).dekFor(ws);

    const { rewrapped } = await rewrapRetiredKeys(ringNew());
    expect(rewrapped).toBeGreaterThanOrEqual(2);
    expect(
      (await db.workspaceKey.findMany({ where: { workspaceId: ws } })).map((r) => r.kekId),
    ).toEqual(["v2", "v2"]);

    // Opens with the new KEK alone: the old one can now be dropped.
    const onlyNew = createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v2:${KEK_B}` }));
    expect((await onlyNew.dekForGeneration(ws, 1))?.dek).toEqual(before.dek);
    expect((await onlyNew.dekFor(ws)).dek).toEqual(second.dek);
  });

  it("is a no-op the second time", async () => {
    const ws = await freshWorkspace();
    await createWorkspaceKeyService(ringOld()).dekFor(ws);
    await rewrapRetiredKeys(ringNew());
    const rows = await db.workspaceKey.findMany({ where: { workspaceId: ws } });
    await rewrapRetiredKeys(ringNew());
    expect(await db.workspaceKey.findMany({ where: { workspaceId: ws } })).toEqual(rows);
  });

  it("leaves a row under a KEK it does not hold untouched, and counts it", async () => {
    const ws = await freshWorkspace();
    await createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v7:${KEK_A}` })).dekFor(ws);
    const { unknownKek } = await rewrapRetiredKeys(ringNew());
    expect(unknownKek).toBeGreaterThanOrEqual(1);
    const row = await db.workspaceKey.findUniqueOrThrow({ where: firstGeneration(ws) });
    expect(row.kekId).toBe("v7");
  });

  it("leaves every row valid when two processes re-seal at once", async () => {
    const ws = await freshWorkspace();
    const before = await createWorkspaceKeyService(ringOld()).dekFor(ws);
    await Promise.all([rewrapRetiredKeys(ringNew()), rewrapRetiredKeys(ringNew())]);
    const reopened = await createWorkspaceKeyService(ringFrom({ BLOB_KEK: `v2:${KEK_B}` })).dekFor(
      ws,
    );
    expect(reopened.dek).toEqual(before.dek);
  });
});