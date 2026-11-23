-- CreateTable
CREATE TABLE "device_authorization" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "workspaceId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'human',
    "apiKeyId" TEXT,
    "apiKeyCiphertext" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_authorization_deviceCodeHash_key" ON "device_authorization"("deviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorization_userCode_key" ON "device_authorization"("userCode");

-- CreateIndex
CREATE INDEX "device_authorization_status_idx" ON "device_authorization"("status");

-- CreateIndex
CREATE INDEX "device_authorization_expiresAt_idx" ON "device_authorization"("expiresAt");
