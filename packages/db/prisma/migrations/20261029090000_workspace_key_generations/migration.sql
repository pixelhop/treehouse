-- A workspace may hold several data-key generations while a rotation
-- re-encrypts its blobs: one row per (workspace, generation).
DROP INDEX "workspace_key_workspaceId_key";

ALTER TABLE "workspace_key" ADD COLUMN "retiredAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "workspace_key_workspaceId_generation_key" ON "workspace_key"("workspaceId", "generation");
