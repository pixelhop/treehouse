import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { useTempBlobDir } from "./blob-env";
import "./env";

const BLOB_DIR = useTempBlobDir("treehouse-key-maintenance-");

const { usePrismaClient } = await import("db");
const { keyRotationStoreOf, resolveBlobStore } = await import("../server/utils/storage");
const { resolveKekRing } = await import("../server/utils/workspace-keys");
const {
  DESTROY_GRACE_MS,
  maintenanceSetup,
  resolveRotateBefore,
  rotateBeforeOrError,
  runKeyMaintenance,
} = await import("../server/utils/key-maintenance");
type KeyRotationStore = NonNullable<ReturnType<typeof keyRotationStoreOf>>;

const db = usePrismaClient();
const KEK_OLD = `v1:${randomBytes(32).toString("base64")}`;
const KEK_NEW = `v2:${randomBytes(32).toString("base64")}`;
const HOUR = 60 * 60_000;

const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A store as one API process would build it from its environment. */
function processWith(env: Record<string, string>) {
  const store = resolveBlobStore({ BLOB_DIR, ...env } as NodeJS.ProcessEnv);
  const ring = resolveKekRing(env as NodeJS.ProcessEnv);
  if (!ring) throw new Error("expected a ring");
  return { store, ring, rotation: keyRotationStoreOf(store)! };
}

async function freshWorkspace(): Promise<string> {
  const org = await db.organization.create({
    data: { id: `org_${randomBytes(12).toString("hex")}`, name: "Maintenance" },
  });
  return (await db.workspace.create({ data: { organizationId: org.id, name: "m" } })).id;
}

async function putBlob(
  store: { put: (k: string, b: Uint8Array, t: string) => Promise<void> },
  ws: string,
  size = 1000,
) {
  const body = new Uint8Array(randomBytes(size));
  const key = `${ws}/${hashOf(body)}`;
  await store.put(key, body, "application/octet-stream");
  return { key, body };
}

/** A rotation store that delegates to `base`, with some methods replaced. */
function wrapStore(base: KeyRotationStore, overrides: Partial<KeyRotationStore>): KeyRotationStore {
  return {
    list: (p) => base.list(p),
    listPrefixes: () => base.listPrefixes(),
    delete: (k) => base.delete(k),
    sealedGeneration: (k) => base.sealedGeneration(k),
    verifiedGeneration: (k) => base.verifiedGeneration(k),
    purgeAbandoned: (p, t) => base.purgeAbandoned(p, t),
    forgetKeys: (w) => base.forgetKeys(w),
    reseal: (k) => base.reseal(k),
    ...overrides,
  };
}

/** The bare driver under an encrypting store: what is really stored. */
const innerOf = (store: object) => (store as { inner: ReturnType<typeof resolveBlobStore> }).inner;

async function generationsOf(rotation: KeyRotationStore, keys: string[]) {
  return Promise.all(keys.map((k) => rotation.sealedGeneration(k)));
}

describe("BLOB_DEK_ROTATE_BEFORE", () => {
  it("is absent unless set", () => {
    expect(resolveRotateBefore({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveRotateBefore({ BLOB_DEK_ROTATE_BEFORE: " " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("parses an instant with a time zone", () => {
    expect(
      resolveRotateBefore(
        {
          BLOB_DEK_ROTATE_BEFORE: "2026-10-30T09:00:00Z",
        } as NodeJS.ProcessEnv,
        new Date("2026-10-30T10:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-30T09:00:00.000Z");
  });

  it("allows a few minutes of clock skew but refuses a cutoff in the future", () => {
    const now = new Date("2026-10-30T10:00:00Z");
    const at = (v: string) =>
      resolveRotateBefore({ BLOB_DEK_ROTATE_BEFORE: v } as NodeJS.ProcessEnv, now);
    expect(at("2026-10-30T10:05:00Z")?.toISOString()).toBe("2026-10-30T10:05:00.000Z");
    // A typo'd year would otherwise re-rotate every key on every run until 2027.
    expect(() => at("2027-10-30T10:00:00Z")).toThrow(/in the future/);
    expect(() => at("2026-10-30T10:11:00Z")).toThrow(/in the future/);
  });

  it.each(["2026-10-30", "2026-10-30T09:00:00", "yesterday", "2026-13-45T99:00:00Z"])(
    "refuses %s rather than silently skipping a rotation",
    (value) => {
      expect(() =>
        resolveRotateBefore({ BLOB_DEK_ROTATE_BEFORE: value } as NodeJS.ProcessEnv),
      ).toThrow(/BLOB_DEK_ROTATE_BEFORE/);
    },
  );
});

describe("a bad BLOB_DEK_ROTATE_BEFORE", () => {
  it("is reported, not thrown, so the API stays up and says why nothing rotates", () => {
    expect(
      rotateBeforeOrError({ BLOB_DEK_ROTATE_BEFORE: "2099-01-01T00:00:00Z" } as NodeJS.ProcessEnv),
    ).toEqual({
      rotateBefore: null,
      error: expect.stringMatching(/in the future/),
    });
    expect(rotateBeforeOrError({} as NodeJS.ProcessEnv)).toEqual({
      rotateBefore: null,
      error: null,
    });
  });
});

describe("maintenance setup", () => {
  const fsStore = () => resolveBlobStore({ BLOB_DIR } as NodeJS.ProcessEnv);

  it("has nothing to maintain without encryption", () => {
    expect(maintenanceSetup({} as NodeJS.ProcessEnv, fsStore)).toBeNull();
  });

  it("runs with the ring and the encrypting store", () => {
    const setup = maintenanceSetup({ BLOB_KEK: KEK_NEW } as NodeJS.ProcessEnv, () =>
      resolveBlobStore({ BLOB_DIR, BLOB_KEK: KEK_NEW } as NodeJS.ProcessEnv),
    );
    expect(setup?.options.ring.active.id).toBe("v2");
    expect(setup?.options.rotateBefore).toBeNull();
    expect(setup?.error).toBeNull();
  });

  it("has nothing to maintain when the store does not encrypt", () => {
    expect(maintenanceSetup({ BLOB_KEK: KEK_NEW } as NodeJS.ProcessEnv, fsStore)).toBeNull();
  });

  it("keeps re-sealing but reports a bad cutoff", () => {
    const env = { BLOB_KEK: KEK_NEW, BLOB_DEK_ROTATE_BEFORE: "soon" } as NodeJS.ProcessEnv;
    const setup = maintenanceSetup(env, () =>
      resolveBlobStore({ BLOB_DIR, BLOB_KEK: KEK_NEW } as NodeJS.ProcessEnv),
    );
    expect(setup?.options.rotateBefore).toBeNull();
    expect(setup?.error).toMatch(/BLOB_DEK_ROTATE_BEFORE/);
  });
});

describe("master-key rotation", () => {
  it("re-seals every data key under the new KEK, so the old one can be dropped", async () => {
    const ws = await freshWorkspace();
    const before = processWith({ BLOB_KEK: KEK_OLD });
    const blob = await putBlob(before.store, ws);

    const during = processWith({ BLOB_KEK: KEK_NEW, BLOB_KEK_RETIRED: KEK_OLD });
    const summary = await runKeyMaintenance({
      ...during,
      store: during.rotation,
      rotateBefore: null,
      swept: new Set(),
      only: [ws],
    });
    expect(summary.rewrapped).toBe(1);
    expect(summary.resealed).toBe(0); // no blob is touched

    const after = processWith({ BLOB_KEK: KEK_NEW });
    expect((await after.store.get(blob.key))?.body).toEqual(blob.body);
  });
});

describe("data-key rotation", () => {
  /** A workspace with sealed blobs, then a cutoff after its key was created. */
  async function rotationScenario() {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const blobs = [await putBlob(proc.store, ws), await putBlob(proc.store, ws, 3 * 1024 * 1024)];
    // Written before encryption existed: plain bytes under a content hash.
    const plain = new TextEncoder().encode("legacy plaintext");
    const legacyKey = `${ws}/${hashOf(plain)}`;
    await innerOf(proc.store).put(legacyKey, plain, "text/plain");
    await pause();
    const cutoff = new Date();
    await pause();
    return { ws, proc, blobs, legacyKey, plain, cutoff };
  }

  it("re-encrypts every object under a new generation and keeps the old one for the grace period", async () => {
    const { ws, proc, blobs, legacyKey, plain, cutoff } = await rotationScenario();
    const run = (now?: Date) =>
      runKeyMaintenance({
        ring: proc.ring,
        store: proc.rotation,
        rotateBefore: cutoff,
        swept: new Set(),
        only: [ws],
        now,
      });

    const first = await run();
    expect(first).toMatchObject({
      issued: 1,
      resealed: 3,
      destroyed: 0,
      pendingDestroy: 1,
      errors: 0,
    });
    expect(await generationsOf(proc.rotation, [...blobs.map((b) => b.key), legacyKey])).toEqual([
      2, 2, 2,
    ]);

    // Inside the grace period nothing is destroyed, and nothing is re-issued.
    const again = await run(new Date(Date.now() + DESTROY_GRACE_MS - HOUR));
    expect(again).toMatchObject({ issued: 0, destroyed: 0, pendingDestroy: 1 });

    const later = await run(new Date(Date.now() + DESTROY_GRACE_MS + HOUR));
    expect(later).toMatchObject({ issued: 0, destroyed: 1, pendingDestroy: 0 });
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(1);

    // A process starting cold has only generation 2, and every byte is intact.
    const cold = processWith({ BLOB_KEK: KEK_NEW });
    for (const b of blobs) expect(hashOf((await cold.store.get(b.key))!.body)).toBe(hashOf(b.body));
    expect((await cold.store.get(legacyKey))?.body).toEqual(plain);
  });

  it("re-encrypts a straggler written under the old key before destroying it", async () => {
    const { ws, proc, cutoff } = await rotationScenario();
    // This process has cached generation 1 as current, as another pod would
    // for up to a minute after the rotation.
    const stalePod = processWith({ BLOB_KEK: KEK_NEW });
    await putBlob(stalePod.store, ws);
    const opts = { ring: proc.ring, store: proc.rotation, rotateBefore: cutoff, only: [ws] };

    await runKeyMaintenance({ ...opts, swept: new Set() });
    const straggler = await putBlob(stalePod.store, ws);
    expect(await proc.rotation.sealedGeneration(straggler.key)).toBe(1);

    const later = await runKeyMaintenance({
      ...opts,
      swept: new Set([ws]),
      now: new Date(Date.now() + DESTROY_GRACE_MS + HOUR),
    });
    expect(later.destroyed).toBe(1);
    expect(await proc.rotation.sealedGeneration(straggler.key)).toBe(2);
    expect((await processWith({ BLOB_KEK: KEK_NEW }).store.get(straggler.key))?.body).toEqual(
      straggler.body,
    );
  });

  it("does not destroy a generation an object still needs", async () => {
    const { ws, proc, blobs, cutoff } = await rotationScenario();
    const stuck = blobs[0]!.key;
    // Re-encrypting one object keeps failing (say, a storage error).
    const failing = wrapStore(proc.rotation, {
      reseal: async (k) => {
        if (k === stuck) throw new Error("storage unavailable");
        return proc.rotation.reseal(k);
      },
    });
    const opts = { ring: proc.ring, store: failing, rotateBefore: cutoff, only: [ws] };
    expect((await runKeyMaintenance({ ...opts, swept: new Set() })).errors).toBe(1);

    const later = await runKeyMaintenance({
      ...opts,
      swept: new Set(),
      now: new Date(Date.now() + DESTROY_GRACE_MS + HOUR),
    });
    expect(later).toMatchObject({ errors: 1, destroyed: 0, pendingDestroy: 1 });
    expect(await proc.rotation.sealedGeneration(stuck)).toBe(1);
    expect((await processWith({ BLOB_KEK: KEK_NEW }).store.get(stuck))?.body).toEqual(
      blobs[0]!.body,
    );
  });

  it("leaves a malformed object exactly as it is", async () => {
    const { ws, proc, cutoff } = await rotationScenario();
    const header = new Uint8Array(80);
    header.set([0x54, 0x48, 0x45, 0x00, 0x7f], 0); // the marker, an unknown format version
    const key = `${ws}/${hashOf(new Uint8Array(randomBytes(8)))}`;
    const inner = innerOf(proc.store);
    await inner.put(key, header, "application/octet-stream");

    const summary = await runKeyMaintenance({
      ring: proc.ring,
      store: proc.rotation,
      rotateBefore: cutoff,
      swept: new Set(),
      only: [ws],
    });
    expect(summary.malformed).toBe(1);
    expect((await inner.get(key))?.body).toEqual(header);
  });

  it("encrypts plaintext in a workspace that never had a key", async () => {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const plain = new TextEncoder().encode("from before encryption");
    const key = `${ws}/${hashOf(plain)}`;
    const inner = innerOf(proc.store);
    await inner.put(key, plain, "text/plain");

    const summary = await runKeyMaintenance({
      ring: proc.ring,
      store: proc.rotation,
      rotateBefore: new Date(),
      swept: new Set(),
      only: [ws],
    });
    expect(summary).toMatchObject({ issued: 0, resealed: 1 });
    expect(await proc.rotation.sealedGeneration(key)).toBe(1);
    expect((await proc.store.get(key))?.body).toEqual(plain);
  });

  it("ends in a valid state when two pods rotate at once", async () => {
    const { ws, blobs, legacyKey, plain, cutoff } = await rotationScenario();
    const pods = [processWith({ BLOB_KEK: KEK_NEW }), processWith({ BLOB_KEK: KEK_NEW })];
    const summaries = await Promise.all(
      pods.map((p) =>
        runKeyMaintenance({
          ring: p.ring,
          store: p.rotation,
          rotateBefore: cutoff,
          swept: new Set(),
          only: [ws],
        }),
      ),
    );
    expect(summaries.reduce((n, s) => n + s.issued, 0)).toBe(1);
    expect(summaries.every((s) => s.errors === 0)).toBe(true);
    expect(await db.workspaceKey.count({ where: { workspaceId: ws } })).toBe(2);

    const cold = processWith({ BLOB_KEK: KEK_NEW });
    for (const b of blobs) expect(hashOf((await cold.store.get(b.key))!.body)).toBe(hashOf(b.body));
    expect((await cold.store.get(legacyKey))?.body).toEqual(plain);
  });
});

describe("review round one", () => {
  it("keeps a workspace's old keys while a damaged object might need one", async () => {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const blob = await putBlob(proc.store, ws);
    await pause();
    const cutoff = new Date();
    await pause();
    // Only the format-version byte is damaged: repairing it would make the
    // object readable again, under generation 1.
    const inner = innerOf(proc.store);
    const sealed = new Uint8Array((await inner.get(blob.key))!.body);
    sealed[4] = 0x7f;
    await inner.put(blob.key, sealed, "application/octet-stream");

    const opts = { ring: proc.ring, store: proc.rotation, rotateBefore: cutoff, only: [ws] };
    expect((await runKeyMaintenance({ ...opts, swept: new Set() })).malformed).toBe(1);
    const later = await runKeyMaintenance({
      ...opts,
      swept: new Set(),
      now: new Date(Date.now() + DESTROY_GRACE_MS + HOUR),
    });
    expect(later).toMatchObject({ destroyed: 0, pendingDestroy: 1 });

    sealed[4] = 0x01;
    await inner.put(blob.key, sealed, "application/octet-stream");
    expect((await processWith({ BLOB_KEK: KEK_NEW }).store.get(blob.key))?.body).toEqual(blob.body);
  });

  it("keeps sweeping a plaintext-only workspace until every object is encrypted", async () => {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const inner = innerOf(proc.store);
    const plains = ["one", "two"].map((t) => new TextEncoder().encode(`plaintext ${t}`));
    const keys = plains.map((b) => `${ws}/${hashOf(b)}`);
    for (const [i, b] of plains.entries()) await inner.put(keys[i]!, b, "text/plain");

    let failOnce = true;
    const flaky = wrapStore(proc.rotation, {
      reseal: async (k) => {
        if (k === keys[1] && failOnce) {
          failOnce = false;
          throw new Error("storage unavailable");
        }
        return proc.rotation.reseal(k);
      },
    });
    const swept = new Set<string>();
    const opts = { ring: proc.ring, store: flaky, rotateBefore: new Date(), swept, only: [ws] };
    expect((await runKeyMaintenance(opts)).errors).toBe(1);
    // The first object provisioned generation 1 after the cutoff, so nothing is
    // issued or retired; the failed sweep alone must bring the workspace back.
    expect(await runKeyMaintenance(opts)).toMatchObject({ errors: 0, resealed: 1 });
    expect(await generationsOf(proc.rotation, keys)).toEqual([1, 1]);
  });

  it("purges a deleted workspace's bytes, only after the grace period", async () => {
    const live = await freshWorkspace();
    const gone = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const kept = await putBlob(proc.store, live);
    const lost = [await putBlob(proc.store, gone), await putBlob(proc.store, gone)];
    await db.workspace.delete({ where: { id: gone } });
    await pause();
    const cutoff = new Date();
    const run = (now?: Date) =>
      runKeyMaintenance({
        ring: proc.ring,
        store: proc.rotation,
        rotateBefore: cutoff,
        swept: new Set(),
        only: [live, gone],
        now,
      });

    expect(await run()).toMatchObject({ orphanedPrefixes: 1, purged: 0 });
    expect(await innerOf(proc.store).get(lost[0]!.key)).not.toBeNull();

    expect(await run(new Date(cutoff.getTime() + DESTROY_GRACE_MS + HOUR))).toMatchObject({
      orphanedPrefixes: 1,
      purged: 2,
    });
    for (const b of lost) expect(await innerOf(proc.store).get(b.key)).toBeNull();
    expect((await proc.store.get(kept.key))?.body).toEqual(kept.body);
  });
});

describe("review round two", () => {
  /** A workspace with one blob under generation 1, rotated, then damaged. */
  async function damagedAfterRotation(damage: (sealed: Uint8Array) => void) {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const blob = await putBlob(proc.store, ws);
    await pause();
    const cutoff = new Date();
    await pause();
    const inner = innerOf(proc.store);
    const original = new Uint8Array((await inner.get(blob.key))!.body);
    const damaged = new Uint8Array(original);
    damage(damaged);
    await inner.put(blob.key, damaged, "application/octet-stream");
    const opts = { ring: proc.ring, store: proc.rotation, rotateBefore: cutoff, only: [ws] };
    await runKeyMaintenance({ ...opts, swept: new Set() });
    const later = await runKeyMaintenance({
      ...opts,
      swept: new Set(),
      now: new Date(Date.now() + DESTROY_GRACE_MS + HOUR),
    });
    // Repair the header: the object must open again, under generation 1.
    await inner.put(blob.key, original, "application/octet-stream");
    const reread = await processWith({ BLOB_KEK: KEK_NEW }).store.get(blob.key);
    return { later, reread, blob };
  }

  it("keeps the old key when a header's generation field claims the current one", async () => {
    const { later, reread, blob } = await damagedAfterRotation((b) => {
      new DataView(b.buffer).setUint32(5, 2, false); // generation 1 -> 2
    });
    expect(later.destroyed).toBe(0);
    expect(reread?.body).toEqual(blob.body);
  });

  it("keeps the old key when damaged magic makes an object look like plaintext", async () => {
    const { later, reread, blob } = await damagedAfterRotation((b) => {
      b[0] = 0x00;
    });
    expect(later.destroyed).toBe(0);
    expect(reread?.body).toEqual(blob.body);
  });
});

describe("review round four", () => {
  it("rotates healthy workspaces when another's scan fails, and keeps that one's keys", async () => {
    const broken = await freshWorkspace();
    const healthy = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const stuck = await putBlob(proc.store, broken);
    const fine = await putBlob(proc.store, healthy);
    await pause();
    const cutoff = new Date();
    await pause();
    const { chmod } = await import("node:fs/promises");
    // Readable but not searchable: listing its objects fails with EACCES.
    await chmod(`${BLOB_DIR}/${broken}`, 0o444);
    try {
      const opts = {
        ring: proc.ring,
        store: proc.rotation,
        rotateBefore: cutoff,
        only: [broken, healthy],
      };
      const first = await runKeyMaintenance({ ...opts, swept: new Set() });
      expect(first.errors).toBeGreaterThanOrEqual(1);
      expect(await proc.rotation.sealedGeneration(fine.key)).toBe(2);

      const later = await runKeyMaintenance({
        ...opts,
        swept: new Set(),
        now: new Date(Date.now() + DESTROY_GRACE_MS + HOUR),
      });
      expect(later.destroyed).toBe(1); // the healthy workspace's old key only
      expect(
        await db.workspaceKey.count({ where: { workspaceId: broken, retiredAt: { not: null } } }),
      ).toBe(1);
    } finally {
      await chmod(`${BLOB_DIR}/${broken}`, 0o755);
    }
    expect((await processWith({ BLOB_KEK: KEK_NEW }).store.get(stuck.key))?.body).toEqual(
      stuck.body,
    );
  });
});

describe("review round five", () => {
  it("removes a half-written blob left by an interrupted write", async () => {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const blob = await putBlob(proc.store, ws);
    // A process killed mid-write leaves its temporary file behind, sealed
    // under generation 1 and invisible to listings.
    const { copyFile, readdir, utimes } = await import("node:fs/promises");
    const partial = `${BLOB_DIR}/${blob.key}.partial-interrupted`;
    await copyFile(`${BLOB_DIR}/${blob.key}`, partial);
    const longAgo = new Date(Date.now() - 2 * DESTROY_GRACE_MS);
    await utimes(partial, longAgo, longAgo);
    await pause();
    const cutoff = new Date();
    await pause();

    const opts = { ring: proc.ring, store: proc.rotation, rotateBefore: cutoff, only: [ws] };
    // The rotation's first run already removes an abandoned leftover.
    expect(await runKeyMaintenance({ ...opts, swept: new Set() })).toMatchObject({ purged: 1 });
    expect((await readdir(`${BLOB_DIR}/${ws}`)).filter((n) => n.includes(".partial-"))).toEqual([]);

    const later = await runKeyMaintenance({
      ...opts,
      swept: new Set(),
      now: new Date(Date.now() + DESTROY_GRACE_MS + HOUR),
    });
    expect(later).toMatchObject({ destroyed: 1, recentLeftovers: 0 });
  });
});

describe("review round six", () => {
  it("keeps the old key while a recent leftover might still be under it, then cleans up", async () => {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const blob = await putBlob(proc.store, ws);
    await pause();
    const cutoff = new Date();
    await pause();
    const opts = { ring: proc.ring, store: proc.rotation, rotateBefore: cutoff, only: [ws] };
    await runKeyMaintenance({ ...opts, swept: new Set() });

    // A stale pod's interrupted write, just after the rotation: by the time
    // the grace period is over it is still younger than the grace period.
    const destroyAt = new Date(Date.now() + DESTROY_GRACE_MS + 30_000);
    const { copyFile, readdir, utimes } = await import("node:fs/promises");
    const partial = `${BLOB_DIR}/${blob.key}.partial-stale-pod`;
    await copyFile(`${BLOB_DIR}/${blob.key}`, partial);
    const written = new Date(destroyAt.getTime() - 10 * 60_000);
    await utimes(partial, written, written);

    const blocked = await runKeyMaintenance({ ...opts, swept: new Set(), now: destroyAt });
    expect(blocked).toMatchObject({ destroyed: 0, pendingDestroy: 1, purged: 0 });

    const later = await runKeyMaintenance({
      ...opts,
      swept: new Set(),
      now: new Date(destroyAt.getTime() + 2 * HOUR),
    });
    expect(later).toMatchObject({ destroyed: 1, pendingDestroy: 0, purged: 1 });
    expect((await readdir(`${BLOB_DIR}/${ws}`)).filter((n) => n.includes(".partial-"))).toEqual([]);
  });

  it("purges every other deleted workspace when one cannot be read", async () => {
    const broken = await freshWorkspace();
    const healthy = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    await putBlob(proc.store, broken);
    const lost = await putBlob(proc.store, healthy);
    await db.workspace.delete({ where: { id: broken } });
    await db.workspace.delete({ where: { id: healthy } });
    const cutoff = new Date();
    const { chmod } = await import("node:fs/promises");
    await chmod(`${BLOB_DIR}/${broken}`, 0o444);
    try {
      const summary = await runKeyMaintenance({
        ring: proc.ring,
        store: proc.rotation,
        rotateBefore: cutoff,
        swept: new Set(),
        only: [broken, healthy],
        now: new Date(cutoff.getTime() + DESTROY_GRACE_MS + HOUR),
      });
      expect(summary).toMatchObject({ orphanedPrefixes: 2, errors: 1 });
      expect(summary.purged).toBeGreaterThanOrEqual(1);
      expect(await innerOf(proc.store).get(lost.key)).toBeNull();
    } finally {
      await chmod(`${BLOB_DIR}/${broken}`, 0o755);
    }
  });
});

describe("review round seven", () => {
  it("removes an abandoned plaintext leftover in a workspace that never had a key", async () => {
    const ws = await freshWorkspace();
    const proc = processWith({ BLOB_KEK: KEK_NEW });
    const { mkdir, readdir, utimes, writeFile } = await import("node:fs/promises");
    await mkdir(`${BLOB_DIR}/${ws}`, { recursive: true });
    const leftover = `${BLOB_DIR}/${ws}/${hashOf(new Uint8Array([1]))}.partial-old-upload`;
    await writeFile(leftover, "plaintext from before encryption");
    const old = new Date(Date.now() - 3 * HOUR);
    await utimes(leftover, old, old);
    const recent = `${BLOB_DIR}/${ws}/${hashOf(new Uint8Array([2]))}.partial-in-flight`;
    await writeFile(recent, "maybe still being written");

    const summary = await runKeyMaintenance({
      ring: proc.ring,
      store: proc.rotation,
      rotateBefore: new Date(),
      swept: new Set(),
      only: [ws],
    });
    expect(summary).toMatchObject({ purged: 1, recentLeftovers: 1, pendingDestroy: 0 });
    expect(await readdir(`${BLOB_DIR}/${ws}`)).toEqual([
      `${hashOf(new Uint8Array([2]))}.partial-in-flight`,
    ]);
  });
});