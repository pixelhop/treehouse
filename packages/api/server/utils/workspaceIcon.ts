import { createHash } from "node:crypto";
import { type Prisma, usePrismaClient } from "db";
import { createError } from "h3";
import { UPLOADED_ICON_PREFIX, uploadedIconHash } from "shared";
import { useBlobStore } from "./storage";

/**
 * Uploaded workspace icons (a logo or app icon) live in the blob store, NOT in
 * the file tree — an icon is chrome, not a synced file, so it must not appear in
 * anyone's local folder or count against the workspace's storage quota.
 *
 * `Workspace.icon` stays the single source of truth for "what the icon is": an
 * emoji, an Iconify name, or `upload:<sha256>` (the `shared` encoding, parsed by
 * the app too) pointing at the stored bytes. Blobs are content-addressed
 * (`icons/<workspaceId>/<sha256>`) and therefore immutable, so the serving route
 * can be cached forever.
 */

/** Hard cap on stored icon bytes. The web uploader downscales to 256px first,
 *  which lands well under this; the cap is the backstop for direct API/MCP use. */
export const MAX_ICON_BYTES = 1024 * 1024;

/** Formats we store. SVG is deliberately excluded: it can carry script, and
 *  these bytes are served from the API origin. The web uploader rasterises SVG
 *  to PNG before it ever reaches here. */
const SIGNATURES: Array<{ contentType: string; matches: (b: Uint8Array) => boolean }> = [
  {
    contentType: "image/png",
    matches: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { contentType: "image/jpeg", matches: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  {
    contentType: "image/gif",
    matches: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a",
  },
  {
    contentType: "image/webp",
    matches: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP",
  },
];

function starts(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  if (bytes.length < to) return "";
  return Buffer.from(bytes.subarray(from, to)).toString("latin1");
}

/**
 * Identify an image by its magic bytes. The declared Content-Type is never
 * trusted — the sniffed type is what gets stored and echoed back on read, so a
 * mislabelled (or hostile) upload can't make us serve arbitrary bytes as HTML.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.matches(bytes))?.contentType ?? null;
}

/**
 * Where an icon's bytes live.
 *
 * The key is `<workspaceId>/icon-<sha256>`, NOT `icons/<workspaceId>/<sha256>`:
 * `splitBlobKey` requires exactly two segments so an encrypted blob can be
 * bound to the workspace it belongs to, and it rejects a nested key rather than
 * guess. A three-segment key therefore throws the moment a KEK is configured —
 * which production refuses to boot without — so it would have worked in every
 * local run and in nothing else.
 *
 * The `icon-` prefix keeps it out of the file namespace, where keys are bare
 * hashes. Sharing that namespace would be worse than untidy: a logo also stored
 * as a file in the workspace would hash to the same key, and replacing the icon
 * would delete the file's bytes.
 */
export function iconBlobKey(workspaceId: string, hash: string): string {
  return `${workspaceId}/icon-${hash}`;
}

/** The transaction client every icon write runs on. */
type IconTx = Prisma.TransactionClient;

/**
 * Run an icon write inside a per-workspace critical section.
 *
 * An icon lives in two stores — the pointer in Postgres, the bytes in the blob
 * store — and cleaning up a replaced icon is a compare-and-delete across both.
 * No amount of re-reading makes that atomic: whatever cleanup checks, an upload
 * that has already written its bytes but not yet committed its pointer can
 * publish the hash afterwards, and the workspace ends up naming bytes that were
 * deleted a moment earlier. Two rounds of unlocked rechecks each failed on a
 * later version of exactly that interleaving.
 *
 * So the write is serialized instead: validation, the blob write and the pointer
 * publication all happen under one transaction-scoped advisory lock, the same
 * mechanism the file service uses to serialize conflicted-copy creation. The
 * lock releases on commit or rollback, it is taken per workspace, and no read
 * path takes it — icon writes are rare and never contend with browsing.
 *
 * Cleaning up the REPLACED bytes is deliberately not part of that transaction;
 * see {@link commitIconChange}.
 */
export async function withWorkspaceIconLock<T>(
  workspaceId: string,
  fn: (tx: IconTx) => Promise<T>,
): Promise<T> {
  const lockKey = `treehouse:icon:${workspaceId}`;
  return usePrismaClient().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      return fn(tx);
    },
    // The blob write happens inside, so the ceiling has to allow for object
    // storage rather than just a query. Icons are capped at 1MB.
    { timeout: 20_000, maxWait: 10_000 },
  );
}

/**
 * Publish an icon change, then drop the bytes it replaced.
 *
 * Two transactions, on purpose. A blob delete cannot be rolled back, so it must
 * never run inside the transaction that publishes the pointer: if that
 * transaction then fails to commit — a lock wait, a slow delete crossing the
 * timeout, a dropped connection — Postgres restores the OLD icon while its
 * bytes are already gone. That needs no concurrency at all, just one writer and
 * one failed commit, and it breaks an icon that was working a moment earlier.
 *
 * So the pointer commits first, and cleanup runs afterwards in its own locked
 * transaction that stages no writes whatsoever. Nothing it does can be undone
 * into a pointer whose bytes it has already removed, and taking the lock again
 * means it still re-reads the current pointer with no writer able to slip past.
 *
 * Between the two, the lock is released. That is safe: any writer that takes it
 * in the gap either moves the icon on (leaving the replaced hash unreferenced,
 * which is what cleanup wants) or re-uploads the replaced image, which writes
 * its bytes back and makes cleanup's fresh read skip the delete.
 */
export async function commitIconChange<T extends { icon: string | null }>(
  workspaceId: string,
  publish: (tx: IconTx, currentIcon: string | null) => Promise<T>,
): Promise<T> {
  const { result, previous } = await withWorkspaceIconLock(workspaceId, async (tx) => {
    // Read inside the lock: callers validate against this, and validating
    // against a stale read is how a concurrent upload's bytes get adopted.
    const before = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { icon: true },
    });
    const previous = before?.icon ?? null;
    return { result: await publish(tx, previous), previous };
  });

  // Best-effort, and never allowed to fail the request: the pointer is already
  // committed and correct, so a stray orphaned blob is not worth reporting a
  // successful icon change as a failure.
  await withWorkspaceIconLock(workspaceId, (tx) =>
    deleteReplacedIcon(tx, workspaceId, previous, result.icon),
  ).catch(() => {});

  return result;
}

/**
 * Store uploaded icon bytes and point the workspace at them. Validates format +
 * size, then drops the blob it replaced so a workspace never accumulates every
 * logo it has ever worn. Returns the updated workspace row.
 */
export async function setUploadedWorkspaceIcon(workspaceId: string, bytes: Uint8Array) {
  if (bytes.byteLength === 0) {
    throw createError({ statusCode: 400, statusMessage: "Empty image" });
  }
  if (bytes.byteLength > MAX_ICON_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `Image too large (max ${Math.round(MAX_ICON_BYTES / 1024)}KB)`,
    });
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw createError({
      statusCode: 400,
      statusMessage: "Unsupported image format (use PNG, JPEG, GIF or WebP)",
    });
  }

  const hash = createHash("sha256").update(bytes).digest("hex");
  return commitIconChange(workspaceId, async (tx) => {
    // Inside the publishing transaction, so no cleanup can run between these
    // bytes landing and the pointer below naming them. Written BEFORE the
    // pointer either way: a failed write leaves the old icon intact, where the
    // reverse order would point at bytes that never arrived. A write whose
    // transaction then rolls back leaves these bytes orphaned, which is the
    // harmless direction to fail in.
    await useBlobStore().put(iconBlobKey(workspaceId, hash), bytes, contentType);
    return tx.workspace.update({
      where: { id: workspaceId },
      data: { icon: `${UPLOADED_ICON_PREFIX}${hash}` },
      select: { id: true, name: true, icon: true, color: true, theme: true, themeCss: true },
    });
  });
}

/**
 * Delete the blob behind an uploaded icon that is no longer referenced.
 *
 * MUST be called inside {@link withWorkspaceIconLock}, and only from a
 * transaction that stages no writes — it is the delete half of the
 * compare-and-delete that lock exists to protect, and the delete cannot be
 * rolled back if that transaction later fails. The reference is re-read rather
 * than taken from the caller's `nextIcon`, which covers both the legal no-op
 * where one writer clears the icon while another re-sends the same one, and
 * anything that changed while the lock was released between publishing and
 * cleaning up.
 */
export async function deleteReplacedIcon(
  tx: IconTx,
  workspaceId: string,
  previousIcon: string | null,
  nextIcon: string | null,
) {
  const stale = uploadedIconHash(previousIcon);
  if (!stale || stale === uploadedIconHash(nextIcon)) return;

  const current = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { icon: true },
  });
  if (!current || uploadedIconHash(current.icon) === stale) return;
  // Best-effort: a workspace pointing at a live icon matters more than a stray
  // orphaned blob, so cleanup failures must not fail the update.
  await useBlobStore()
    .delete(iconBlobKey(workspaceId, stale))
    .catch(() => {});
}

/**
 * Validate an icon value arriving from a client or an agent (PATCH, create,
 * MCP). `upload:` values are minted only by the upload path — a caller may echo
 * back the icon a workspace already wears (the edit dialog does exactly that
 * when only the name or colour changed), but may not invent one, which would
 * otherwise let anyone point a workspace at another workspace's blob key.
 */
export function assertSettableIcon(icon: string | null, currentIcon: string | null): void {
  if (!icon?.startsWith(UPLOADED_ICON_PREFIX)) return;
  if (icon === currentIcon) return;
  throw createError({
    statusCode: 400,
    statusMessage:
      "Upload an image via POST /api/workspaces/:workspaceId/icon to set an image icon",
  });
}