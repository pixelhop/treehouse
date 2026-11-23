-- CreateTable
CREATE TABLE "workspace_key" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "kekId" TEXT NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_key_workspaceId_key" ON "workspace_key"("workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_key" ADD CONSTRAINT "workspace_key_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
