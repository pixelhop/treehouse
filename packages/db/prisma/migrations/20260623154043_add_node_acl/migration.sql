-- CreateTable
CREATE TABLE "node_acl" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_acl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "node_acl_workspaceId_idx" ON "node_acl"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "node_acl_workspaceId_path_key" ON "node_acl"("workspaceId", "path");

-- AddForeignKey
ALTER TABLE "node_acl" ADD CONSTRAINT "node_acl_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
