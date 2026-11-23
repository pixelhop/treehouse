import { usePrismaClient } from "db";

// Per-file details for the web app's listings: when a file was created and last
// changed, who changed it, and whether it is new to the person looking. Served
// by `/list?details=1` only — the sync CLI and desktop app list far more often
// and need none of it, so they never pay for the extra query.

/** How recent a change must be to count as new, so a first look at an old
 *  workspace is not a wall of markers for files nobody has opened in months. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface FileModifier {
  principal: string; // agent | human
  actorId: string | null;
  actorLabel: string | null;
}

export interface FileDetail {
  createdAt: string;
  updatedAt: string;
  modifiedBy: FileModifier | null;
  /** Changed recently by someone else (or by an agent) and not yet opened. */
  unseen: boolean;
}

interface Row {
  path: string;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
  principal: string | null;
  actorId: string | null;
  actorLabel: string | null;
  seenHash: string | null;
}

/**
 * Whether a change is new to `userId`. Your own edits in the app are never new
 * to you; an agent's are, even one on your own key, because that is exactly
 * the change you have not seen yet. "Seen" is the per-file read state the
 * catch-up recap already keeps, compared by content hash.
 */
export function isUnseen(
  row: Pick<Row, "contentHash" | "updatedAt" | "principal" | "actorId" | "seenHash">,
  userId: string | null,
  now: number = Date.now(),
): boolean {
  // No actor means nobody made it: the starter kit a new workspace is seeded
  // with (and events older than attribution). Flagging those would greet every
  // new workspace with markers on files its owner was just given.
  if (!row.principal || !row.actorId) return false;
  if (now - row.updatedAt.getTime() > NEW_WINDOW_MS) return false;
  if (row.principal === "human" && row.actorId === userId) return false;
  return row.seenHash !== row.contentHash;
}

/**
 * Details for every live file in a workspace, keyed by path. The caller merges
 * them onto entries it has already filtered for access, so a path the caller
 * cannot read never gains details it could see.
 *
 * The modifier is the newest content event at the file's path (comments and
 * access changes don't count as editing the file). One index probe per file on
 * change_event(workspaceId, path, seq), rather than a scan of the whole feed.
 */
export async function listFileDetails(
  workspaceId: string,
  userId: string | null,
): Promise<Map<string, FileDetail>> {
  const rows = await usePrismaClient().$queryRaw<Row[]>`
    SELECT f."path", f."contentHash", f."createdAt", f."updatedAt",
           e."principal", e."actorId", e."actorLabel",
           r."lastSeenContentHash" AS "seenHash"
    FROM "file_node" f
    LEFT JOIN LATERAL (
      SELECT c."principal", c."actorId", c."actorLabel"
      FROM "change_event" c
      WHERE c."workspaceId" = f."workspaceId" AND c."path" = f."path"
        AND c."op" IN ('write', 'move', 'restore', 'conflict')
      ORDER BY c."seq" DESC
      LIMIT 1
    ) e ON TRUE
    LEFT JOIN "file_read_state" r
      ON r."workspaceId" = f."workspaceId" AND r."path" = f."path" AND r."userId" = ${userId}
    WHERE f."workspaceId" = ${workspaceId}`;

  const now = Date.now();
  const out = new Map<string, FileDetail>();
  for (const row of rows) {
    out.set(row.path, {
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      modifiedBy: row.principal
        ? { principal: row.principal, actorId: row.actorId, actorLabel: row.actorLabel }
        : null,
      unseen: isUnseen(row, userId, now),
    });
  }
  return out;
}
/**
 * `entries` with their details merged on when `wanted`, else unchanged. Merged
 * by path onto a list the caller has already filtered for access, so a file the
 * caller cannot read never gains anything.
 */
export async function withFileDetails<T extends { path: string }>(
  entries: T[],
  workspaceId: string,
  userId: string | null,
  wanted: boolean,
): Promise<(T & Partial<FileDetail>)[]> {
  if (!wanted) return entries;
  const details = await listFileDetails(workspaceId, userId);
  return entries.map((e) => ({ ...e, ...details.get(e.path) }));
}