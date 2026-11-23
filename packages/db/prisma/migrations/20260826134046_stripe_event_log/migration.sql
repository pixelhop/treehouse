-- CreateTable
CREATE TABLE "stripe_event" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stripeCreated" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "stripe_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stripe_event_stripeEventId_key" ON "stripe_event"("stripeEventId");

-- CreateIndex
CREATE INDEX "stripe_event_type_idx" ON "stripe_event"("type");

-- CreateIndex
CREATE INDEX "stripe_event_receivedAt_idx" ON "stripe_event"("receivedAt");
