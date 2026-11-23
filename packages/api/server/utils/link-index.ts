import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { type Prisma, usePrismaClient } from "db";
import { viewerKind } from "shared";
import { noteIndexEntry } from "shared/linkScan";
import { useBlobStore } from "./storage";
import { resolveKekRing } from "./workspace-keys";

// ---------------------------------------------------------------------------
// Maintenance of the backlink index (the `file_links` table): one row per
// markdown file listing the hashed keys its links ask for. The file service
// calls in here after every content change, so REST, MCP and every future write
// path keep it current without knowing it exists. Queries over the index live
// in ./links.ts, which may import the file service; this module must not (the
// file service imports it).
//
// The index is derived data. Nothing here may fail the write that triggered it:
// a missed update leaves a row whose content hash no longer matches its file,
// and `catchUpLinkIndex` rebuilds exactly those rows the next time anyone asks
// for backlinks in that workspace.
// ---------------------------------------------------------------------------

/**
 * Bigger notes aren't scanned, which bounds what one write can cost. Their row
 * says so (`scanned: false`), as does a note too pathological to scan to the
 * end, and a rename reports them as notes it couldn't check rather than
 * silently passing them over.
 */
export const MAX_INDEXED_BYTES = 2 * 1024 * 1024;

/** How long an unreadable note waits before catch-up tries reading it again. */
const UNREADABLE_RETRY_MINUTES = 10;

/** How many stale or missing rows one catch-up pass rebuilds. */
const CATCH_UP_BATCH = 100;
const CATCH_UP_CONCURRENCY = 8;

interface IndexKey {
  /** Stored on each row, so rows built under another key are recognisably stale. */
  id: string;
  secret: Buffer;
  /** Encrypts each row's tag names (AES-256-GCM): listing tags needs them back. */
  tagSecret: Buffer;
}

/**
 * Part of every row's key id. Bumping it makes every row stale, so catch-up
 * rescans notes when the index starts recording something new (v2: tags).
 */
const INDEX_VERSION = "v2";

let indexKey: { kek: string | undefined; key: IndexKey } | null = null;

/**
 * The HMAC key for index hashes, derived from the blob master key (BLOB_KEK).
 * A database copy holds every file's path in plaintext, so an unkeyed hash of a
 * path-derived key could be recomputed from the dump and matched against the
 * index, recovering which notes link to which. The master key is never in the
 * database, so neither is anything that can do that. Without a master key
 * (local development only; production refuses to boot without one) file bytes
 * are stored in plaintext anyway, and a fixed key keeps the index working.
 */
function currentIndexKey(): IndexKey {
  const kek = process.env.BLOB_KEK;
  if (indexKey && indexKey.kek === kek) return indexKey.key;
  const ring = resolveKekRing(process.env);
  const derive = (info: string) =>
    ring ? Buffer.from(hkdfSync("sha256", ring.active.key, Buffer.alloc(0), info, 32)) : null;
  const key: IndexKey = {
    id: `${INDEX_VERSION}/${ring ? `kek:${ring.active.id}` : "none"}`,
    secret:
      derive("treehouse link index v1") ?? Buffer.from("treehouse link index (no master key)"),
    tagSecret:
      derive("treehouse tag index v1") ?? hkdfSyncBuffer("treehouse tag index (no master key)"),
  };
  indexKey = { kek, key };
  return key;
}

/** A fixed 32-byte key for local development without a master key (see currentIndexKey). */
function hkdfSyncBuffer(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(info), Buffer.alloc(0), info, 32));
}

/**
 * Encrypt a note's tag names for its row. Tags are file content, and file
 * content is encrypted at rest, so they don't sit in the database readable
 * either; the workspace id is bound in, so a row can't be moved to another.
 */
export function sealTags(workspaceId: string, tags: string[]): Buffer | null {
  if (tags.length === 0) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", currentIndexKey().tagSecret, iv);
  cipher.setAAD(Buffer.from(workspaceId));
  const body = Buffer.concat([cipher.update(JSON.stringify(tags), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** A row's tag names, or none when it has none or they don't decrypt under the current key. */
export function openTags(workspaceId: string, sealed: Uint8Array | null): string[] {
  if (!sealed || sealed.length < 28) return [];
  try {
    const buf = Buffer.from(sealed);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      currentIndexKey().tagSecret,
      buf.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(workspaceId));
    decipher.setAuthTag(buf.subarray(12, 28));
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
    const tags: unknown = JSON.parse(text);
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** The id of the key current rows are built with. */
export function linkIndexKeyId(): string {
  return currentIndexKey().id;
}

/**
 * The stored form of an index key: an HMAC under the index key (see above).
 * The workspace id is part of the message, so equal keys in different
 * workspaces never share a hash.
 */
export function linkKeyHash(workspaceId: string, key: string): string {
  return createHmac("sha256", currentIndexKey().secret)
    .update(`${workspaceId}\0${key}`)
    .digest("hex")
    .slice(0, 40);
}

/** Whether a file takes part in linking. Same test the app uses to render markdown. */
export function isLinkSource(path: string, contentType: string): boolean {
  return viewerKind(contentType, path) === "markdown";
}

/**
 * Whether a file keeps a row: every link source, plus every file catch-up's
 * cheaper query admits (see `catchUpLinkIndex`). One that turns out not to be
 * markdown (a `.md` stored as text/plain) gets an empty row, or catch-up would
 * select it again on every pass.
 */
function mayBeLinkSource(path: string, contentType: string): boolean {
  return (
    isLinkSource(path, contentType) ||
    /\.(md|markdown)$/i.test(path) ||
    contentType.startsWith("text/markdown")
  );
}

/** Read a body to bytes, for re-reading a write's spooled source. */
export async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export interface IndexFileArgs {
  workspaceId: string;
  path: string;
  /** The bytes the caller just stored. The row is only written while the file still holds them. */
  contentHash: string;
  contentType: string;
  size: number;
  /**
   * Supplies those bytes; null when they can't be read. An unreadable file (a
   * missing or damaged blob) gets a row marked unscanned rather than none, so it
   * can't hold the index "incomplete" forever; catch-up retries it later.
   */
  read: () => Promise<Uint8Array | null>;
}

/**
 * Bring one file's row in line with the bytes it now holds. Never throws.
 *
 * One statement, and only while the file still holds the bytes the row was
 * built from, so a slow indexer for older bytes can't overwrite a newer row
 * once that file has moved on. Two writes racing through the narrow window
 * between that check and the upsert can still leave the older row behind; its
 * hash then disagrees with the file's, which is exactly what
 * `catchUpLinkIndex` repairs before any query is answered. That costs nothing
 * on the write path, where a lock would cost every markdown write.
 *
 * False when the row couldn't be written, so catch-up doesn't count it as done.
 */
export async function indexFileLinks(args: IndexFileArgs): Promise<boolean> {
  const { workspaceId, path, contentHash } = args;
  try {
    const db = usePrismaClient();
    if (!mayBeLinkSource(path, args.contentType)) {
      await db.fileLinks.deleteMany({ where: { workspaceId, sourcePath: path } });
      return true;
    }
    const { targets, tags, scanned } = await scanFile(args);
    const keyId = linkIndexKeyId();
    const tagNames = sealTags(workspaceId, tags);
    await db.$executeRaw`
      INSERT INTO file_links
        ("workspaceId", "sourcePath", "contentHash", "keyId", targets, "tagNames", scanned, "updatedAt")
      SELECT ${workspaceId}, ${path}, ${contentHash}, ${keyId}, ${targets}::text[],
             ${tagNames}::bytea, ${scanned}, now()
      WHERE EXISTS (
        SELECT 1 FROM file_node
        WHERE "workspaceId" = ${workspaceId} AND path = ${path} AND "contentHash" = ${contentHash}
      )
      ON CONFLICT ("workspaceId", "sourcePath") DO UPDATE
        SET "contentHash" = EXCLUDED."contentHash",
            "keyId" = EXCLUDED."keyId",
            targets = EXCLUDED.targets,
            "tagNames" = EXCLUDED."tagNames",
            scanned = EXCLUDED.scanned,
            "updatedAt" = EXCLUDED."updatedAt"
    `;
    return true;
  } catch (err) {
    console.error(`failed to index links for a file in workspace ${workspaceId}:`, err);
    return false;
  }
}

interface FileScan {
  /** Hashed link targets and tag keys. */
  targets: string[];
  /** Tag names as written, for listing. */
  tags: string[];
  /** Whether the bytes could be scanned at all. */
  scanned: boolean;
}

/** What a file links to and is tagged with. */
async function scanFile(args: IndexFileArgs): Promise<FileScan> {
  // Not markdown after all: links nowhere, and that's a complete answer.
  if (!isLinkSource(args.path, args.contentType)) return { targets: [], tags: [], scanned: true };
  const bytes = args.size <= MAX_INDEXED_BYTES ? await args.read().catch(() => null) : null;
  if (!bytes) return { targets: [], tags: [], scanned: false };
  const entry = noteIndexEntry(new TextDecoder().decode(bytes), args.path);
  const targets = entry.keys.map((k) => linkKeyHash(args.workspaceId, k));
  // A scan cut short by its work budget may have missed links: say so, so a
  // rename reports the note rather than trusting a partial row.
  return { targets, tags: entry.tags, scanned: entry.complete };
}

/**
 * Notes whose links the index doesn't know: too big to scan, or unreadable
 * when last tried. A rename can't tell whether they link to the file it moves.
 */
export async function unscannedLinkSources(workspaceId: string): Promise<string[]> {
  const rows = await usePrismaClient().fileLinks.findMany({
    where: { workspaceId, keyId: linkIndexKeyId(), scanned: false },
    select: { sourcePath: true },
  });
  return rows.map((r) => r.sourcePath);
}

/** The tags on one note, as written. The caller has already checked the actor can read it. */
export async function noteTags(workspaceId: string, path: string): Promise<string[]> {
  const row = await usePrismaClient().fileLinks.findUnique({
    where: { workspaceId_sourcePath: { workspaceId, sourcePath: path } },
    select: { keyId: true, tagNames: true },
  });
  return row && row.keyId === linkIndexKeyId() ? openTags(workspaceId, row.tagNames) : [];
}

/** Drop a file's row (it was deleted, or moved away). */
export async function dropFileLinks(
  tx: Prisma.TransactionClient | ReturnType<typeof usePrismaClient>,
  workspaceId: string,
  path: string,
): Promise<void> {
  await tx.fileLinks.deleteMany({ where: { workspaceId, sourcePath: path } });
}

/**
 * Rebuild rows that are missing, were built from other bytes, or were built
 * under an older index key — files written before the index existed, whose
 * update was lost to a crash, or indexed before a master-key rotation — and,
 * once they have waited a while, notes that couldn't be read last time. Bounded
 * per call; returns true once nothing is left to do, so a caller can say when
 * its answer may still be incomplete. A row that couldn't be written counts as
 * left to do: a rename must not go ahead on a note the index missed.
 *
 * The file filter here must admit only files `indexFileLinks` keeps a row for
 * (see mayBeLinkSource), or the same files would be selected forever.
 */
export async function catchUpLinkIndex(
  workspaceId: string,
  limit = CATCH_UP_BATCH,
): Promise<boolean> {
  const db = usePrismaClient();
  const rows = await db.$queryRaw<
    { path: string; contentHash: string; blobKey: string; contentType: string; size: number }[]
  >`
    SELECT f.path, f."contentHash", f."blobKey", f."contentType", f.size
    FROM file_node f
    LEFT JOIN file_links l
      ON l."workspaceId" = f."workspaceId" AND l."sourcePath" = f.path
    WHERE f."workspaceId" = ${workspaceId}
      AND (lower(f.path) LIKE '%.md' OR lower(f.path) LIKE '%.markdown'
           OR f."contentType" LIKE 'text/markdown%')
      AND (l."sourcePath" IS NULL OR l."contentHash" <> f."contentHash"
           OR l."keyId" <> ${linkIndexKeyId()}
           OR (NOT l.scanned AND f.size <= ${MAX_INDEXED_BYTES}
               AND l."updatedAt" < now() - make_interval(mins => ${UNREADABLE_RETRY_MINUTES})))
    ORDER BY f.path
    LIMIT ${limit + 1}
  `;
  const batch = rows.slice(0, limit);
  const storage = useBlobStore();
  let repaired = true;
  for (let i = 0; i < batch.length; i += CATCH_UP_CONCURRENCY) {
    const results = await Promise.all(
      batch.slice(i, i + CATCH_UP_CONCURRENCY).map((row) =>
        indexFileLinks({
          workspaceId,
          path: row.path,
          contentHash: row.contentHash,
          contentType: row.contentType,
          size: row.size,
          read: async () => (await storage.get(row.blobKey))?.body ?? null,
        }),
      ),
    );
    repaired &&= results.every(Boolean);
  }
  return repaired && rows.length <= limit;
}