import { Buffer } from "node:buffer";
import { type Prisma, usePrismaClient } from "db";
import {
  CONTENT_POINTER_OPS,
  conflictedCopyBounds,
  conflictedCopyName,
  FILE_OPS,
  contentTypeFor,
  type FileOp,
  fileExtension,
} from "shared";
import {
  ACL_SELECT,
  type AccessSubject,
  type AclRow,
  canRead,
  canWrite,
  copyFileRestriction,
  createRestriction,
  decodeGrants,
  effectiveAcl,
  encodeGrants,
  listWorkspaceAcls,
  recordAccessChange,
  rePathRestriction,
  type Viewer,
  type WriteDenial,
  writeRefusal,
} from "./acl";
import { useAnalytics } from "./analytics";
import { collectBytes, dropFileLinks, indexFileLinks } from "./link-index";
import { normalizePath } from "./paths";
import type { RangeRequest } from "blob-io/byte-range";

/** Chooses a byte range given the identity of the bytes about to be served. */
export type RangeFor = (served: {
  version: number;
  contentHash: string;
}) => RangeRequest | undefined;
import { limitsForWorkspace } from "./quota";
import {
  applyTextEdits,
  isEditableText,
  type EditFailure,
  type EditOutcome,
  type TextEdit,
} from "./textEdit";
import {
  type BlobSource,
  bufferSource,
  type OpenedBlob,
  type SealedBlob,
  useBlobStore,
} from "./storage";

// Re-exported so existing importers (`import { normalizePath } from "./files"`)
// keep working; the definitions now live in paths.ts to avoid an acl.ts cycle.
export { normalizePath, PathError } from "./paths";
// Likewise for the instance upload ceiling, which now lives alongside the other
// limits in quota.ts. Callers wanting the PLAN-aware ceiling for a specific
// workspace should use `limitsForWorkspace().maxFileBytes` instead.
export { maxFileBytes } from "./quota";

// ---------------------------------------------------------------------------
// Shared file-service. This is the single source of write logic; both the REST
// routes and the MCP tools call it, so the optimistic-concurrency, conflicted-
// copy, and change-feed invariants live in exactly one place. Attribution is by
// the caller-supplied `principal` (sourced from the authenticated key), never by
// the route.
// ---------------------------------------------------------------------------

export type Principal = "agent" | "human";

export interface Actor {
  principal: Principal;
  actorId?: string;
  /** The API key id that performed the change (any key, incl. human CLI keys). */
  actorKeyId?: string;
  /** Snapshot of the acting key's display label at write time. */
  actorLabel?: string;
  /**
   * Whose access the action is checked against: the authorized subject (see
   * authorizeWorkspace), or "trusted" for internal writers like seeding.
   * Required, so a write path can't forget it and fall open.
   */
  access: Viewer;
  /**
   * The recovery operation this change belongs to (see recovery.ts). Stamped on
   * every event the change records, so the feed can group a restore of 42 files
   * into one entry. Absent for ordinary changes.
   */
  operationId?: string;
}

export type { WriteDenial };

export function blobKeyFor(workspaceId: string, hash: string): string {
  return `${workspaceId}/${hash}`;
}

export interface WriteResult {
  ok: boolean;
  version?: number;
  conflict?: {
    currentVersion: number | null;
    conflictCopyPath: string;
  };
  // Distinct from a version conflict: the clean primary write was rejected
  // because it would push the workspace over its storage limit. Consumers MUST
  // test this BEFORE the `!ok` conflict branch (a quota rejection is also !ok).
  quotaExceeded?: true;
  usage?: { usedBytes: number; limitBytes: number };
  // The workspace already holds its plan's maximum number of live files and
  // this write would add another. Only a CREATE can trip this — replacing an
  // existing file leaves the count unchanged. Same ordering rule as
  // `quotaExceeded`: test before the `!ok` conflict branch.
  fileCountExceeded?: true;
  fileUsage?: { usedFiles: number; limitFiles: number };
  // The body is larger than the workspace's effective per-file ceiling (the
  // lower of its plan's limit and the instance-wide `MAX_FILE_BYTES`). Same
  // ordering rule.
  fileTooLarge?: true;
  sizeLimit?: { bytes: number; limitBytes: number };
  // The org's subscription lapsed and its grace window closed, so the workspace
  // is read-only. Reads, moves and deletes still work — this blocks new content,
  // it never removes any. Same ordering rule as the limits above.
  readOnly?: true;
  // The actor can't see the path at all (a restricted node they hold no grant
  // on). Consumers map this to 404 (not 403) so a restricted node is
  // indistinguishable from a non-existent one. Test BEFORE the `!ok` conflict
  // branch.
  forbidden?: true;
  // The actor can see the path but not write it (a viewer, a view-only grant, a
  // read-only key, or a path outside its key's folder). Consumers map this to a
  // 409 carrying the denial. Same ordering rule.
  denied?: WriteDenial;
  // Only with `ifStale: "fail"`: the base version was stale and nothing was
  // written — no conflicted copy either.
  stale?: true;
  // Success because the file already held these bytes: its record didn't change.
  unchanged?: true;
}

// Outcome of a partial edit. `applied` means the edit was turned into a write;
// the write itself can still lose (a conflicted copy) or be refused by a limit,
// so callers read `write` exactly as they would a `write()` result. `appliedTo`
// is the version the edit was applied to: the head when it rebased cleanly, the
// caller's stale base when it fell back to a conflicted copy.
export type EditResult =
  | { status: "applied"; write: WriteResult; appliedTo: number; replacements: number }
  | { status: "not_found" }
  | { status: "blob_missing" }
  | { status: "binary" }
  | { status: "edit_failed"; failure: EditFailure; currentVersion: number }
  // Stale, and this actor has written the file since the caller's base, but
  // that write can't be checked against this edit (its predecessor has no
  // stored bytes: a conflicted copy's first version, or one older than the
  // change feed's content pointers). It may be a retry, so nothing is written.
  | { status: "unverifiable"; currentVersion: number }
  | { status: "denied"; denial: WriteDenial };

// The no-op success for a recognised retry. `appliedTo` is the version the
// original edit landed on, so a retry of a rebased edit still reports it.
const replayed = (headVersion: number, appliedTo: number, replacements: number): EditResult => ({
  status: "applied",
  write: { ok: true, version: headVersion },
  appliedTo,
  replacements,
});

// A retry when `edited` (the edit applied to an earlier version) is byte for
// byte the current file.
function alreadyApplied(
  edited: EditedVersion | undefined,
  current: Uint8Array,
  headVersion: number,
  appliedTo: number,
): EditResult | undefined {
  if (!applied(edited) || Buffer.compare(edited.body, current) !== 0) return undefined;
  return replayed(headVersion, appliedTo, edited.replacements);
}

// An earlier version with the edit applied, or "unavailable" when that
// version's bytes can't be read as text.
type EditedVersion = EditOutcome | "unavailable";
const applied = (e: EditedVersion | undefined): e is Extract<EditOutcome, { ok: true }> =>
  typeof e === "object" && e.ok;

// An edit() call with its path normalized, the per-file byte limit resolved,
// and the head's stored content type once known.
type EditCall = Parameters<FileService["edit"]>[0] & { maxBytes: number; contentType?: string };

export interface FileService {
  // `viewer` filters out nodes the subject can't read (restricted subtrees they
  // hold no grant on), so REST/MCP/CLI listings never reveal a restricted
  // node's existence. "trusted" only for internal callers.
  list(
    workspaceId: string,
    prefix: string,
    viewer: Viewer,
    // Pre-fetched workspace ACLs. Pass to reuse a single fetch when the caller
    // also needs the ACL rows (e.g. the /list route builds `privatePaths`);
    // omit and the service fetches them itself.
    acls?: AclRow[],
  ): Promise<{ path: string; size: number; contentType: string; version: number }[]>;
  // Same ACL filtering as `list`, but selects only `path`. Search scores a whole
  // workspace's paths per request and needs nothing else; `list`'s wider
  // projection is fixed in this interface and has eight call sites, so a
  // conditional return type there would ripple for the sake of three columns.
  // A real subject is REQUIRED here, unlike `list` — see the note on the
  // trusted-caller bypass below. There is no trusted mode for path enumeration.
  listPaths(workspaceId: string, subject: AccessSubject, acls?: AclRow[]): Promise<string[]>;
  // A restricted path the subject can't read resolves to null (no existence
  // disclosure). "trusted" only for internal callers (e.g. share serving).
  stat(
    workspaceId: string,
    path: string,
    viewer: Viewer,
  ): Promise<{ version: number; contentHash: string; size: number; contentType: string } | null>;
  // Total bytes of the workspace's live files (sum of FileNode.size). The
  // durable source of truth for usage — never derived from the blob store, which
  // can degrade to ephemeral disk. `excludePath` omits one path from the sum, so
  // the write gate can project an update's new total without double-counting the
  // version being replaced.
  usage(workspaceId: string, opts?: { excludePath?: string }): Promise<number>;
  // Number of live files in the workspace — the countable unit the plan's file
  // limit is expressed in, and the figure the usage endpoint reports.
  fileCount(workspaceId: string): Promise<number>;
  read(
    workspaceId: string,
    path: string,
    viewer: Viewer,
  ): Promise<
    | {
        status: "ok";
        body: Uint8Array;
        contentType: string;
        version: number;
        /** Identity of THESE bytes. A version number is reused across a
         * delete-and-recreate; this is not, which is what lets a caller name
         * exactly what it was shown. */
        contentHash: string;
      }
    | { status: "not_found" }
    | { status: "blob_missing" }
  >;
  // Read bytes directly by content hash (content-addressed). Used to serve a
  // pinned share version, immune to version-number reuse. `blob_missing` when the
  // blob is genuinely gone (e.g. never persisted / R2 not wired).
  readByHash(
    workspaceId: string,
    contentHash: string,
  ): Promise<{ status: "ok"; body: Uint8Array; contentType: string } | { status: "blob_missing" }>;
  // Streaming counterparts of read / readByHash / readVersion, for the routes
  // that hand bytes to clients. Same gates and statuses; the body is a stream.
  // `rangeFor` picks the byte range once the bytes being served are known, so a
  // conditional range (If-Range) is judged against exactly those bytes, never
  // an earlier lookup that a concurrent write could have overtaken.
  open(
    workspaceId: string,
    path: string,
    viewer: Viewer,
    rangeFor?: RangeFor,
  ): Promise<
    | { status: "ok"; blob: OpenedBlob; version: number; contentHash: string }
    | { status: "not_found" }
    | { status: "blob_missing" }
  >;
  openByHash(
    workspaceId: string,
    contentHash: string,
    range?: RangeRequest,
  ): Promise<{ status: "ok"; blob: OpenedBlob } | { status: "blob_missing" }>;
  // Where a prior version's bytes live, behind the same gate as `openVersion`,
  // without opening them. For handing the bytes to the byte Worker.
  versionHash(args: {
    workspaceId: string;
    path: string;
    version: number;
    viewer: Viewer;
  }): Promise<
    | { status: "ok"; contentHash: string }
    | { status: "not_found" }
    | { status: "version_not_found" }
  >;
  // The sealed form of a content-addressed blob, for the byte Worker, or null
  // when it must be served by this process (not encrypted, legacy plaintext,
  // damaged, or absent). `expectedSize` is the plaintext size the metadata
  // records, when known; it saves authenticating the first chunk.
  sealedBlob(
    workspaceId: string,
    contentHash: string,
    expectedSize?: number,
  ): Promise<SealedBlob | null>;
  openVersion(args: {
    workspaceId: string;
    path: string;
    version: number;
    viewer: Viewer;
    rangeFor?: RangeFor;
  }): Promise<
    | { status: "ok"; blob: OpenedBlob; version: number; contentHash: string }
    | { status: "not_found" }
    | { status: "version_not_found" }
    | { status: "blob_missing" }
  >;
  write(args: {
    workspaceId: string;
    path: string;
    // A stream for request bodies (spooled first, so its hash and size are
    // known), or bytes already in memory for MCP and internal writes.
    body: Uint8Array | BlobSource;
    contentType?: string;
    baseVersion?: number; // undefined => create-only (If-None-Match: *)
    // Never recreate the path if it was deleted since baseVersion: keep the
    // bytes as a conflicted copy instead. For edits, which apply to a file
    // that exists and must not bring it back (see edit()).
    updateOnly?: boolean;
    actor: Actor;
    nowIso: string;
    // What a stale update does. The default keeps the bytes as a conflicted
    // copy, because they are someone's edit. "fail" writes nothing and reports
    // `stale`, for a write the server makes on someone's behalf (rewriting
    // links after a rename) that should simply be retried against the new
    // version. Only meaningful with a baseVersion.
    ifStale?: "conflict-copy" | "fail";
  }): Promise<WriteResult>;
  // Find-and-replace on a text file, landing as an ordinary write(). A stale
  // baseVersion is rebased: if every edit still applies to the head, it is
  // written there. Only when it doesn't is the edit applied to the base the
  // caller read and handed to write() at that stale base, which keeps it as a
  // conflicted copy exactly as a stale full write would be.
  edit(args: {
    workspaceId: string;
    path: string;
    edits: readonly TextEdit[];
    baseVersion: number;
    actor: Actor;
    nowIso: string;
  }): Promise<EditResult>;
  remove(args: {
    workspaceId: string;
    path: string;
    baseVersion: number;
    actor: Actor;
  }): Promise<
    | { status: "ok" }
    | { status: "not_found" }
    | { status: "conflict"; currentVersion: number }
    | { status: "denied"; denial: WriteDenial }
  >;
  move(args: {
    workspaceId: string;
    from: string;
    to: string;
    baseVersion?: number;
    actor: Actor;
    // Recovery: the user the file must stay private to at its new path. When
    // the destination wouldn't keep it so (its private folder was renamed away,
    // say), the file gets its own private mark, in the same transaction.
    keepPrivateTo?: string | null;
  }): Promise<
    | { status: "ok"; version: number }
    | { status: "not_found" }
    | { status: "conflict"; currentVersion: number | null }
    | { status: "dest_exists" }
    | { status: "denied"; denial: WriteDenial }
  >;
  // Read the bytes of a prior version, located via the change feed's content
  // pointer. Addresses by the most recent change event carrying that version
  // number (so a version reused after delete/resurrect resolves to the current
  // incarnation). `version_not_found` covers pre-pointer versions (R8).
  readVersion(args: {
    workspaceId: string;
    path: string;
    version: number;
    viewer: Viewer;
  }): Promise<
    | { status: "ok"; body: Uint8Array; contentType: string; version: number; contentHash: string }
    | { status: "not_found" }
    | { status: "version_not_found" }
    | { status: "blob_missing" }
  >;
  // Restore a prior version's bytes as a NEW version at the head. Retries the CAS
  // against the current version so it normally lands on top (R9); on sustained
  // contention it falls through to a conflicted copy rather than erroring (KTD2).
  restore(args: {
    workspaceId: string;
    path: string;
    targetVersion: number;
    actor: Actor;
    nowIso: string;
  }): Promise<
    | { status: "ok"; version: number; restoredFrom: number }
    | { status: "not_found" }
    | { status: "version_not_found" }
    | { status: "blob_missing" }
    | { status: "conflict"; currentVersion: number | null; conflictCopyPath: string }
    | { status: "denied"; denial: WriteDenial }
  >;
  // Put recorded bytes (by content hash) back at a path, for recovery (see
  // recovery.ts). Unlike `restore`, it acts only on the exact state it was
  // planned against: `expect` is the version the path holds, or "absent" to
  // bring a deleted path back. Anything else is `changed`, never a retry or a
  // conflicted copy, because recovery reports what it skipped rather than
  // guessing over someone's newer work. Bringing a path back is a new file, so
  // it is held to the plan's limits like any other create.
  restoreContent(args: {
    workspaceId: string;
    path: string;
    contentHash: string;
    expect: number | "absent";
    actor: Actor;
    // With "absent": the change-feed position of the change that left the
    // path empty (null if it never held anything). It must still be the
    // path's last change when the file is created, so one recreated and
    // deleted again meanwhile is left alone.
    deletedAt?: bigint | null;
    // The user the path must stay private to. When what governs it now
    // wouldn't keep it so (its private folder was renamed away, or it was
    // shared since), it gets its own private mark in the same transaction,
    // and members who had it are told to drop it.
    keepPrivateTo?: string | null;
  }): Promise<RestoreContentResult>;
}

// The outcome of a refused gate: a path the actor can't see reads as not_found
// (no disclosure), one they can see but not change as denied.
const refusedBy = (gate: "hidden" | WriteDenial) =>
  gate === "hidden"
    ? ({ status: "not_found" } as const)
    : ({ status: "denied", denial: gate } as const);

export type RestoreContentResult =
  | { status: "ok"; version: number; size: number }
  | { status: "forbidden" }
  | { status: "blob_missing" }
  | { status: "changed" }
  | { status: "limit"; limit: "storage" | "files" | "size" | "read_only" };

/**
 * Where a write's bytes now need indexing: the file, its conflicted copy, or
 * nowhere. A retry of the same bytes left the file as it was, whatever type the
 * request claimed: its row is still right, and re-indexing under the claimed
 * type could empty it for good.
 */
function pathToIndex(path: string, result: WriteResult): string | undefined {
  if (result.unchanged) return undefined;
  return result.ok ? path : result.conflict?.conflictCopyPath;
}

export function useFileService(): FileService {
  // Index a file whose bytes are already in the blob store.
  const indexStored = (
    workspaceId: string,
    path: string,
    blob: { blobKey: string; contentHash: string; size: number; contentType: string },
  ) =>
    indexFileLinks({
      workspaceId,
      path,
      contentHash: blob.contentHash,
      contentType: blob.contentType,
      size: blob.size,
      read: async () => (await useBlobStore().get(blob.blobKey))?.body ?? null,
    });

  const db = usePrismaClient();
  const storage = useBlobStore();

  async function recordChange(
    tx: Prisma.TransactionClient | typeof db,
    workspaceId: string,
    path: string,
    op: FileOp,
    version: number | null,
    actor: Actor,
    // Content pointer (locates the version's bytes via the content-addressed
    // blob key). Set for write/move/restore, and for conflict so a conflicted
    // copy deleted later can still come back from the trash; null for delete.
    contentHash: string | null = null,
    // The other end of a move (see ChangeEvent.relatedPath).
    relatedPath: string | null = null,
    // Who the path is private to, when the caller knows better than the ACL
    // rows do right now (a move records its events after re-pathing the ACL).
    privateToOverride?: string,
  ) {
    const privateTo =
      privateToOverride ??
      encodeGrants(
        effectiveAcl(
          await tx.nodeAcl.findMany({ where: { workspaceId }, select: ACL_SELECT }),
          path,
        ),
      );
    await tx.changeEvent.create({
      data: {
        workspaceId,
        path,
        op,
        version,
        principal: actor.principal,
        actorId: actor.actorId,
        actorKeyId: actor.actorKeyId,
        actorLabel: actor.actorLabel,
        contentHash,
        relatedPath,
        privateTo,
        operationId: actor.operationId,
      },
    });

    // Report the mutation to analytics from HERE, because this is the one place
    // every mutation passes through — REST and MCP, human and agent, write and
    // move and delete. Instrumenting the routes instead would miss whichever
    // path gets added next, and would have no honest view of agent traffic at
    // all: an agent writing through MCP is invisible to any browser.
    //
    // The PATH is deliberately absent. The extension is derived here and the
    // name is dropped, matching the browser's rule (see the app's
    // plugins/posthog.client.ts): analytics may know that a markdown file was
    // written by an agent, never which one.
    useAnalytics().capture({
      distinctId: workspaceId,
      event: "file_changed",
      properties: {
        op,
        // "human" or "agent", taken from the API key's metadata — the same
        // by-credential attribution the change feed uses.
        principal: actor.principal,
        extension: fileExtension(path),
        depth: path.split("/").length,
      },
      groups: { workspace: workspaceId },
    });
  }

  // Insert a conflicted copy of the incoming bytes, retrying with a counter on
  // the unique constraint so two simultaneous stale writers each get a distinct
  // copy (never a 500, never a lost write).
  async function makeConflictCopy(
    workspaceId: string,
    path: string,
    blob: { blobKey: string; contentHash: string; size: number; contentType: string },
    actor: Actor,
    nowIso: string,
  ): Promise<string> {
    // A conflicted copy of a privately-owned FILE lands at a sibling path the
    // file-level ACL wouldn't cover, so it would leak. Folder-private copies stay
    // in the same subtree and inherit, so only the exact-file case needs an
    // explicit ACL stamped onto the copy (KTD5). Resolve it once up front.
    const gov = effectiveAcl(await listWorkspaceAcls(workspaceId), path);
    // On the path itself, whatever its kind: `set_private` defaults to folder, so a
    // file can carry a folder restriction, whose subtree the copy isn't in either.
    const stamp = gov?.path === path ? gov : null;

    // A conflicted copy that already holds these exact bytes has nothing left to
    // preserve, so re-preserving them adds noise and no information. This is not
    // hypothetical: one workspace collected six byte-identical copies of a single
    // losing state, stamped milliseconds apart, which then had to be hashed and
    // reconciled by hand. The client bug behind that burst is fixed (a folder
    // could be supervised by several sync engines at once), but the server should
    // not depend on every client being replay-free to keep the folder legible.
    const { prefix, suffix } = conflictedCopyBounds(path);
    // The prefix+suffix bounds are a SQL-side narrowing, not a decision: for an
    // extension-less path the suffix is empty, so `a`'s bounds also admit copies
    // of `a.md`. `isCopyOf` re-checks that what sits between the bounds really is
    // one stamp (and one optional counter) — never a copy of a different file
    // that happens to hold the same bytes.
    const isCopyOf = (candidate: string): boolean =>
      /^[^)/]+\)( \(\d+\))?$/.test(
        candidate.slice(prefix.length, candidate.length - suffix.length),
      );
    // Paged, never capped. Because `isCopyOf` filters in JS, a fixed `take` would
    // truncate the candidate set BEFORE the real copy is ever examined — and for
    // an extension-less path the bounds are broad enough to fill a page with
    // other families' copies (`note`'s bounds admit every `note.md` copy). Losing
    // the twin that way mints a duplicate, which is the one outcome this function
    // exists to prevent, so pages are walked until a copy is found or the
    // candidates run out.
    const findTwin = async (tx: Prisma.TransactionClient): Promise<string | null> => {
      const PAGE = 50;
      let after: string | undefined;
      for (;;) {
        const rows = await tx.fileNode.findMany({
          where: {
            workspaceId,
            contentHash: blob.contentHash,
            path: { startsWith: prefix, endsWith: suffix },
          },
          select: { path: true },
          orderBy: { path: "asc" }, // stable pick when several already exist
          take: PAGE,
          ...(after ? { cursor: { workspaceId_path: { workspaceId, path: after } }, skip: 1 } : {}),
        });
        const hit = rows.find((r) => isCopyOf(r.path));
        if (hit) return hit.path;
        if (rows.length < PAGE) return null;
        after = rows[rows.length - 1]?.path;
      }
    };
    // Serialize copy creation for this path. Checked outside a lock the content
    // test is only advisory: N simultaneous replays all look before any of them
    // commits, all find nothing, and all insert — which is precisely the burst
    // shape (copies stamped 1 ms apart). The lock is transaction-scoped, so it
    // releases on commit or rollback; a hash collision between two paths costs
    // only serialization, and this path runs only when a write has already lost.
    const lockKey = `treehouse:conflict:${workspaceId}:${path}`;

    for (let counter = 1; counter < 100; counter++) {
      const copyPath = conflictedCopyName(path, actor.principal, nowIso, counter);
      try {
        // Copy, change event, and the privacy stamp commit together — never a
        // window where the copy is visible to non-owners before the ACL lands.
        const settled = await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
          const twin = await findTwin(tx);
          if (twin) return twin;
          await tx.fileNode.create({
            data: { workspaceId, path: copyPath, version: 1, ...blob },
          });
          if (stamp) await copyFileRestriction(tx, workspaceId, stamp, copyPath);
          await recordChange(tx, workspaceId, copyPath, "conflict", 1, actor, blob.contentHash);
          return copyPath;
        });
        return settled;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // This name is already taken by an EARLIER copy (the lock above means no
        // concurrent writer is inside): same millisecond, different content.
        // Bump the counter and keep our own — that is what the ` (2)` suffix is
        // for. Retrying re-takes the lock, since it died with the rollback.
      }
    }
    throw new Error("could not allocate a conflicted-copy name");
  }

  // Resolve a write that did not update an existing row at the expected version.
  // Either the row is identical (idempotent no-op), absent (resurrect), or a
  // genuine stale conflict (keep a conflicted copy).
  async function resolveWriteMiss(args: {
    workspaceId: string;
    path: string;
    blob: { blobKey: string; contentHash: string; size: number; contentType: string };
    actor: Actor;
    nowIso: string;
    resurrectIfAbsent: boolean;
  }): Promise<WriteResult> {
    const { workspaceId, path, blob, actor, nowIso, resurrectIfAbsent } = args;
    const existing = await db.fileNode.findUnique({
      where: { workspaceId_path: { workspaceId, path } },
    });

    if (!existing && resurrectIfAbsent) {
      // The base row was deleted under us: resurrect the path rather than
      // orphaning the edit as a conflicted copy (edit beats stale delete).
      try {
        await db.fileNode.create({ data: { workspaceId, path, version: 1, ...blob } });
        await recordChange(db, workspaceId, path, "write", 1, actor, blob.contentHash);
        return { ok: true, version: 1 };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Lost a race to recreate — fall through to conflict handling below.
        return resolveWriteMiss({ ...args, resurrectIfAbsent: false });
      }
    }

    // Identical content already present → idempotent success, no spurious copy.
    if (existing && existing.contentHash === blob.contentHash) {
      return { ok: true, version: existing.version, unchanged: true };
    }

    const conflictCopyPath = await makeConflictCopy(workspaceId, path, blob, actor, nowIso);
    return { ok: false, conflict: { currentVersion: existing?.version ?? null, conflictCopyPath } };
  }

  // Sum of the workspace's live file sizes. A closure function (not a `this`
  // method) so the write() gate can call it without binding `this` — the
  // service object is sometimes destructured, where `this` would be undefined.
  async function workspaceUsage(
    workspaceId: string,
    opts?: { excludePath?: string },
  ): Promise<number> {
    const excludePath = opts?.excludePath ? normalizePath(opts.excludePath) : undefined;
    const agg = await db.fileNode.aggregate({
      where: { workspaceId, ...(excludePath ? { path: { not: excludePath } } : {}) },
      _sum: { size: true },
    });
    return agg._sum.size ?? 0;
  }

  // The edit applied to an earlier version (by default the one the caller
  // read), or undefined when that version is gone or the edit doesn't apply.
  async function editAtBase(call: EditCall, version = call.baseVersion): Promise<EditedVersion> {
    const { workspaceId, path, actor } = call;
    const pointer = await versionPointer(workspaceId, path, version, actor.access);
    if (pointer.status !== "ok") return "unavailable";
    const base = await textAt(blobKeyFor(workspaceId, pointer.contentHash));
    return typeof base === "string"
      ? "unavailable"
      : applyTextEdits(base.body, call.edits, call.maxBytes);
  }

  // A retry of an edit that already landed: the caller never saw the reply and
  // sent the same edit with the same stale base. Applying it again would
  // double it wherever its result still matches ("Sam" -> "Sam and Alex",
  // twice), and no test of the text alone can tell a retry from a new edit.
  // The change feed can: every write this actor has made to the path since
  // the base is checked, and if one of them is exactly its predecessor with
  // this edit applied, the edit has landed (directly, rebased, or before
  // someone else's later write) and the call succeeds as the no-op it is.
  // An own write that can't be checked (no stored predecessor) refuses the
  // call rather than risk a double apply. Undefined: go ahead.
  async function checkReplay(
    call: EditCall,
    headVersion: number,
    current: Uint8Array,
    editedBase: EditedVersion,
  ): Promise<EditResult | undefined> {
    // Landed straight on the base, by anyone: the head is already the result.
    const direct = alreadyApplied(editedBase, current, headVersion, call.baseVersion);
    if (direct) return direct;
    let unverifiable = false;
    for (const own of await ownWritesSince(call, headVersion)) {
      const before = own.version - 1;
      const edited = before === call.baseVersion ? editedBase : await editAtBase(call, before);
      if (edited === "unavailable") unverifiable = true;
      else if (edited.ok && bufferSource(edited.body).sha256 === own.contentHash) {
        return replayed(headVersion, before, edited.replacements);
      }
    }
    return unverifiable ? { status: "unverifiable", currentVersion: headVersion } : undefined;
  }

  // Writes the calling key (or user, for keyless callers) has made to the path
  // after the caller's base, newest first. Bounded: a retry follows its
  // original closely, so only the most recent few can be it.
  async function ownWritesSince(call: EditCall, headVersion: number) {
    const { actorKeyId, actorId } = call.actor;
    const who = actorKeyId ? { actorKeyId } : actorId ? { actorId } : null;
    if (!who) return [];
    const events = await db.changeEvent.findMany({
      where: {
        workspaceId: call.workspaceId,
        path: call.path,
        op: "write",
        version: { gt: call.baseVersion, lte: headVersion },
        contentHash: { not: null },
        ...who,
      },
      orderBy: { seq: "desc" },
      take: 20,
      select: { version: true, contentHash: true },
    });
    return events.flatMap((e) => (e.version === null ? [] : [{ ...e, version: e.version }]));
  }

  // The edit doesn't apply to the head. If the caller's base is stale and the
  // edit applies there, the targeted text was changed by someone else: keep
  // the edit, applied to the version the caller read, as a conflicted copy
  // (write() at that stale base), by the same rules as any stale write.
  // Otherwise refuse against the head. A result too large to write is refused
  // outright; write() would refuse the copy as well.
  function editMissedHead(
    call: EditCall,
    onHead: Extract<EditOutcome, { ok: false }>,
    editedBase: EditedVersion | undefined,
    headVersion: number,
  ): Promise<EditResult> | EditResult {
    if (onHead.reason !== "too_large" && applied(editedBase)) {
      return landEdit(call, editedBase, call.baseVersion);
    }
    return { status: "edit_failed", failure: onHead, currentVersion: headVersion };
  }

  // Lands through write(), keeping the file's stored content type (write()
  // would otherwise re-derive it from the extension, turning an extensionless
  // text file into application/octet-stream) and never recreating a file
  // deleted mid-edit: a delete that lands first leaves the edit as a
  // conflicted copy, like any lost write.
  async function landEdit(
    call: EditCall,
    edited: { body: Uint8Array; replacements: number },
    base: number,
  ): Promise<EditResult> {
    const { workspaceId, path, actor, nowIso, contentType } = call;
    const write = await service.write({
      workspaceId,
      path,
      body: edited.body,
      contentType,
      baseVersion: base,
      updateOnly: true,
      actor,
      nowIso,
    });
    return { status: "applied", write, appliedTo: base, replacements: edited.replacements };
  }

  // A blob's bytes when they are editable text, or why they can't be edited.
  async function textAt(
    blobKey: string,
  ): Promise<{ body: Uint8Array } | "blob_missing" | "binary"> {
    const blob = await storage.get(blobKey);
    if (!blob) return "blob_missing";
    return isEditableText(blob.body) ? { body: blob.body } : "binary";
  }

  // The plan limit putting `size` bytes back at `path` would break, or null.
  // Like an ordinary clean write: a create counts toward the file limit, and
  // storage is projected with the path's current bytes replaced.
  async function restoreLimit(
    workspaceId: string,
    path: string,
    size: number,
    creates: boolean,
  ): Promise<"size" | "read_only" | "files" | "storage" | null> {
    const limits = await limitsForWorkspace(workspaceId);
    if (size > limits.maxFileBytes) return "size";
    if (limits.readOnly) return "read_only";
    if (creates && limits.files != null) {
      if ((await db.fileNode.count({ where: { workspaceId } })) >= limits.files) return "files";
    }
    if (limits.storageBytes == null) return null;
    const projected = (await workspaceUsage(workspaceId, { excludePath: path })) + size;
    return projected > limits.storageBytes ? "storage" : null;
  }

  // The head node of a path the viewer may read, or null. Shared by `read` and
  // `open` so the buffered and streaming paths apply one gate.
  async function headNode(workspaceId: string, rawPath: string, viewer: Viewer) {
    const path = normalizePath(rawPath);
    if (!(await gateRead(workspaceId, path, viewer))) return null;
    return db.fileNode.findUnique({ where: { workspaceId_path: { workspaceId, path } } });
  }

  // Where a prior version's bytes live: the most recent event carrying that
  // version number with a content pointer, which resolves to the current
  // incarnation when version numbers were reused after a delete.
  async function versionPointer(
    workspaceId: string,
    rawPath: string,
    version: number,
    viewer: Viewer,
  ): Promise<
    | { status: "ok"; contentHash: string }
    | { status: "not_found" }
    | { status: "version_not_found" }
  > {
    const path = normalizePath(rawPath);
    if (!(await gateRead(workspaceId, path, viewer))) return { status: "not_found" };
    const event = await db.changeEvent.findFirst({
      where: {
        workspaceId,
        path,
        version,
        contentHash: { not: null },
        op: { in: [...CONTENT_POINTER_OPS] },
      },
      orderBy: { seq: "desc" },
    });
    if (!event?.contentHash) {
      // Distinguish "no such path in the feed" from "that version isn't
      // locatable" (e.g. a pre-pointer event, or a delete/conflict version).
      const any = await db.changeEvent.findFirst({ where: { workspaceId, path } });
      return any ? { status: "version_not_found" } : { status: "not_found" };
    }
    return { status: "ok", contentHash: event.contentHash };
  }

  // Per-request read gate. "trusted" is an internal caller (e.g. share
  // serving) and bypasses enforcement; any subject fails closed on a restricted
  // node it holds no grant on.
  async function gateRead(workspaceId: string, path: string, viewer: Viewer): Promise<boolean> {
    if (viewer === "trusted") return true; // skip the ACL fetch
    return canRead(await listWorkspaceAcls(workspaceId), path, viewer);
  }

  // Can `access` write `path`? "ok", or why not: `hidden` surfaces as
  // not-found (never disclose a restricted node), a denial as `read_only`.
  async function gateWrite(
    workspaceId: string,
    path: string,
    access: Viewer,
  ): Promise<"ok" | "hidden" | WriteDenial> {
    if (access === "trusted") return "ok";
    // A file at the key's folder's own path sits beside the subtree, not in it:
    // its conflicted copy would land outside. A folder key changes what's in it.
    const folder = access.keyScope?.folder;
    if (folder === path) return { error: "outside_key_folder", folder };
    return writeRefusal(await listWorkspaceAcls(workspaceId), path, access) ?? "ok";
  }

  /**
   * Drop nodes `subject` may not read. One helper so `list` and `listPaths`
   * cannot drift on the permission rule. The "trusted" bypass is handled by the
   * callers, never here.
   */
  async function filterReadable<T extends { path: string }>(
    workspaceId: string,
    nodes: T[],
    subject: AccessSubject,
    acls?: AclRow[],
  ): Promise<T[]> {
    const rows = acls ?? (await listWorkspaceAcls(workspaceId));
    // No restrictions means everyone reads everything, unless a key is confined
    // to a folder: that cap doesn't come from the restrictions.
    if (rows.length === 0 && !subject.keyScope?.folder) return nodes;
    return nodes.filter((n) => canRead(rows, n.path, subject));
  }

  const service: FileService = {
    async list(workspaceId, prefix, viewer, acls) {
      const normalizedPrefix = prefix ? `${normalizePath(prefix)}/` : "";
      const nodes = await db.fileNode.findMany({
        where: {
          workspaceId,
          ...(normalizedPrefix ? { path: { startsWith: normalizedPrefix } } : {}),
        },
        select: { path: true, size: true, contentType: true, version: true },
        orderBy: { path: "asc" },
      });
      if (viewer === "trusted") return nodes;
      return filterReadable(workspaceId, nodes, viewer, acls);
    },

    async listPaths(workspaceId, subject, acls) {
      // SECURITY: no "trusted" mode here, deliberately. `list` above lets a
      // trusted internal caller see everything (the public share route depends
      // on that). Search returns paths from across the whole tree rather than
      // one chosen prefix, so the same mistake would leak far more.
      if (!subject?.userId) throw new Error("listPaths requires a subject");
      const nodes = await db.fileNode.findMany({
        where: { workspaceId },
        select: { path: true },
        orderBy: { path: "asc" },
      });
      const readable = await filterReadable(workspaceId, nodes, subject, acls);
      return readable.map((n) => n.path);
    },

    async stat(workspaceId, rawPath, viewer) {
      const path = normalizePath(rawPath);
      if (!(await gateRead(workspaceId, path, viewer))) return null;
      const node = await db.fileNode.findUnique({
        where: { workspaceId_path: { workspaceId, path } },
        select: { version: true, contentHash: true, size: true, contentType: true },
      });
      return node ?? null;
    },

    usage(workspaceId, opts) {
      return workspaceUsage(workspaceId, opts);
    },

    fileCount(workspaceId) {
      return db.fileNode.count({ where: { workspaceId } });
    },

    async read(workspaceId, rawPath, viewer) {
      const node = await headNode(workspaceId, rawPath, viewer);
      if (!node) return { status: "not_found" };
      const blob = await storage.get(node.blobKey);
      if (!blob) return { status: "blob_missing" };
      return {
        status: "ok",
        body: blob.body,
        contentType: blob.contentType,
        version: node.version,
        contentHash: node.contentHash,
      };
    },

    async readByHash(workspaceId, contentHash) {
      const blob = await storage.get(blobKeyFor(workspaceId, contentHash));
      if (!blob) return { status: "blob_missing" };
      return { status: "ok", body: blob.body, contentType: blob.contentType };
    },

    async open(workspaceId, rawPath, viewer, rangeFor) {
      const node = await headNode(workspaceId, rawPath, viewer);
      if (!node) return { status: "not_found" };
      const blob = await storage.open(node.blobKey, rangeFor?.(node));
      if (!blob) return { status: "blob_missing" };
      return { status: "ok", blob, version: node.version, contentHash: node.contentHash };
    },

    async openByHash(workspaceId, contentHash, range) {
      const blob = await storage.open(blobKeyFor(workspaceId, contentHash), range);
      return blob ? { status: "ok", blob } : { status: "blob_missing" };
    },

    versionHash({ workspaceId, path, version, viewer }) {
      return versionPointer(workspaceId, path, version, viewer);
    },

    async sealedBlob(workspaceId, contentHash, expectedSize) {
      if (!storage.sealed) return null;
      return storage.sealed(blobKeyFor(workspaceId, contentHash), expectedSize);
    },

    async openVersion({ workspaceId, path, version, viewer, rangeFor }) {
      const pointer = await versionPointer(workspaceId, path, version, viewer);
      if (pointer.status !== "ok") return pointer;
      const range = rangeFor?.({ version, contentHash: pointer.contentHash });
      const blob = await storage.open(blobKeyFor(workspaceId, pointer.contentHash), range);
      if (!blob) return { status: "blob_missing" };
      return { status: "ok", blob, version, contentHash: pointer.contentHash };
    },

    async write({
      workspaceId,
      path: rawPath,
      body,
      contentType,
      baseVersion,
      updateOnly,
      actor,
      nowIso,
      ifStale,
    }) {
      const path = normalizePath(rawPath);
      // Access gate before any work: writing to (or creating under) a path the
      // actor can't see is `forbidden` (routes map it to 404); one they can see
      // but not write is `denied` (409 read_only).
      const gate = await gateWrite(workspaceId, path, actor.access);
      if (gate === "hidden") return { ok: false, forbidden: true };
      if (gate !== "ok") return { ok: false, denied: gate };
      const ct = contentType ?? contentTypeFor(path);
      const source = body instanceof Uint8Array ? bufferSource(body) : body;
      const blob = {
        blobKey: blobKeyFor(workspaceId, source.sha256),
        contentHash: source.sha256,
        size: source.size,
        contentType: ct,
      };

      // Plan-limit gate. Only a clean PRIMARY write is gated — a brand-new
      // file, or an update whose baseVersion matches head. Stale or duplicate
      // writes fall through to the data-preservation paths (resolveWriteMiss /
      // conflicted copies) and must never be blocked, so the gate skips them;
      // move/remove/restore are not gated at all. Skipped entirely when the
      // workspace is unlimited (the dormant default), so it adds no query then.
      const limits = await limitsForWorkspace(workspaceId);

      // Size is checked first and unconditionally: an oversized body can never
      // be stored whatever its write shape, and rejecting here keeps it out of
      // the blob store. Not exempted for conflicted copies because a copy is a
      // duplicate of bytes that already passed this gate.
      if (source.size > limits.maxFileBytes) {
        return {
          ok: false,
          fileTooLarge: true,
          sizeLimit: { bytes: source.size, limitBytes: limits.maxFileBytes },
        };
      }

      // Read-then-write, not a locked reservation: two clean writes to
      // different paths that overlap near a limit can each read the same
      // pre-write totals, both pass, and leave the workspace slightly over.
      // Accepted deliberately — `write()` is the hottest path in the product
      // and taking a lock (or wrapping the blob put and the metadata CAS in one
      // transaction) to make the count exact would cost every write to bound an
      // overshoot of at most the number of requests in flight. The next
      // ordinary write is refused, so the workspace converges on its own.
      if (limits.storageBytes != null || limits.files != null) {
        const existing = await db.fileNode.findUnique({
          where: { workspaceId_path: { workspaceId, path } },
          select: { version: true, size: true },
        });
        const cleanPrimary =
          baseVersion === undefined ? existing === null : existing?.version === baseVersion;
        if (cleanPrimary) {
          // A lapsed subscription past its grace window stops ordinary writes.
          // Checked inside `cleanPrimary` on purpose: a conflicted copy from a
          // stale write is data preservation and must still be kept, even here.
          if (limits.readOnly) return { ok: false, readOnly: true };
          // File count only grows on a create; replacing an existing path
          // leaves it unchanged, so an update is never blocked by this limit
          // even in a workspace sitting exactly on its cap.
          if (limits.files != null && existing === null) {
            const usedFiles = await db.fileNode.count({ where: { workspaceId } });
            if (usedFiles >= limits.files) {
              return {
                ok: false,
                fileCountExceeded: true,
                fileUsage: { usedFiles, limitFiles: limits.files },
              };
            }
          }
          if (limits.storageBytes != null) {
            const limitBytes = limits.storageBytes;
            const usedExcludingPath = await workspaceUsage(workspaceId, { excludePath: path });
            const projected = usedExcludingPath + source.size;
            if (projected > limitBytes) {
              // Report current usage (including the version being replaced) without
              // a second aggregate: it's the path-excluded sum plus the existing
              // row's size. Avoids an unguarded extra query on the reject path.
              const usedBytes = usedExcludingPath + (existing?.size ?? 0);
              return { ok: false, quotaExceeded: true, usage: { usedBytes, limitBytes } };
            }
          }
        }
      }

      // Durability ordering: the blob must be persisted before the metadata CAS
      // so a committed row never points at a missing blob.
      // Re-sealed even when identical bytes are already stored: that repairs a
      // damaged blob and records a corrected content type, neither of which a
      // cheap presence check can vouch for. A ranged read that races the
      // re-seal retries (see the encrypting store's #openRange).
      await storage.putSource(blob.blobKey, source, ct);

      // Whatever path the write took, the bytes now live at the written path or
      // at a conflicted copy: index their links there. Re-reads the source
      // (memory, or the spooled request body) rather than the blob store.
      const settle = async (result: WriteResult): Promise<WriteResult> => {
        const at = pathToIndex(path, result);
        if (at) {
          await indexFileLinks({
            workspaceId,
            path: at,
            contentHash: blob.contentHash,
            contentType: ct,
            size: blob.size,
            read: () => collectBytes(source.open()),
          });
        }
        return result;
      };

      if (baseVersion === undefined) {
        // create-only (If-None-Match: *)
        try {
          await db.fileNode.create({ data: { workspaceId, path, version: 1, ...blob } });
          await recordChange(db, workspaceId, path, "write", 1, actor, blob.contentHash);
          return settle({ ok: true, version: 1 });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Path already exists: idempotent if identical, else conflicted copy.
          return settle(
            await resolveWriteMiss({
              workspaceId,
              path,
              blob,
              actor,
              nowIso,
              resurrectIfAbsent: false,
            }),
          );
        }
      }

      // CAS update against the expected base version. The new version is
      // deterministically baseVersion + 1 — do NOT re-read it (a concurrent CAS
      // could return a newer version describing someone else's bytes).
      const updated = await db.fileNode.updateMany({
        where: { workspaceId, path, version: baseVersion },
        data: { version: { increment: 1 }, ...blob },
      });
      if (updated.count === 1) {
        const version = baseVersion + 1;
        await recordChange(db, workspaceId, path, "write", version, actor, blob.contentHash);
        return settle({ ok: true, version });
      }
      if (ifStale === "fail") return { ok: false, stale: true };

      // Stale base or the row was deleted: never drop bytes.
      return settle(
        await resolveWriteMiss({
          workspaceId,
          path,
          blob,
          actor,
          nowIso,
          resurrectIfAbsent: !updateOnly,
        }),
      );
    },

    async edit(args) {
      // Bounds every intermediate result, so a request that expands the text
      // is refused before the expansion is built, not after (see applyTextEdits).
      const { maxFileBytes: maxBytes } = await limitsForWorkspace(args.workspaceId);
      const call: EditCall = { ...args, path: normalizePath(args.path), maxBytes };
      // The same fail-closed read gate as read_file: an actor who can't see a
      // private path gets not_found, never a hint that it exists.
      const head = await headNode(call.workspaceId, call.path, call.actor.access);
      // A deleted file is not found, even with a baseVersion from before the
      // delete. Unlike a stale write_file, an edit doesn't recreate it: the
      // recreated file restarts at version 1, so a retry of that edit would
      // look current and apply twice. The caller still holds its edit and can
      // recreate the file with write_file if that is what it means.
      if (!head) return { status: "not_found" };
      // Refuse a read-only actor before any replay check: a recognised "retry"
      // must never report success for an edit this actor could not have made.
      const gate = await gateWrite(call.workspaceId, call.path, call.actor.access);
      if (gate !== "ok") return refusedBy(gate);
      call.contentType = head.contentType;
      const current = await textAt(head.blobKey);
      if (typeof current === "string") return { status: current };

      const stale = head.version !== call.baseVersion;
      // Stale: the edit applied to the version the caller read, for replay
      // detection and the conflicted-copy fallback.
      const editedBase = stale ? await editAtBase(call) : undefined;
      const settled =
        editedBase && (await checkReplay(call, head.version, current.body, editedBase));
      if (settled) return settled;

      // Head first, whatever baseVersion says. An edit names the text it
      // replaces, so if that text is still there (exactly once, unless
      // replaceAll) it means what it meant when the caller read it, and
      // someone else's change elsewhere in the file is no reason to refuse it.
      // The write is CAS'd against the head version just read, so a write that
      // lands in between still loses to a conflicted copy, never a clobber.
      const onHead = applyTextEdits(current.body, call.edits, maxBytes);
      if (onHead.ok) return landEdit(call, onHead, head.version);
      return editMissedHead(call, onHead, editedBase, head.version);
    },

    async remove({ workspaceId, path: rawPath, baseVersion, actor }) {
      const path = normalizePath(rawPath);
      const gate = await gateWrite(workspaceId, path, actor.access);
      if (gate !== "ok") return refusedBy(gate);
      const existing = await db.fileNode.findUnique({
        where: { workspaceId_path: { workspaceId, path } },
      });
      if (!existing) return { status: "not_found" };
      // CAS delete: a stale delete loses to a concurrent edit (resurrection over loss).
      const deleted = await db.fileNode.deleteMany({
        where: { workspaceId, path, version: baseVersion },
      });
      if (deleted.count === 1) {
        await recordChange(db, workspaceId, path, "delete", baseVersion, actor);
        await dropFileLinks(db, workspaceId, path);
        return { status: "ok" };
      }
      const current = await db.fileNode.findUnique({
        where: { workspaceId_path: { workspaceId, path } },
      });
      return { status: "conflict", currentVersion: current?.version ?? existing.version };
    },

    async move({ workspaceId, from: rawFrom, to: rawTo, baseVersion, actor, keepPrivateTo }) {
      const from = normalizePath(rawFrom);
      const to = normalizePath(rawTo);
      // Gate the move: the actor must be able to write the source and the
      // destination. A path they can't see reads as not_found (no disclosure);
      // one they can see but not write is denied.
      for (const p of [from, to]) {
        const gate = await gateWrite(workspaceId, p, actor.access);
        if (gate !== "ok") return refusedBy(gate);
      }
      const acls = await listWorkspaceAcls(workspaceId);
      try {
        const result = await db.$transaction(async (tx) => {
          const src = await tx.fileNode.findUnique({
            where: { workspaceId_path: { workspaceId, path: from } },
          });
          if (!src) return { status: "not_found" as const };
          if (baseVersion !== undefined && src.version !== baseVersion) {
            return { status: "conflict" as const, currentVersion: src.version };
          }
          const dest = await tx.fileNode.findUnique({
            where: { workspaceId_path: { workspaceId, path: to } },
          });
          if (dest) return { status: "dest_exists" as const };

          // Like a path brought back from the trash, a path moved into
          // carries on from its own last version, so a client still holding
          // an older file there never mistakes this one for it.
          const version = await nextVersionAt(tx, workspaceId, to);
          await tx.fileNode.create({
            data: {
              workspaceId,
              path: to,
              version,
              contentHash: src.contentHash,
              size: src.size,
              contentType: src.contentType,
              blobKey: src.blobKey,
              // A move is a new row at the new path, but it is the same file:
              // keep when it was first created rather than resetting it on
              // every rename. updatedAt still moves, since the move is a change.
              createdAt: src.createdAt,
            },
          });
          await tx.fileNode.delete({ where: { workspaceId_path: { workspaceId, path: from } } });
          const fromAcl =
            (await carryFileAcl(tx, workspaceId, from, to)) ??
            (await keepPrivate(tx, workspaceId, to, keepPrivateTo, actor));
          // Comment threads follow the file (KTD9). Direct data access — no
          // import from comments.ts (cycle guard, like paths.ts) — and executed
          // AFTER the file_node writes so the lock order stays file_node →
          // comment_thread everywhere. CommentThread has no unique constraint
          // including `path`, so this update can never raise the P2002 that the
          // catch below reports as dest_exists. FileReadState is deliberately
          // NOT carried (hash-keyed reads make its staleness safe).
          await tx.commentThread.updateMany({
            where: { workspaceId, path: from },
            data: { path: to },
          });
          await dropFileLinks(tx, workspaceId, from);
          const { privateFrom, privateTo } = movePrivacy(acls, from, to, fromAcl);
          await recordChange(
            tx,
            workspaceId,
            from,
            "delete",
            src.version,
            actor,
            null,
            to,
            privateFrom,
          );
          await recordChange(
            tx,
            workspaceId,
            to,
            "move",
            version,
            actor,
            src.contentHash,
            from,
            privateTo,
          );
          return { status: "ok" as const, version, moved: src };
        });
        if (result.status !== "ok") return result;
        // Rebuilt at the new path once the move has committed: its relative
        // links now resolve from a different folder.
        await indexStored(workspaceId, to, result.moved);
        return { status: "ok" as const, version: result.version };
      } catch (err) {
        // A concurrent writer created `to` between our check and create (or,
        // for a recovery move, a private mark there).
        if (isUniqueViolation(err)) return { status: "dest_exists" as const };
        // Recovery: `to` stopped being the mover's to write (keepPrivate).
        if (err instanceof ChangedSincePlan) return { status: "not_found" as const };
        throw err;
      }
    },

    async readVersion({ workspaceId, path, version, viewer }) {
      const pointer = await versionPointer(workspaceId, path, version, viewer);
      if (pointer.status !== "ok") return pointer;
      const blob = await storage.get(blobKeyFor(workspaceId, pointer.contentHash));
      if (!blob) return { status: "blob_missing" };
      return {
        status: "ok",
        body: blob.body,
        contentType: blob.contentType,
        version,
        contentHash: pointer.contentHash,
      };
    },

    async restoreContent({
      workspaceId,
      path: rawPath,
      contentHash,
      expect,
      actor,
      deletedAt,
      keepPrivateTo,
    }) {
      const path = normalizePath(rawPath);
      if (!canWrite(await listWorkspaceAcls(workspaceId), path, actor.access)) {
        return { status: "forbidden" };
      }
      // The bytes are already stored under their content-addressed key; finding
      // them is what keeps "a committed row never points at missing bytes".
      const blobKey = blobKeyFor(workspaceId, contentHash);
      const meta = await storage.stat(blobKey);
      if (!meta) return { status: "blob_missing" };
      const blob = { blobKey, contentHash, size: meta.size, contentType: meta.contentType };

      const blocked = await restoreLimit(workspaceId, path, blob.size, expect === "absent");
      if (blocked) return { status: "limit", limit: blocked };

      // The row and its event commit together: a restored file is never left
      // without the event that tells the feed (and every synced client) so.
      try {
        const restored = await db.$transaction(async (tx) => {
          if (expect === "absent") {
            // A path brought back continues its version numbers rather than
            // starting again at 1. A synced client that still holds, say, v1 of
            // the deleted file must not mistake different bytes for that same
            // version and skip pulling them.
            const version = await nextVersionAt(tx, workspaceId, path);
            await tx.fileNode.create({ data: { workspaceId, path, version, ...blob } });
            // Checked after the create: from here no one else can create the
            // path until this commits, so a recreate-and-delete that slipped in
            // first is visible now.
            if (
              deletedAt !== undefined &&
              (await lastFileSeq(tx, workspaceId, path)) !== deletedAt
            ) {
              throw new ChangedSincePlan();
            }
            await keepPrivate(tx, workspaceId, path, keepPrivateTo, actor);
            await recordChange(tx, workspaceId, path, "restore", version, actor, contentHash);
            return { status: "ok" as const, version, size: blob.size };
          }
          const updated = await tx.fileNode.updateMany({
            where: { workspaceId, path, version: expect },
            data: { version: { increment: 1 }, ...blob },
          });
          if (updated.count !== 1) return { status: "changed" as const };
          // Content that was private when recorded stays private, even where
          // the file is shared now. Members who have it are told to drop it,
          // as when its owner makes it private, before the content changes.
          await keepPrivate(tx, workspaceId, path, keepPrivateTo, actor);
          await recordChange(tx, workspaceId, path, "restore", expect + 1, actor, contentHash);
          return { status: "ok" as const, version: expect + 1, size: blob.size };
        });
        if (restored.status === "ok") await indexStored(workspaceId, path, blob);
        return restored;
      } catch (err) {
        if (!isUniqueViolation(err) && !(err instanceof ChangedSincePlan)) throw err;
        return { status: "changed" };
      }
    },

    async restore({ workspaceId, path: rawPath, targetVersion, actor, nowIso }) {
      const path = normalizePath(rawPath);
      const gate = await gateWrite(workspaceId, path, actor.access);
      if (gate !== "ok") return refusedBy(gate);
      const target = await versionPointer(workspaceId, path, targetVersion, "trusted");
      if (target.status !== "ok") return target;

      // The bytes already exist under their content-addressed key, so a restore
      // needs only their size and type, not the bytes themselves: reading and
      // re-putting a 2 GB version would hold it in memory twice to rewrite an
      // identical object. `stat` finding the blob is what keeps the durability
      // invariant (a committed row never points at missing bytes). Its integrity
      // is checked when it is next read, exactly as for any other version.
      const blobKey = blobKeyFor(workspaceId, target.contentHash);
      const meta = await storage.stat(blobKey);
      if (!meta) return { status: "blob_missing" };
      const blob = {
        blobKey,
        contentHash: target.contentHash,
        size: meta.size,
        contentType: meta.contentType,
      };
      const reindex = (at: string) => indexStored(workspaceId, at, blob);

      // Retry the CAS against whatever the current version is, so a restore
      // lands on top even if the file advanced since the panel was opened (R9).
      const MAX_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const existing = await db.fileNode.findUnique({
          where: { workspaceId_path: { workspaceId, path } },
        });
        if (!existing) {
          // The file was deleted under us: resurrect it as a fresh v1.
          try {
            await db.fileNode.create({ data: { workspaceId, path, version: 1, ...blob } });
            await recordChange(db, workspaceId, path, "restore", 1, actor, blob.contentHash);
            await reindex(path);
            return { status: "ok", version: 1, restoredFrom: targetVersion };
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            continue; // lost the resurrect race — re-read and retry
          }
        }
        const updated = await db.fileNode.updateMany({
          where: { workspaceId, path, version: existing.version },
          data: { version: { increment: 1 }, ...blob },
        });
        if (updated.count === 1) {
          const version = existing.version + 1;
          await recordChange(db, workspaceId, path, "restore", version, actor, blob.contentHash);
          await reindex(path);
          return { status: "ok", version, restoredFrom: targetVersion };
        }
        // Someone else advanced the version between our read and CAS — retry.
      }

      // Sustained contention exhausted the retries: never clobber, never error —
      // keep the restored bytes as a conflicted copy (KTD2).
      const miss = await resolveWriteMiss({
        workspaceId,
        path,
        blob,
        actor,
        nowIso,
        resurrectIfAbsent: true,
      });
      const changed = pathToIndex(path, miss);
      if (changed) await reindex(changed);
      if (miss.ok && miss.version !== undefined) {
        return { status: "ok", version: miss.version, restoredFrom: targetVersion };
      }
      return {
        status: "conflict",
        currentVersion: miss.conflict?.currentVersion ?? null,
        conflictCopyPath: miss.conflict?.conflictCopyPath ?? path,
      };
    },
  };
  return service;
}

/**
 * An explicit file-level ACL follows its file to the new path; otherwise the
 * moved node inherits the destination's access set (R10/R11). Returns the ACL
 * that moved, if any.
 */
async function carryFileAcl(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  from: string,
  to: string,
): Promise<AclRow | null> {
  const fromAcl = await tx.nodeAcl.findUnique({
    where: { workspaceId_path: { workspaceId, path: from } },
    select: ACL_SELECT,
  });
  if (fromAcl) await rePathRestriction(tx, workspaceId, from, to);
  return fromAcl;
}

/** Rolls back a recovery write whose path changed after it was planned. */
class ChangedSincePlan extends Error {}

/** The version a file newly at `path` gets: one past any it has had before. */
async function nextVersionAt(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  path: string,
): Promise<number> {
  const prior = await tx.changeEvent.aggregate({
    where: { workspaceId, path },
    _max: { version: true },
  });
  return (prior._max.version ?? 0) + 1;
}

/** Change-feed position of the last file change at `path`, or null. */
async function lastFileSeq(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  path: string,
): Promise<bigint | null> {
  const last = await tx.changeEvent.findFirst({
    where: { workspaceId, path, op: { in: [...FILE_OPS] } },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return last?.seq ?? null;
}

/**
 * Give `path` its own private mark for `owner` unless what governs it already
 * keeps it private to them. Returns the mark it made, if any. Used by recovery,
 * so content brought back never becomes visible to more people than it was.
 *
 * It also re-checks, inside the write's transaction, that the actor may still
 * write `path`: a member's private folder moved over it since the first check
 * means the write is abandoned as changed. A mark is only ever created, never
 * written over an existing one, so it can't replace anyone else's privacy
 * either; one created meanwhile surfaces as a unique violation.
 *
 * A new mark is announced as any change of access is (see recordAccessChange),
 * before the caller records its change: a member's synced copy from while the
 * path was shared is removed, even if they missed the events in between, which the
 * feed now withholds from them.
 */
async function keepPrivate(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  path: string,
  owner: string | null | undefined,
  actor: Actor,
): Promise<AclRow | null> {
  const acls = await tx.nodeAcl.findMany({ where: { workspaceId }, select: ACL_SELECT });
  if (!canWrite(acls, path, actor.access)) throw new ChangedSincePlan();
  if (!owner || encodeGrants(effectiveAcl(acls, path)) === owner) return null;
  const before = encodeGrants(effectiveAcl(acls, path));
  const mark = await createRestriction(tx, {
    workspaceId,
    path,
    kind: "file",
    grants: decodeGrants(owner),
  });
  await recordAccessChange(tx, { workspaceId, path, actor, before, grants: mark.grants });
  return mark;
}

/**
 * Who each side of a move was private to, for its two events: the old path's
 * governing ACL, and at the new path either the file's own ACL (which travelled
 * with it) or whatever the destination inherits. "" when shared.
 */
function movePrivacy(
  acls: AclRow[],
  from: string,
  to: string,
  carried: AclRow | null,
): { privateFrom: string; privateTo: string } {
  return {
    privateFrom: encodeGrants(effectiveAcl(acls, from)),
    privateTo: encodeGrants(carried ?? effectiveAcl(acls, to)),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}