-- CreateTable
CREATE TABLE "comment_thread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "anchorKind" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "contextBefore" TEXT NOT NULL,
    "contextAfter" TEXT NOT NULL,
    "sourceStart" INTEGER NOT NULL,
    "sourceEnd" INTEGER NOT NULL,
    "pinnedContentHash" TEXT NOT NULL,
    "pinnedVersion" INTEGER NOT NULL,
    "lastResolvedHash" TEXT,
    "resolvedStart" INTEGER,
    "resolvedEnd" INTEGER,
    "anchorStatus" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedAtVersion" INTEGER,
    "resolvedPrincipal" TEXT,
    "resolvedActorId" TEXT,
    "resolvedActorKeyId" TEXT,
    "resolvedActorLabel" TEXT,
    "principal" TEXT NOT NULL,
    "actorId" TEXT,
    "actorKeyId" TEXT,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comment_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_entry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "principal" TEXT NOT NULL,
    "actorId" TEXT,
    "actorKeyId" TEXT,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_read_state" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "lastSeenSeq" BIGINT NOT NULL DEFAULT 0,
    "lastSeenVersion" INTEGER NOT NULL,
    "lastSeenContentHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_read_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_thread_workspaceId_path_idx" ON "comment_thread"("workspaceId", "path");

-- CreateIndex
CREATE INDEX "comment_entry_threadId_idx" ON "comment_entry"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_entry_threadId_dedupeKey_key" ON "comment_entry"("threadId", "dedupeKey");

-- CreateIndex
CREATE INDEX "file_read_state_workspaceId_path_idx" ON "file_read_state"("workspaceId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "file_read_state_userId_workspaceId_path_key" ON "file_read_state"("userId", "workspaceId", "path");

-- AddForeignKey
ALTER TABLE "comment_thread" ADD CONSTRAINT "comment_thread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_entry" ADD CONSTRAINT "comment_entry_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "comment_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_entry" ADD CONSTRAINT "comment_entry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_read_state" ADD CONSTRAINT "file_read_state_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
