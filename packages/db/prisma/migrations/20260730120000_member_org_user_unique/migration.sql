-- One membership per (organizationId, userId).
--
-- The invite-accept route checks "is this user already a member?" and inserts in
-- two separate statements, so two concurrent accepts of the same link could both
-- pass the check and both insert. Wrapping them in a transaction does not help —
-- there is no row to lock — so the guarantee has to come from a constraint.

-- Hold off writers for the WHOLE cleanup-and-build window. Prisma runs this file
-- in one transaction, so the lock is held until commit. Without it a concurrent
-- accept could insert a duplicate between the DELETE and the index build, and the
-- migration would fail against live traffic. SHARE ROW EXCLUSIVE blocks
-- INSERT/UPDATE/DELETE while still allowing reads, and CREATE INDEX's own SHARE
-- lock doesn't conflict with a lock this transaction already holds.
--
-- Deliberately NOT `CREATE INDEX CONCURRENTLY` (which Squawk would prefer): it
-- cannot run inside a transaction, so it could not be made atomic with the DELETE
-- above, and a failed concurrent build leaves an INVALID index behind. `member` is
-- a small table — one membership row per user per org — so a brief write block is
-- the cheaper trade.
LOCK TABLE "member" IN SHARE ROW EXCLUSIVE MODE;

-- Collapse any duplicates that predate the constraint, keeping the OLDEST row
-- (the membership the user has actually had all along; its id may be referenced
-- elsewhere). Ties on createdAt fall back to id so the choice is deterministic.
DELETE FROM "member" m
USING "member" keep
WHERE m."organizationId" = keep."organizationId"
  AND m."userId" = keep."userId"
  AND (m."createdAt", m."id") > (keep."createdAt", keep."id");

CREATE UNIQUE INDEX "member_organizationId_userId_key"
  ON "member" ("organizationId", "userId");
