-- AlterTable
ALTER TABLE "share" ADD COLUMN     "lastViewedAt" TIMESTAMP(3),
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "share_usage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_view_day" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_view_day_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "share_usage_workspaceId_idx" ON "share_usage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "share_usage_workspaceId_kind_period_key" ON "share_usage"("workspaceId", "kind", "period");

-- CreateIndex
CREATE INDEX "share_view_day_workspaceId_day_idx" ON "share_view_day"("workspaceId", "day");

-- CreateIndex
CREATE INDEX "share_view_day_createdAt_idx" ON "share_view_day"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "share_view_day_shareId_visitorHash_day_key" ON "share_view_day"("shareId", "visitorHash", "day");

-- AddForeignKey
ALTER TABLE "share_usage" ADD CONSTRAINT "share_usage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_view_day" ADD CONSTRAINT "share_view_day_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "share"("id") ON DELETE CASCADE ON UPDATE CASCADE;
