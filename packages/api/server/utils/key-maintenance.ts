import { usePrismaClient } from "db";
import { type BlobStore, keyRotationStoreOf, type KeyRotationStore } from "./storage";
import {
  destroyGeneration,
  issueGeneration,
  type KekRing,
  resolveKekRing,
  retiredGenerations,
  rewrapRetiredKeys,
} from "./workspace-keys";

// ---------------------------------------------------------------------------
// Key maintenance: rotation by configuration.
//
// Two rotations, both driven by the environment and run by the API itself on
// boot and on an interval (plugins/key-maintenance.ts), so an operator changes
// a 1Password field and waits rather than running anything in production:
//
//   * Master key (BLOB_KEK). Put the new key in BLOB_KEK and the old one in
//     BLOB_KEK_RETIRED. Every data key sealed under a retired KEK is re-sealed
//     under the active one. No blob is touched; it takes seconds.
//
//   * Data keys (BLOB_DEK_ROTATE_BEFORE). Every workspace whose data key in use
//     was created before that instant gets a new generation; every object in
//     its bucket prefix is re-encrypted under it (including bytes no database
//     row points at any more, and plaintext written before encryption existed);
//     and each old generation is destroyed once it has been retired for
//     DESTROY_GRACE_MS and a fresh scan finds nothing sealed under it.
//
// Every step is safe to repeat and safe to run on several pods at once, so
// there is no lock. See the runbook in
// docs/solutions/security/rotating-blob-encryption-keys.md.
// ---------------------------------------------------------------------------

/**
 * How long a replaced generation is kept before it may be destroyed. Other
 * pods learn of a new generation within CURRENT_GENERATION_TTL_MS, and an
 * upload that fetched the old key just before the rotation finishes within
 * minutes; a day outlasts both by a wide margin. Keeping the old key that long
 * costs nothing: by then it is sealed under the current KEK.
 */
export const DESTROY_GRACE_MS = 24 * 60 * 60_000;

/**
 * A leftover of an interrupted filesystem write older than this is abandoned:
 * no write of a file the API accepts takes anywhere near an hour. A younger
 * one may still be in flight, so it is left alone and, while it exists, so are
 * the workspace's old keys.
 */
const ABANDONED_AFTER_MS = 60 * 60_000;

/** Objects re-encrypted at once per workspace. Each is streamed, so memory stays flat. */
const RESEAL_CONCURRENCY = 4;

export interface KeyMaintenanceSummary {
  /** Data keys re-sealed under the active KEK. */
  rewrapped: number;
  /** Data keys under a KEK this process does not hold, or that will not unseal. Left alone. */
  unreadableKeys: number;
  /** New data-key generations issued. */
  issued: number;
  /** Objects re-encrypted under their workspace's current generation. */
  resealed: number;
  /** Objects carrying the encryption marker whose header won't parse. Left alone. */
  malformed: number;
  /** Old generations destroyed. */
  destroyed: number;
  /** Retired generations still kept: in their grace period, or still named by an object. */
  pendingDestroy: number;
  /** Objects that failed to re-encrypt this run; retried on the next. */
  errors: number;
  /**
   * Bucket prefixes whose workspace no longer exists. Deleting a workspace
   * deletes its keys but not its bytes, and with no key those bytes cannot be
   * re-encrypted; someone holding an old database copy and the old KEK could
   * still read them. Counted on every rotation run, purged once the rotation
   * was asked for more than DESTROY_GRACE_MS ago.
   */
  orphanedPrefixes: number;
  /**
   * Leftovers of interrupted writes too recent to call abandoned (filesystem
   * storage). Removed on a later run once they are; until then a workspace
   * that has some keeps its old keys.
   */
  recentLeftovers: number;
  /**
   * Objects deleted from orphaned prefixes, plus leftovers of interrupted
   * writes (filesystem storage) removed before a workspace's old keys go.
   */
  purged: number;
}

export interface KeyMaintenanceOptions {
  ring: KekRing;
  store: KeyRotationStore;
  /** BLOB_DEK_ROTATE_BEFORE, parsed. Null when no data-key rotation is asked for. */
  rotateBefore: Date | null;
  /**
   * Workspaces this process has already swept for retired generations. A pod
   * that restarts part way through a sweep starts it again; one that has
   * finished does not repeat it every interval.
   */
  swept: Set<string>;
  now?: Date;
  /** Restrict maintenance to these workspaces. Tests only: production maintains every one. */
  only?: string[];
}

/**
 * How far ahead of this process's clock BLOB_DEK_ROTATE_BEFORE may be: room for
 * the operator's clock to run ahead, no more. See resolveRotateBefore.
 */
const ROTATE_BEFORE_SKEW_MS = 10 * 60_000;

/**
 * Parse BLOB_DEK_ROTATE_BEFORE. Strict: a bad value is an error, never quietly
 * ignored, because a typo that silently skipped a rotation would leave the
 * operator believing leaked keys were gone. The plugin logs it and the status
 * endpoint reports it (see rotateBeforeOrError).
 *
 * A cutoff in the future is refused too. Every generation issued before it
 * would itself count as "created before the cutoff", so each run would issue
 * another and re-encrypt the whole bucket again, until the cutoff passed. The
 * small allowance for clock skew bounds that to one extra generation at most.
 */
export function resolveRotateBefore(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Date | null {
  const raw = env.BLOB_DEK_ROTATE_BEFORE?.trim();
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  const at = new Date(raw);
  if (!iso.test(raw) || Number.isNaN(at.getTime())) {
    throw new Error(
      "BLOB_DEK_ROTATE_BEFORE is not an ISO-8601 instant with a time zone, " +
        'e.g. "2026-10-30T09:00:00Z". Fix or remove it.',
    );
  }
  if (at.getTime() > now.getTime() + ROTATE_BEFORE_SKEW_MS) {
    throw new Error(
      "BLOB_DEK_ROTATE_BEFORE is in the future. Set it to the time you asked for the " +
        "rotation (now, or earlier); a future cutoff would rotate every key again on every run.",
    );
  }
  return at;
}

/** resolveRotateBefore, with a bad value reported rather than thrown. */
export function rotateBeforeOrError(env: NodeJS.ProcessEnv = process.env): {
  rotateBefore: Date | null;
  error: string | null;
} {
  try {
    return { rotateBefore: resolveRotateBefore(env), error: null };
  } catch (err) {
    return { rotateBefore: null, error: (err as Error).message };
  }
}

/**
 * What maintenance runs with, from the environment: null when there is nothing
 * to maintain (no encryption configured). `error` is a bad
 * BLOB_DEK_ROTATE_BEFORE, which disables only the data-key rotation.
 */
export function maintenanceSetup(
  env: NodeJS.ProcessEnv,
  blobStore: () => BlobStore,
): { options: Omit<KeyMaintenanceOptions, "swept">; error: string | null } | null {
  const ring = resolveKekRing(env);
  const store = ring && keyRotationStoreOf(blobStore());
  if (!ring || !store) return null;
  const { rotateBefore, error } = rotateBeforeOrError(env);
  return { options: { ring, store, rotateBefore }, error };
}

export async function runKeyMaintenance(
  opts: KeyMaintenanceOptions,
): Promise<KeyMaintenanceSummary> {
  const now = opts.now ?? new Date();
  const summary: KeyMaintenanceSummary = {
    rewrapped: 0,
    unreadableKeys: 0,
    issued: 0,
    resealed: 0,
    malformed: 0,
    destroyed: 0,
    pendingDestroy: 0,
    errors: 0,
    orphanedPrefixes: 0,
    recentLeftovers: 0,
    purged: 0,
  };

  const rewrap = await rewrapRetiredKeys(opts.ring, opts.only);
  summary.rewrapped = rewrap.rewrapped;
  summary.unreadableKeys = rewrap.unknownKek + rewrap.failed;

  for (const workspaceId of await candidateWorkspaces(opts.rotateBefore !== null, opts.only)) {
    const result = await maintainWorkspaceSafely(opts, workspaceId, now);
    for (const k of Object.keys(result) as (keyof typeof result)[]) summary[k] += result[k];
  }
  if (opts.rotateBefore) {
    try {
      const orphans = await purgeOrphanedPrefixes(opts, opts.rotateBefore, now);
      summary.orphanedPrefixes = orphans.found;
      summary.purged += orphans.purged;
      summary.errors += orphans.errors;
    } catch (err) {
      summary.errors++;
      console.error("[keys] could not check for deleted workspaces' bytes; retrying next run", err);
    }
  }
  return summary;
}

/**
 * One workspace's maintenance, its failure contained: a workspace whose scan
 * fails (an unreadable prefix, a storage error) keeps every key it has, is
 * counted as an error and retried on the next run, and never stops the rest
 * from rotating.
 */
async function maintainWorkspaceSafely(
  opts: KeyMaintenanceOptions,
  workspaceId: string,
  now: Date,
): Promise<WorkspaceResult> {
  try {
    return await maintainWorkspace(opts, workspaceId, now);
  } catch (err) {
    console.error(`[keys] maintenance of workspace ${workspaceId} failed; retrying next run`, err);
    return {
      issued: 0,
      resealed: 0,
      malformed: 0,
      destroyed: 0,
      pendingDestroy: 0,
      errors: 1,
      purged: 0,
      recentLeftovers: 0,
    };
  }
}

/** A workspace id: a prefix that is anything else is never touched. */
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Find prefixes whose workspace is gone, and delete their objects once the
 * rotation has been asked for longer than the grace period. The day between
 * lets the operator see `orphanedPrefixes` in the status before anything goes,
 * and back out by removing BLOB_DEK_ROTATE_BEFORE. Deleted workspaces only:
 * a workspace row exists before its first blob is written, so a live
 * workspace's prefix always has a row.
 */
async function purgeOrphanedPrefixes(
  opts: KeyMaintenanceOptions,
  rotateBefore: Date,
  now: Date,
): Promise<{ found: number; purged: number; errors: number }> {
  const db = usePrismaClient();
  const ids: string[] = [];
  for await (const prefix of opts.store.listPrefixes()) {
    if (WORKSPACE_ID.test(prefix) && (!opts.only || opts.only.includes(prefix))) ids.push(prefix);
  }
  const live = new Set(
    (await db.workspace.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
      (w) => w.id,
    ),
  );
  const orphans = ids.filter((id) => !live.has(id));
  if (now.getTime() - rotateBefore.getTime() < DESTROY_GRACE_MS) {
    return { found: orphans.length, purged: 0, errors: 0 };
  }
  let purged = 0;
  let errors = 0;
  for (const id of orphans) {
    try {
      purged += await purgeDeletedWorkspace(opts, id, now);
    } catch (err) {
      // One unreadable prefix must not keep every other deleted workspace's
      // bytes in place; it is retried on the next run.
      errors++;
      console.error(`[keys] could not purge deleted workspace ${id}; retrying next run`, err);
    }
  }
  return { found: orphans.length, purged, errors };
}

/** Delete every stored byte of a workspace that no longer exists. */
async function purgeDeletedWorkspace(
  opts: KeyMaintenanceOptions,
  id: string,
  now: Date,
): Promise<number> {
  const db = usePrismaClient();
  // Checked again right before deleting: never trust the earlier read alone.
  if (await db.workspace.findUnique({ where: { id }, select: { id: true } })) return 0;
  let purged = 0;
  for await (const { key } of opts.store.list(`${id}/`)) {
    await opts.store.delete(key);
    purged++;
  }
  // The workspace is gone, so no write to it can still be in flight.
  purged += (await opts.store.purgeAbandoned(`${id}/`, now)).purged;
  console.log(`[keys] purged the stored bytes of deleted workspace ${id}`);
  return purged;
}

/**
 * With a rotation asked for, every workspace is a candidate; otherwise only
 * those still holding a retired generation have anything left to do.
 */
async function candidateWorkspaces(rotating: boolean, only?: string[]): Promise<Set<string>> {
  const db = usePrismaClient();
  const scope = only ? { in: only } : undefined;
  const withRetired = await db.workspaceKey.findMany({
    where: { retiredAt: { not: null }, ...(scope ? { workspaceId: scope } : {}) },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
  });
  const candidates = new Set(withRetired.map((r) => r.workspaceId));
  if (rotating) {
    const all = await db.workspace.findMany({
      where: scope ? { id: scope } : {},
      select: { id: true },
    });
    for (const w of all) candidates.add(w.id);
  }
  return candidates;
}

type WorkspaceResult = Omit<
  KeyMaintenanceSummary,
  "rewrapped" | "unreadableKeys" | "orphanedPrefixes"
>;

/** What asking for a new generation did: see issueIfAsked. */
type Issue = "not-asked" | "no-key" | "unchanged" | "issued";

/**
 * Whether a workspace needs sweeping until a sweep of it succeeds: whenever a
 * rotation is asked for. That covers one just rotated, one rotated before this
 * process started, and one with no key yet, which may still hold plaintext
 * from before encryption existed (the sweep encrypts it and provisions the
 * key). A sweep that hit errors is repeated on the next run.
 */
const SWEEP_AFTER: Record<Issue, boolean> = {
  "not-asked": false,
  "no-key": true,
  unchanged: true,
  issued: true,
};

/** Issue, sweep and destroy for one workspace, as far as each is due. */
async function maintainWorkspace(
  opts: KeyMaintenanceOptions,
  workspaceId: string,
  now: Date,
): Promise<WorkspaceResult> {
  const issue = await issueIfAsked(opts, workspaceId, now);
  const retired = await usePrismaClient().workspaceKey.count({
    where: { workspaceId, retiredAt: { not: null } },
  });
  const due = await retiredGenerations(workspaceId, new Date(now.getTime() - DESTROY_GRACE_MS));
  const swept = shouldSweep(issue, retired, opts.swept.has(workspaceId), due.length)
    ? await sweepAndRemember(opts, workspaceId)
    : { resealed: 0, malformed: 0, errors: 0 };
  // A sweep that hit errors left something it could not re-encrypt; whatever
  // it is, an old key might be what opens it.
  const destroying = due.length > 0 && swept.errors === 0;
  // Leftovers of interrupted writes are invisible to the sweep and the census.
  // Under a rotation, or before old keys go, abandoned ones are removed: they
  // may hold old-key ciphertext, or plaintext from before encryption existed.
  // A recent one (perhaps still being written) is left for a later run, and
  // until then keeps the workspace's old keys.
  const leftovers =
    destroying || issue !== "not-asked"
      ? await opts.store.purgeAbandoned(
          `${workspaceId}/`,
          new Date(now.getTime() - ABANDONED_AFTER_MS),
        )
      : { purged: 0, remaining: 0 };
  const destroyed =
    destroying && leftovers.remaining === 0
      ? await destroyUnneeded(opts.store, workspaceId, due)
      : 0;
  const purged = leftovers.purged;
  return {
    issued: issue === "issued" ? 1 : 0,
    ...swept,
    destroyed,
    pendingDestroy: retired - destroyed,
    purged,
    recentLeftovers: leftovers.remaining,
  };
}

/** Issue a new generation when BLOB_DEK_ROTATE_BEFORE asks for one. */
async function issueIfAsked(
  opts: KeyMaintenanceOptions,
  workspaceId: string,
  now: Date,
): Promise<Issue> {
  if (!opts.rotateBefore) return "not-asked";
  const result = await issueGeneration(opts.ring, workspaceId, opts.rotateBefore, now);
  if (!result) return "no-key";
  if (!result.issued) return "unchanged";
  // A new generation must reach this pod's writes before the sweep, or the
  // sweep would race its own pod's uploads under the old key.
  opts.store.forgetKeys(workspaceId);
  return "issued";
}

function shouldSweep(issue: Issue, retired: number, sweptBefore: boolean, due: number): boolean {
  return (
    issue === "issued" ||
    // Not yet swept to completion by this process.
    ((SWEEP_AFTER[issue] || retired > 0) && !sweptBefore) ||
    // A last sweep before destroying anything picks up a straggler written
    // under the old key by a pod that had not yet seen the new generation.
    due > 0
  );
}

async function sweepAndRemember(opts: KeyMaintenanceOptions, workspaceId: string) {
  const done = await sweepWorkspace(opts.store, workspaceId);
  if (done.errors === 0) opts.swept.add(workspaceId);
  return done;
}

/**
 * Destroy the due generations, but only if every stored object in the
 * workspace proves, by opening, that it is sealed under the current
 * generation. The proof is a fresh scan taken after the sweep. Anything that
 * doesn't prove itself, whether legacy bytes, a damaged header or an object
 * under some other generation, might need one of the old keys to ever be read
 * again (after repairing a header, say), so it keeps all of them.
 */
async function destroyUnneeded(
  store: KeyRotationStore,
  workspaceId: string,
  due: number[],
): Promise<number> {
  const current = await currentGeneration(workspaceId);
  const census = await censusWorkspace(store, workspaceId);
  const unproven = [...census.entries()].filter(([g]) => g !== current);
  if (unproven.length > 0) {
    console.error(
      `[keys] workspace ${workspaceId} has objects not proven to be under its current key ` +
        `(${unproven.map(([g, n]) => `${g}: ${n}`).join(", ")}); keeping its old data keys`,
    );
    return 0;
  }
  let destroyed = 0;
  for (const generation of due) {
    if (await destroyGeneration(workspaceId, generation)) destroyed++;
  }
  if (destroyed > 0) store.forgetKeys(workspaceId);
  return destroyed;
}

/** The generation new writes use, or null when the workspace has no key yet. */
async function currentGeneration(workspaceId: string): Promise<number | null> {
  const row = await usePrismaClient().workspaceKey.findFirst({
    where: { workspaceId },
    orderBy: { generation: "desc" },
    select: { generation: true },
  });
  return row?.generation ?? null;
}

/**
 * Re-encrypt every object in a workspace's prefix that is not sealed under its
 * current generation: older generations and legacy plaintext. A malformed one
 * is counted and left exactly as it is; overwriting what cannot be read would
 * destroy whatever chance there is of recovering it.
 */
async function sweepWorkspace(
  store: KeyRotationStore,
  workspaceId: string,
): Promise<{ resealed: number; malformed: number; errors: number }> {
  let current = await currentGeneration(workspaceId);
  let resealed = 0;
  let malformed = 0;
  let errors = 0;

  await eachConcurrently(store.list(`${workspaceId}/`), RESEAL_CONCURRENCY, async ({ key }) => {
    try {
      const generation = await store.sealedGeneration(key);
      if (generation === null || generation === current) return;
      if (generation === "malformed") {
        malformed++;
        console.error(
          `[keys] ${key} carries the encryption marker but will not parse; left as it is`,
        );
        return;
      }
      if (await store.reseal(key)) resealed++;
      // Re-sealing plaintext in a workspace with no key provisions one.
      if (current === null) current = await currentGeneration(workspaceId);
    } catch (err) {
      errors++;
      console.error(`[keys] could not re-encrypt ${key}; will retry on the next run`, err);
    }
  });

  return { resealed, malformed, errors };
}

/** How many objects in a workspace's prefix are proven to be sealed under each generation. */
async function censusWorkspace(
  store: KeyRotationStore,
  workspaceId: string,
): Promise<Map<number | "unverified", number>> {
  const counts = new Map<number | "unverified", number>();
  await eachConcurrently(store.list(`${workspaceId}/`), RESEAL_CONCURRENCY, async ({ key }) => {
    const generation = await store.verifiedGeneration(key);
    if (generation === null) return;
    counts.set(generation, (counts.get(generation) ?? 0) + 1);
  });
  return counts;
}

/** Run `work` over every item, at most `limit` at once. The first error rejects. */
async function eachConcurrently<T>(
  items: AsyncIterable<T>,
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const iterator = items[Symbol.asyncIterator]();
  let done = false;
  const next = async (): Promise<IteratorResult<T>> => {
    if (done) return { done: true, value: undefined };
    const r = await iterator.next();
    if (r.done) done = true;
    return r;
  };
  // Pulling from one shared iterator is safe: each worker awaits its own
  // next() call, and an async generator queues concurrent next() calls.
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let r = await next(); !r.done; r = await next()) await work(r.value);
    }),
  );
}

let lastRun: { at: string; summary: KeyMaintenanceSummary } | null = null;

/** This process's most recent maintenance run, for the status endpoint. */
export function lastKeyMaintenanceRun(): { at: string; summary: KeyMaintenanceSummary } | null {
  return lastRun;
}

export function recordKeyMaintenanceRun(summary: KeyMaintenanceSummary, at = new Date()): void {
  lastRun = { at: at.toISOString(), summary };
}

/** Everything the status endpoint reports from the database. No key material. */
export async function keyRotationStatus(ring: KekRing) {
  const { rotateBefore, error } = rotateBeforeOrError();
  const db = usePrismaClient();
  const byKek = await db.workspaceKey.groupBy({ by: ["kekId"], _count: { _all: true } });
  const inUse = await db.workspaceKey.groupBy({
    by: ["generation"],
    where: { retiredAt: null },
    _count: { _all: true },
  });
  const retired = await db.workspaceKey.aggregate({
    where: { retiredAt: { not: null } },
    _count: { _all: true },
    _min: { retiredAt: true },
  });
  const stale = rotateBefore
    ? await db.workspaceKey.count({ where: { retiredAt: null, createdAt: { lt: rotateBefore } } })
    : 0;
  return {
    activeKekId: ring.active.id,
    retiredKekIds: [...ring.byId.keys()].filter((id) => id !== ring.active.id),
    rowsByKekId: Object.fromEntries(byKek.map((r) => [r.kekId, r._count._all])),
    workspacesWithKeys: inUse.reduce((n, r) => n + r._count._all, 0),
    currentGenerations: Object.fromEntries(inUse.map((r) => [String(r.generation), r._count._all])),
    rotateBefore: rotateBefore?.toISOString() ?? null,
    rotateBeforeError: error,
    workspacesAwaitingNewKey: stale,
    retiredPendingDestroy: retired._count._all,
    oldestRetiredAt: retired._min.retiredAt?.toISOString() ?? null,
    lastRun: lastKeyMaintenanceRun(),
  };
}