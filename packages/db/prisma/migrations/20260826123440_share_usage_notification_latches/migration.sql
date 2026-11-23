-- AlterTable
ALTER TABLE "share_usage" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "warnedAt" TIMESTAMP(3);
