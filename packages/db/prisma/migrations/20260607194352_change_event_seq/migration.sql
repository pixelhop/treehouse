-- AlterTable
ALTER TABLE "change_event" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "change_event_workspaceId_seq_idx" ON "change_event"("workspaceId", "seq");
