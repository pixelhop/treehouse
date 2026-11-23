-- CreateTable
CREATE TABLE "share" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "token" TEXT,
    "passwordHash" TEXT,
    "pinnedVersion" INTEGER,
    "pinnedContentHash" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "share_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_token_key" ON "share"("token");

-- CreateIndex
CREATE INDEX "share_workspaceId_path_idx" ON "share"("workspaceId", "path");

-- AddForeignKey
ALTER TABLE "share" ADD CONSTRAINT "share_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
