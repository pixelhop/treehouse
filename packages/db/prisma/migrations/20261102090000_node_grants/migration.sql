-- Generalise per-node ACLs into grants. A node_acl row is now a restriction;
-- node_grant rows say who may reach it and at what level.

-- CreateTable
CREATE TABLE "node_grant" (
    "id" TEXT NOT NULL,
    "aclId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_grant_aclId_userId_key" ON "node_grant"("aclId", "userId");
CREATE INDEX "node_grant_workspaceId_idx" ON "node_grant"("workspaceId");
CREATE INDEX "node_grant_userId_idx" ON "node_grant"("userId");
-- At most one "everyone" grant per restriction (its userId is NULL, which the
-- unique index above treats as distinct).
CREATE UNIQUE INDEX "node_grant_aclId_everyone_key" ON "node_grant"("aclId") WHERE "subject" = 'everyone';

-- AddForeignKey
ALTER TABLE "node_grant" ADD CONSTRAINT "node_grant_aclId_fkey" FOREIGN KEY ("aclId") REFERENCES "node_acl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing private node becomes a restriction with one grant: its owner
-- at write. That is exactly today's meaning ("only me and my agents").
INSERT INTO "node_grant" ("id", "aclId", "workspaceId", "subject", "userId", "level", "updatedAt")
SELECT gen_random_uuid()::text, "id", "workspaceId", 'user', "ownerId", 'write', CURRENT_TIMESTAMP
FROM "node_acl"
WHERE "ownerId" IS NOT NULL;

-- ownerId is no longer read. Kept (nullable) for one release so a rollback still
-- sees the old private rows; new restrictions leave it null, which the old code
-- matches to nobody (fail closed).
ALTER TABLE "node_acl" ALTER COLUMN "ownerId" DROP NOT NULL;
