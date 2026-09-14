CREATE TABLE "SheetSyncState" (
  "shop" TEXT NOT NULL PRIMARY KEY,
  "spreadsheetId" TEXT NOT NULL,
  "tabId" INTEGER,
  "nextRow" INTEGER NOT NULL DEFAULT 2,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT
);
CREATE TABLE "SheetSyncJob" (
  "shop" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY ("shop", "orderId")
);
CREATE INDEX "SheetSyncJob_shop_retryAt_idx" ON "SheetSyncJob"("shop", "retryAt");
CREATE TABLE "SheetSyncRow" (
  "shop" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "lineId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  PRIMARY KEY ("shop", "orderId", "lineId")
);
CREATE UNIQUE INDEX "SheetSyncRow_shop_rowNumber_key" ON "SheetSyncRow"("shop", "rowNumber");
