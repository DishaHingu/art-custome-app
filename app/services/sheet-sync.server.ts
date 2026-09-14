import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { loadOrder } from "./orders.server";
import { ensureTab, sheetsConfigured, SPREADSHEET_ID, SPREADSHEET_URL, writeRows } from "./google-sheets.server";
import { orderSheetRows, SHEET_HEADERS } from "./sheet-values";

export async function syncStatus(shop: string) {
  if (!sheetsConfigured(shop)) return { configured: false, pending: 0, lastSyncedAt: null, lastError: null, url: SPREADSHEET_URL };
  const [state, pending] = await Promise.all([
    db.sheetSyncState.findUnique({ where: { shop } }),
    db.sheetSyncJob.count({ where: { shop } }),
  ]);
  return { configured: true, pending, lastSyncedAt: state?.lastSyncedAt?.toISOString() || null, lastError: state?.lastError || null, url: SPREADSHEET_URL };
}

export async function enqueueOrders(shop: string, orderIds: string[], deleted = false) {
  if (!sheetsConfigured(shop)) throw new Error("Google Sheets connection is not configured for this store.");
  await db.sheetSyncState.upsert({ where: { shop }, create: { shop, spreadsheetId: SPREADSHEET_ID }, update: {} });
  // Bounded transactions avoid overflowing Postgres connection pools during backfill.
  for (let offset = 0; offset < orderIds.length; offset += 50) {
    await db.$transaction(orderIds.slice(offset, offset + 50).map((orderId) => db.sheetSyncJob.upsert({
      where: { shop_orderId: { shop, orderId } },
      create: { shop, orderId, deleted },
      update: { revision: { increment: 1 }, requestedAt: new Date(), retryAt: new Date(), attempts: 0, ...(deleted ? { deleted: true } : {}) },
    })));
  }
}

export async function retrySync(shop: string) {
  await db.sheetSyncJob.updateMany({ where: { shop }, data: { retryAt: new Date() } });
}

export async function processSyncQueue(shop: string) {
  if (!sheetsConfigured(shop)) return;
  const token = randomUUID();
  const lock = await db.sheetSyncState.updateMany({
    where: { shop, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { leaseToken: token, leaseUntil: new Date(Date.now() + 5 * 60000) },
  });
  if (!lock.count) return;
  const started = Date.now();
  try {
    const state = await db.sheetSyncState.findUniqueOrThrow({ where: { shop } });
    if (state.spreadsheetId !== SPREADSHEET_ID) throw new Error("Sync destination changed. Contact the app administrator before continuing.");
    const tab = await ensureTab(state.tabId);
    if (state.tabId === null) await db.sheetSyncState.update({ where: { shop }, data: { tabId: tab.sheetId } });
    const { admin } = await unauthenticated.admin(shop);
    while (Date.now() - started < 40000) {
      const job = await db.sheetSyncJob.findFirst({ where: { shop, retryAt: { lte: new Date() } }, orderBy: { requestedAt: "asc" } });
      if (!job) break;
      try {
        const order = job.deleted ? null : await loadOrder(admin, job.orderId);
        // A missing API result can mean lost permission. Never infer deletion from it.
        if (!job.deleted && !order) throw new Error("An order is unavailable. Check access to older orders and retry.");
        const stamp = new Date().toISOString();
        const values = order ? orderSheetRows(order, stamp) : [];
        const mappings = await db.$transaction(async (tx) => {
          for (const row of values) {
            const existing = await tx.sheetSyncRow.findUnique({ where: { shop_orderId_lineId: { shop, orderId: job.orderId, lineId: row.lineId } } });
            if (!existing) {
              const allocation = await tx.sheetSyncState.update({ where: { shop }, data: { nextRow: { increment: 1 } } });
              await tx.sheetSyncRow.create({ data: { shop, orderId: job.orderId, lineId: row.lineId, rowNumber: allocation.nextRow - 1 } });
            }
          }
          return tx.sheetSyncRow.findMany({ where: { shop, orderId: job.orderId } });
        }, { timeout: 15000 });
        const rows = mappings.map((mapping) => {
          const current = values.find((row) => row.lineId === mapping.lineId);
          if (current) return { rowNumber: mapping.rowNumber, values: current.values };
          const removed: (string | number)[] = Array(SHEET_HEADERS.length).fill("");
          removed[0] = job.orderId;
          removed[1] = mapping.lineId;
          removed[9] = 0;
          removed[14] = job.deleted ? "Deleted order" : "Removed line item";
          removed[15] = stamp;
          return { rowNumber: mapping.rowNumber, values: removed };
        });
        const stillOwner = await db.sheetSyncState.updateMany({ where: { shop, leaseToken: token, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 5 * 60000) } });
        if (!stillOwner.count) throw new Error("Sync lease expired; pending work will be retried.");
        await writeRows(tab.sheetId, tab.gridProperties.rowCount, rows);
        tab.gridProperties.rowCount = Math.max(tab.gridProperties.rowCount, ...rows.map((row) => row.rowNumber));
        // New events arriving during this write keep their job and are read again.
        await db.sheetSyncJob.deleteMany({ where: { shop, orderId: job.orderId, revision: job.revision } });
        await db.sheetSyncState.update({ where: { shop }, data: { lastSyncedAt: new Date(), lastError: null } });
      } catch (error) {
        console.error("Order sync failed", error instanceof Error ? error.name : "UnknownError");
        const message = "An order could not sync. Check Google sheet access and Shopify history permissions, then retry pending sync.";
        await db.sheetSyncJob.updateMany({ where: { shop, orderId: job.orderId, revision: job.revision }, data: { attempts: { increment: 1 }, retryAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7)) * 1000) } });
        await db.sheetSyncState.update({ where: { shop }, data: { lastError: message.slice(0, 300) } });
        break;
      }
    }
  } catch (error) {
    // Do not persist SDK exceptions, which can contain request headers or payloads.
    console.error("Google Sheets sync setup failed", error instanceof Error ? error.name : "UnknownError");
    await db.sheetSyncState.update({ where: { shop }, data: { lastError: "Sync could not connect. Check Google credentials, sheet access and Shopify permissions, then retry." } });
  } finally {
    await db.sheetSyncState.updateMany({ where: { shop, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
  }
}
