-- CreateTable
CREATE TABLE "workspace_read_state" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "lastSeenSeq" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_read_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_read_state_workspaceId_idx" ON "workspace_read_state"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_read_state_userId_workspaceId_key" ON "workspace_read_state"("userId", "workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_read_state" ADD CONSTRAINT "workspace_read_state_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
