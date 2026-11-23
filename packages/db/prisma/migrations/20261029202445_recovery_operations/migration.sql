-- AlterTable
ALTER TABLE "change_event" ADD COLUMN     "operationId" TEXT,
ADD COLUMN     "privateTo" TEXT,
ADD COLUMN     "relatedPath" TEXT;

-- CreateTable
CREATE TABLE "recovery_operation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopePath" TEXT,
    "targetAt" TIMESTAMP(3),
    "targetKeyId" TEXT,
    "targetLabel" TEXT,
    "principal" TEXT NOT NULL,
    "actorId" TEXT,
    "actorKeyId" TEXT,
    "actorLabel" TEXT,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "recovery_operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_operation_workspaceId_createdAt_idx" ON "recovery_operation"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "recovery_operation" ADD CONSTRAINT "recovery_operation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: pair each existing move with the delete it wrote at its old path.
-- FileService.move records both in one transaction: the delete first, by the
-- same actor, moments before the move (createdAt is stamped by the client, so
-- they can differ by a millisecond or two), and the move carries the content
-- the old path last held.
--
-- "_move_window" is every delete that could be a move's other half: in the
-- same workspace, by the same actor, before it in the feed and within a minute
-- of it, with the content its path last held ("srcHash"). The window is wide
-- on purpose, so it always contains the real source (seq is global across
-- workspaces, so a window by position could lose it): a wider window can only
-- leave more moves unpaired, never pair one wrongly. A move is linked only
-- when exactly one of those deletes held the move's content, no other move
-- could claim that delete, and no delete in its window is of unknown content
-- (srcHash NULL): that one might be the real source, so the move is ambiguous
-- and left alone. An unpaired move's old path shows in the
-- trash as if deleted, which is noisy but loses nothing (restoring it makes a
-- copy); a wrong pairing would hide a real deletion.
CREATE TEMP TABLE "_move_window" AS
SELECT m."id" AS "moveId", m."path" AS "toPath", m."contentHash" AS "moveHash",
  d."id" AS "deleteId", d."path" AS "fromPath",
  (SELECT p."contentHash" FROM "change_event" p
    WHERE p."workspaceId" = d."workspaceId" AND p."path" = d."path" AND p."seq" < d."seq"
      AND p."op" IN ('write', 'move', 'restore', 'conflict')
    ORDER BY p."seq" DESC LIMIT 1) AS "srcHash"
FROM "change_event" m
JOIN "change_event" d
  ON d."workspaceId" = m."workspaceId"
  AND d."op" = 'delete'
  AND d."seq" < m."seq"
  AND d."createdAt" BETWEEN m."createdAt" - INTERVAL '1 minute' AND m."createdAt" + INTERVAL '1 minute'
  AND d."actorId" IS NOT DISTINCT FROM m."actorId"
  AND d."actorKeyId" IS NOT DISTINCT FROM m."actorKeyId"
WHERE m."op" = 'move'
  AND m."contentHash" IS NOT NULL;

CREATE TEMP TABLE "_move_candidates" AS
SELECT * FROM "_move_window" w WHERE w."srcHash" = w."moveHash";

CREATE TEMP TABLE "_move_pairs" AS
SELECT c.* FROM "_move_candidates" c
WHERE (SELECT count(*) FROM "_move_candidates" x WHERE x."moveId" = c."moveId") = 1
  AND (SELECT count(*) FROM "_move_candidates" x WHERE x."deleteId" = c."deleteId") = 1
  AND NOT EXISTS (SELECT 1 FROM "_move_window" u
    WHERE u."moveId" = c."moveId" AND u."srcHash" IS NULL);

UPDATE "change_event" e SET "relatedPath" = p."toPath" FROM "_move_pairs" p WHERE e."id" = p."deleteId";
UPDATE "change_event" e SET "relatedPath" = p."fromPath" FROM "_move_pairs" p WHERE e."id" = p."moveId";

DROP TABLE "_move_pairs";
DROP TABLE "_move_candidates";
DROP TABLE "_move_window";
