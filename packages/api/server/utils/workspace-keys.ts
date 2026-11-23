import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { buildKeyRing, type KeyRing } from "blob-io/key-ring";
import { usePrismaClient } from "db";

// ---------------------------------------------------------------------------
// Envelope key management for file-byte encryption at rest.
//
// Every workspace has its own data key (DEK). The DEK is stored only wrapped —
// sealed under a master key (KEK) that lives in the environment and never in
// the database or the bucket. So a database dump is inert on its own, and a
// bucket leak is inert on its own; an attacker needs both plus the API's
// environment.
//
// Two consequences worth stating plainly:
//   * Rotating the KEK re-wraps rows in this table and touches no blob. That is
//     the whole reason for the envelope — a single flat master key would mean
//     re-encrypting every blob or keeping the old key alive forever.
//   * Losing the KEK loses every file, permanently. There is no recovery path.
// ---------------------------------------------------------------------------

const KEY_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAPPED_BYTES = WRAP_NONCE_BYTES + KEY_BYTES + WRAP_TAG_BYTES;

/**
 * Unwrapped DEKs are held in memory so a page embedding many images does not
 * add a database round-trip per image. The cap is a leak guard, not a tuning
 * knob: workspace counts are far below it, and a plain clear() is fine because
 * the only cost of a miss is one query.
 */
const MAX_CACHED_DEKS = 1000;

/** A key was missing, malformed, or failed to unwrap. Never a "not found". */
export class WorkspaceKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceKeyError";
  }
}

/** The KEK new DEKs are wrapped under, and every KEK still accepted for unwrapping. */
export type KekRing = KeyRing;

/**
 * Build the KEK ring from the environment, or return null when encryption is
 * not configured (dev convenience — the blob store then stores plaintext, as
 * it did before this feature).
 *
 * Fails closed in production: an unset KEK there would silently downgrade every
 * workspace to plaintext at rest, which is the exact outcome this feature
 * exists to prevent. Mirrors the guards on SHARE_COOKIE_SECRET and BLOB_DIR.
 */
export function resolveKekRing(env: NodeJS.ProcessEnv = process.env): KekRing | null {
  const raw = env.BLOB_KEK?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new WorkspaceKeyError(
        "BLOB_KEK is not set. In production the API refuses to boot without it, " +
          "so file bytes are never silently written to storage unencrypted. " +
          'Generate one with: printf "v1:$(openssl rand -base64 32)"',
      );
    }
    return null;
  }

  return buildKeyRing(raw, env.BLOB_KEK_RETIRED, (which) =>
    which === "active"
      ? new WorkspaceKeyError(
          "BLOB_KEK is malformed. Expected `<id>:<base64>` where the decoded key is " +
            `exactly ${KEY_BYTES} bytes. Generate one with: printf "v1:$(openssl rand -base64 32)"`,
        )
      : new WorkspaceKeyError(
          "BLOB_KEK_RETIRED contains a malformed entry. Expected a comma-separated " +
            "list of `<id>:<base64>`.",
        ),
  );
}

/**
 * Seal a DEK under a KEK, binding it to its workspace. The binding means a
 * wrapped DEK copied onto another workspace's row will not unwrap, so row
 * substitution in a compromised database cannot redirect a workspace's files.
 */
function wrapDek(dek: Uint8Array, kek: Uint8Array, workspaceId: string): Uint8Array<ArrayBuffer> {
  const nonce = randomBytes(WRAP_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(Buffer.from(workspaceId, "utf8"));
  const sealed = Buffer.concat([cipher.update(dek), cipher.final()]);
  // Allocated by length rather than wrapped around a Buffer: Prisma's Bytes
  // field wants a Uint8Array backed by a plain ArrayBuffer, and Buffer's is
  // typed ArrayBufferLike.
  const out = new Uint8Array(WRAPPED_BYTES);
  out.set(nonce, 0);
  out.set(sealed, WRAP_NONCE_BYTES);
  out.set(cipher.getAuthTag(), WRAP_NONCE_BYTES + sealed.byteLength);
  return out;
}

function unwrapDek(wrapped: Uint8Array, kek: Uint8Array, workspaceId: string): Uint8Array {
  if (wrapped.byteLength !== WRAPPED_BYTES) {
    throw new WorkspaceKeyError(
      `wrapped data key is ${wrapped.byteLength} bytes, expected ${WRAPPED_BYTES}`,
    );
  }
  const nonce = wrapped.subarray(0, WRAP_NONCE_BYTES);
  const sealed = wrapped.subarray(WRAP_NONCE_BYTES, WRAPPED_BYTES - WRAP_TAG_BYTES);
  const tag = wrapped.subarray(WRAPPED_BYTES - WRAP_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAAD(Buffer.from(workspaceId, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(sealed), decipher.final()]));
  } catch (cause) {
    throw new WorkspaceKeyError("wrapped data key failed to unwrap", { cause });
  }
}

export interface WorkspaceDek {
  dek: Uint8Array;
  generation: number;
}

export interface WorkspaceKeyService {
  /** The data key new writes use (the highest generation), provisioning one on first use. */
  dekFor(workspaceId: string): Promise<WorkspaceDek>;
  /**
   * The data key of one generation, for reading a blob written under it. Null
   * when the workspace has no such generation: never issued, or destroyed
   * after a rotation. A blob's header names its generation, and a legacy
   * plaintext file can begin with bytes that look like a header, so an unknown
   * generation is an answer, not an error.
   */
  dekForGeneration(workspaceId: string, generation: number): Promise<WorkspaceDek | null>;
  /** Drop cached keys, so the next lookup reads the database. */
  forget(workspaceId?: string): void;
  /**
   * Drop every cached key older than its time to live. Runs on a timer too, so
   * a key nothing asks for again still leaves memory: a generation destroyed by
   * another pod must not live on here.
   */
  evictExpired(): void;
  /** How many unwrapped keys are held in memory. */
  cachedKeyCount(): number;
}

/**
 * How long a process trusts its idea of which generation is current. A
 * rotation on another pod issues a new generation; this bounds how long this
 * pod keeps writing under the old one. Key maintenance waits far longer than
 * this before destroying a generation (see key-maintenance.ts).
 */
export const CURRENT_GENERATION_TTL_MS = 60_000;

/**
 * How long an unwrapped key stays in memory. Generations never change once
 * issued, so this is not about staleness: it bounds how long a destroyed
 * generation's key outlives its row in a running process.
 */
const CACHED_KEY_TTL_MS = 60 * 60_000;

/** How often cached keys are checked for expiry without anyone asking for them. */
const EVICT_EVERY_MS = 5 * 60_000;

/** Postgres `integer`. A header's u32 generation can exceed it; no row can. */
const MAX_GENERATION = 2_147_483_647;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

type KeyRow = { kekId: string; wrappedDek: Uint8Array; generation: number };

function unsealRow(ring: KekRing, row: KeyRow, ws: string): WorkspaceDek {
  const kek = ring.byId.get(row.kekId);
  if (!kek) {
    throw new WorkspaceKeyError(
      `workspace ${ws} is sealed under unknown key "${row.kekId}". Add it to ` +
        "BLOB_KEK or BLOB_KEK_RETIRED — its files cannot be read without it.",
    );
  }
  return { dek: unwrapDek(row.wrappedDek, kek, ws), generation: row.generation };
}

/** The highest generation's row: the one new writes use. */
function currentRow(workspaceId: string) {
  return usePrismaClient().workspaceKey.findFirst({
    where: { workspaceId },
    orderBy: { generation: "desc" },
  });
}

export function createWorkspaceKeyService(
  ring: KekRing,
  clock: () => number = Date.now,
): WorkspaceKeyService {
  // Prisma is resolved lazily, not at construction: the blob store builds this
  // service while merely *selecting* a driver, and boot-guard paths that never
  // read a file should not drag a database client into existence.
  const keys = new Map<string, { dek: Uint8Array; at: number }>();
  const current = new Map<string, { generation: number; at: number }>();
  const slot = (ws: string, generation: number) => `${ws}:${generation}`;

  function evictExpired(): void {
    const now = clock();
    for (const [k, hit] of keys) if (now - hit.at >= CACHED_KEY_TTL_MS) keys.delete(k);
    for (const [ws, hit] of current)
      if (now - hit.at >= CURRENT_GENERATION_TTL_MS) current.delete(ws);
  }
  setInterval(evictExpired, EVICT_EVERY_MS).unref();

  function remember(workspaceId: string, entry: WorkspaceDek, isCurrent: boolean): WorkspaceDek {
    if (keys.size >= MAX_CACHED_DEKS) keys.clear();
    if (current.size >= MAX_CACHED_DEKS) current.clear();
    const at = clock();
    keys.set(slot(workspaceId, entry.generation), { dek: entry.dek, at });
    if (isCurrent) current.set(workspaceId, { generation: entry.generation, at });
    return entry;
  }

  function cachedKey(workspaceId: string, generation: number): Uint8Array | null {
    const hit = keys.get(slot(workspaceId, generation));
    if (!hit) return null;
    if (clock() - hit.at >= CACHED_KEY_TTL_MS) {
      keys.delete(slot(workspaceId, generation));
      return null;
    }
    return hit.dek;
  }

  return {
    async dekFor(workspaceId) {
      const pointer = current.get(workspaceId);
      if (pointer && clock() - pointer.at < CURRENT_GENERATION_TTL_MS) {
        const dek = cachedKey(workspaceId, pointer.generation);
        if (dek) return { dek, generation: pointer.generation };
      }

      const existing = await currentRow(workspaceId);
      if (existing) return remember(workspaceId, unsealRow(ring, existing, workspaceId), true);

      const dek = new Uint8Array(randomBytes(KEY_BYTES));
      try {
        const created = await usePrismaClient().workspaceKey.create({
          data: {
            workspaceId,
            kekId: ring.active.id,
            wrappedDek: wrapDek(dek, ring.active.key, workspaceId),
          },
        });
        return remember(workspaceId, { dek, generation: created.generation }, true);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A concurrent first write provisioned it under us. Adopt theirs — two
        // different DEKs for one workspace would leave half its blobs orphaned.
        const won = await currentRow(workspaceId);
        if (!won) {
          throw new WorkspaceKeyError(
            `lost the race to provision a data key for workspace ${workspaceId}, ` +
              "but the winning row is not readable",
          );
        }
        return remember(workspaceId, unsealRow(ring, won, workspaceId), true);
      }
    },

    async dekForGeneration(workspaceId, generation) {
      if (!Number.isInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
        return null;
      }
      const dek = cachedKey(workspaceId, generation);
      if (dek) return { dek, generation };
      const row = await usePrismaClient().workspaceKey.findUnique({
        where: { workspaceId_generation: { workspaceId, generation } },
      });
      if (!row) return null;
      return remember(workspaceId, unsealRow(ring, row, workspaceId), false);
    },

    forget(workspaceId) {
      if (workspaceId === undefined) {
        keys.clear();
        current.clear();
        return;
      }
      current.delete(workspaceId);
      for (const k of keys.keys()) if (k.startsWith(`${workspaceId}:`)) keys.delete(k);
    },

    evictExpired,

    cachedKeyCount: () => keys.size,
  };
}

// ---------------------------------------------------------------------------
// Rotation. Every operation here is safe to repeat and safe to run on several
// processes at once; key-maintenance.ts drives them.
// ---------------------------------------------------------------------------

/**
 * Re-seal every data key that is not sealed under the active KEK. Touches no
 * blob: the data keys themselves are unchanged. Each update is a compare-and-set
 * on the row's current KEK, so two processes re-sealing the same row cannot
 * both win, and both outcomes are valid anyway. A row under a KEK the ring does
 * not hold, or one that will not unseal, is counted and left alone: unreadable
 * here, never deleted, and never a reason to stop re-sealing the others.
 */
export async function rewrapRetiredKeys(
  ring: KekRing,
  only?: string[],
): Promise<{ rewrapped: number; unknownKek: number; failed: number }> {
  const db = usePrismaClient();
  const rows = await db.workspaceKey.findMany({
    where: { kekId: { not: ring.active.id }, ...(only ? { workspaceId: { in: only } } : {}) },
    select: { id: true, workspaceId: true, kekId: true, wrappedDek: true, generation: true },
  });
  let rewrapped = 0;
  let unknownKek = 0;
  let failed = 0;
  for (const row of rows) {
    if (!ring.byId.has(row.kekId)) {
      unknownKek++;
      continue;
    }
    let dek: Uint8Array;
    try {
      dek = unsealRow(ring, row, row.workspaceId).dek;
    } catch (err) {
      if (!(err instanceof WorkspaceKeyError)) throw err;
      console.error(
        `[keys] workspace ${row.workspaceId} generation ${row.generation} will not unseal ` +
          `under "${row.kekId}"; left as it is`,
      );
      failed++;
      continue;
    }
    const { count } = await db.workspaceKey.updateMany({
      where: { id: row.id, kekId: row.kekId },
      data: { kekId: ring.active.id, wrappedDek: wrapDek(dek, ring.active.key, row.workspaceId) },
    });
    rewrapped += count;
  }
  return { rewrapped, unknownKek, failed };
}

/**
 * Give a workspace a new data-key generation if the one in use was created
 * before `before`, and mark every older generation retired. Returns the
 * generation new writes now use and whether this call issued it, or null when
 * the workspace has no key yet (it has never stored an encrypted blob, so
 * there is nothing to rotate).
 * Two processes issuing at once collide on (workspace, generation); the loser
 * adopts the winner's row.
 */
export async function issueGeneration(
  ring: KekRing,
  workspaceId: string,
  before: Date,
  now: Date = new Date(),
): Promise<{ generation: number; issued: boolean } | null> {
  const db = usePrismaClient();
  const latest = await currentRow(workspaceId);
  if (!latest) return null;
  let generation = latest.generation;
  let issued = false;
  if (latest.createdAt < before) {
    generation = latest.generation + 1;
    try {
      await db.workspaceKey.create({
        data: {
          workspaceId,
          generation,
          kekId: ring.active.id,
          wrappedDek: wrapDek(new Uint8Array(randomBytes(KEY_BYTES)), ring.active.key, workspaceId),
        },
      });
      issued = true;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  await db.workspaceKey.updateMany({
    where: { workspaceId, generation: { lt: generation }, retiredAt: null },
    data: { retiredAt: now },
  });
  return { generation, issued };
}

/** Generations replaced before `cutoff`: candidates for destruction once no blob names them. */
export async function retiredGenerations(workspaceId: string, cutoff: Date): Promise<number[]> {
  const rows = await usePrismaClient().workspaceKey.findMany({
    where: { workspaceId, retiredAt: { lt: cutoff } },
    select: { generation: true },
  });
  return rows.map((r) => r.generation);
}

/**
 * Delete a retired generation's row: the moment its data key stops existing.
 * Only ever a retired one, so a mistaken call cannot destroy the key in use.
 */
export async function destroyGeneration(workspaceId: string, generation: number): Promise<boolean> {
  const { count } = await usePrismaClient().workspaceKey.deleteMany({
    where: { workspaceId, generation, retiredAt: { not: null } },
  });
  return count > 0;
}