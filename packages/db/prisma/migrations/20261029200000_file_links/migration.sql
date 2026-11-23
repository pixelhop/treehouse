-- CreateTable
CREATE TABLE "file_links" (
    "workspaceId" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "targets" TEXT[],
    "scanned" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_links_pkey" PRIMARY KEY ("workspaceId","sourcePath")
);

-- CreateIndex
CREATE INDEX "file_links_targets_idx" ON "file_links" USING GIN ("targets");

-- AddForeignKey
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
