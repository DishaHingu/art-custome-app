import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Simulate durable storage and external calls; no customer credentials or live writes.
const h = { jobs: new Map(), rows: [], writes: [], state: null, failWrite: false, duringWrite: null };
globalThis.__syncHarness = h;
const shop = "test.myshopify.com";
const match = (job, where) => job && job.shop === where.shop && (!where.orderId || job.orderId === where.orderId) && (!where.revision || job.revision === where.revision);
h.db = {
  sheetSyncState: {
    upsert: async ({ create }) => h.state ||= { ...create, nextRow: 2, tabId: null, leaseUntil: null },
    findUniqueOrThrow: async () => h.state,
    update: async ({ data }) => {
      const nextRow = data.nextRow ? h.state.nextRow + data.nextRow.increment : h.state.nextRow;
      Object.assign(h.state, data, { nextRow }); return h.state;
    },
    updateMany: async ({ where, data }) => {
      if (where.OR && h.state.leaseUntil && h.state.leaseUntil > new Date()) return { count: 0 };
      if (where.leaseToken && h.state.leaseToken !== where.leaseToken) return { count: 0 };
      if (where.leaseUntil?.gt && h.state.leaseUntil <= where.leaseUntil.gt) return { count: 0 };
      Object.assign(h.state, data); return { count: 1 };
    },
  },
  sheetSyncJob: {
    upsert: async ({ where, create, update }) => {
      const key = where.shop_orderId.orderId;
      const old = h.jobs.get(key);
      h.jobs.set(key, old ? { ...old, ...update, revision: old.revision + 1 } : { ...create, revision: 1, attempts: 0, requestedAt: new Date(), retryAt: new Date() });
    },
    findFirst: async () => [...h.jobs.values()].find((job) => job.retryAt <= new Date()),
    deleteMany: async ({ where }) => { if (match(h.jobs.get(where.orderId), where)) h.jobs.delete(where.orderId); },
    updateMany: async ({ where, data }) => {
      for (const job of h.jobs.values()) if (match(job, where)) {
        const attempts = data.attempts ? job.attempts + data.attempts.increment : job.attempts;
        Object.assign(job, data, { attempts });
      }
    },
  },
  sheetSyncRow: {
    findUnique: async ({ where: { shop_orderId_lineId: key } }) => h.rows.find((row) => row.shop === key.shop && row.orderId === key.orderId && row.lineId === key.lineId),
    create: async ({ data }) => { h.rows.push(data); return data; },
    findMany: async ({ where }) => h.rows.filter((row) => row.shop === where.shop && row.orderId === where.orderId),
  },
  $transaction: async (action) => typeof action === "function" ? action(h.db) : Promise.all(action),
};
h.order = { id: "order-1", name: "#1", createdAt: "2026-01-01", updatedAt: "2026-09-14", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", lineItems: { nodes: [{ id: "line-1", title: "Workshop", variantTitle: "Date / Morning", quantity: 2, currentQuantity: 2 }], pageInfo: { hasNextPage: false, endCursor: null } } };
h.admin = { graphql: async () => ({ json: async () => ({ data: { order: structuredClone(h.order) } }) }) };
h.writeRows = async (_tab, _count, rows) => {
  if (h.failWrite) { h.failWrite = false; throw new Error("Simulated outage"); }
  h.writes.push(structuredClone(rows));
  if (h.duringWrite) { const action = h.duringWrite; h.duringWrite = null; await action(); }
};
const result = await build({
  entryPoints: ["app/services/sheet-sync.server.ts"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "sync-test-dependencies", setup(build) {
    build.onResolve({ filter: /(?:db\.server|shopify\.server|google-sheets\.server)$/ }, (args) => ({ path: args.path, namespace: "mock" }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: args.path.includes("db.server")
      ? "export default globalThis.__syncHarness.db"
      : args.path.includes("shopify.server") ? "export const unauthenticated = { admin: async () => ({ admin: globalThis.__syncHarness.admin }) }"
        : 'export const SPREADSHEET_ID = "test-sheet"; export const SPREADSHEET_URL = "test-url"; export const sheetsConfigured = () => true; export const ensureTab = async () => ({sheetId: 1, gridProperties: {rowCount: 1000}}); export const writeRows = (...args) => globalThis.__syncHarness.writeRows(...args);' }));
  } }],
});
const sync = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("failed sheet writes retain jobs and retry into the same row; repeated imports never duplicate", async () => {
  await sync.enqueueOrders(shop, [h.order.id]);
  h.failWrite = true;
  await sync.processSyncQueue(shop);
  assert.equal(h.jobs.size, 1);
  assert.equal(h.rows.length, 1);
  assert.equal(h.state.leaseToken, null);
  await sync.retrySync(shop);
  await sync.processSyncQueue(shop);
  assert.equal(h.jobs.size, 0);
  assert.equal(h.writes[0][0].rowNumber, 2);
  await sync.enqueueOrders(shop, [h.order.id]);
  await sync.processSyncQueue(shop);
  assert.equal(h.rows.length, 1);
  assert.equal(h.writes[1][0].rowNumber, 2);
});

test("new events during a write stay queued and refresh the same row with latest data", async () => {
  await sync.enqueueOrders(shop, [h.order.id]);
  h.duringWrite = async () => {
    h.order.lineItems.nodes[0].currentQuantity = 1;
    await sync.enqueueOrders(shop, [h.order.id]);
  };
  await sync.processSyncQueue(shop);
  assert.equal(h.jobs.size, 0);
  assert.equal(h.rows.length, 1);
  assert.equal(h.writes.at(-1)[0].values[9], 1);
});

test("concurrent workers honor the lease and signed deletion jobs mark existing rows", async () => {
  await sync.enqueueOrders(shop, [h.order.id], true);
  h.state.leaseUntil = new Date(Date.now() + 60000);
  h.state.leaseToken = "other-worker";
  const before = h.writes.length;
  await sync.processSyncQueue(shop);
  assert.equal(h.writes.length, before);
  assert.equal(h.jobs.size, 1);
  h.state.leaseUntil = null;
  await sync.processSyncQueue(shop);
  assert.equal(h.writes.at(-1)[0].values[14], "Deleted order");
  assert.equal(h.writes.at(-1)[0].values[9], 0);
  assert.equal(h.jobs.size, 0);
});
