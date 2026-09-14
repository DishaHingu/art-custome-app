import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const orders = await moduleFrom("app/services/orders.server.ts");
const sheetValues = await moduleFrom("app/services/sheet-values.ts");
const google = await moduleFrom("app/services/google-sheets.server.ts");
await mkdir(".cache", { recursive: true });
await writeFile(".cache/order-queries.graphql", [orders.ORDERS_QUERY, orders.ORDER_QUERY, orders.ITEMS_QUERY].join("\n"));
const page = (hasNextPage = false, endCursor = null) => ({ hasNextPage, endCursor });
const item = (id, extra = {}) => ({ id: `line-${id}`, title: "Lamp workshop", variantTitle: "Sat Oct 24th / 11 AM / Morning", quantity: 2, currentQuantity: 2, ...extra });
const order = (id, extra = {}) => ({ id: `order-${id}`, name: `#${id}`, createdAt: "2026-01-01T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", lineItems: { nodes: [item(id)], pageInfo: page() }, ...extra });

test("loads more than 100 orders and more than 50 items, retaining old/refunded orders", async () => {
  const fixture = Array.from({ length: 121 }, (_, index) => order(index));
  fixture[0].lineItems = { nodes: Array.from({ length: 20 }, (_, i) => item(i)), pageInfo: page(true, "items-20") };
  fixture[1].displayFinancialStatus = "REFUNDED";
  let calls = 0;
  const client = { graphql: async (query, { variables }) => {
    calls++;
    if (query.includes("RemainingOrderItems")) return { json: async () => ({ data: { order: { lineItems: { nodes: Array.from({ length: 41 }, (_, i) => item(i + 20)), pageInfo: page() } } } }) };
    const start = Number(variables.after || 0);
    const end = Math.min(start + 20, fixture.length);
    return { json: async () => ({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_all_orders" }] }, orders: { nodes: structuredClone(fixture.slice(start, end)), pageInfo: page(end < fixture.length, String(end)) } } }) };
  } };
  const result = await orders.loadAllOrders(client);
  assert.equal(result.orders.length, 121);
  assert.equal(result.orders[0].lineItems.nodes.length, 61);
  assert.equal(result.orders[1].displayFinancialStatus, "REFUNDED");
  assert.equal(result.hasAllOrdersAccess, true);
  assert.equal(calls, 8);
});

test("detects restricted history without assuming the returned count is all Shopify orders", async () => {
  const result = await orders.loadAllOrders({ graphql: async () => ({ json: async () => ({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] }, orders: { nodes: [order(1)], pageInfo: page() } } }) }) });
  assert.equal(result.hasAllOrdersAccess, false);
});

test("rejects partial errors and stalled pagination rather than showing incomplete totals", async () => {
  await assert.rejects(() => orders.loadAllOrders({ graphql: async () => ({ json: async () => ({ errors: [{ extensions: { code: "ACCESS_DENIED" } }], data: {} }) }) }), /permissions/);
  await assert.rejects(() => orders.loadAllOrders({ graphql: async () => ({ json: async () => ({ data: { currentAppInstallation: { accessScopes: [] }, orders: { nodes: [], pageInfo: page(true, null) } } }) }) }), /pagination/);
});

test("preserves deleted variant titles, quantities and orders with no items", () => {
  const rows = orders.dashboardOrder(order(1));
  assert.equal(rows.sessions.length, 2);
  assert.equal(rows.sessions[0].date, "Sat Oct 24th");
  assert.equal(orders.parseSession("Test", "Default Title").date, "-");
  const empty = orders.dashboardOrder(order(2, { lineItems: { nodes: [], pageInfo: page() } }));
  assert.equal(empty.sessions.length, 1);
  assert.equal(empty.sessions[0].places, 0);
});

test("sheet rows retain stable identity across refunds, session edits and cancellations", () => {
  const original = order(1);
  const first = sheetValues.orderSheetRows(original, "now");
  original.lineItems.nodes[0].currentQuantity = 1;
  original.lineItems.nodes[0].variantTitle = "Sun Oct 25th / 2 PM / Afternoon";
  original.cancelledAt = "2026-09-14T12:00:00Z";
  const changed = sheetValues.orderSheetRows(original, "later");
  assert.equal(first[0].lineId, changed[0].lineId);
  assert.equal(changed[0].values[5], "Sun Oct 25th");
  assert.equal(changed[0].values[9], 1);
  assert.equal(changed[0].values[14], "Cancelled");
  assert.equal(changed[0].values.length, sheetValues.SHEET_HEADERS.length);
});

test("Google writes use literal strings and numeric quantities, and never overwrite an unrelated existing tab", async () => {
  const originalFetch = globalThis.fetch;
  const previousEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const previousKey = process.env.GOOGLE_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "test@example.invalid";
  process.env.GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  const writes = [];
  globalThis.fetch = async (url, init) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "test", expires_in: 3600 });
    if (init.method === "GET") return Response.json({ sheets: [{ properties: { sheetId: 1, title: "Art N Melody Orders (app)", gridProperties: { rowCount: 1000 } } }] });
    writes.push(JSON.parse(init.body));
    return Response.json({});
  };
  try {
    await assert.rejects(() => google.ensureTab(null), /already exists/);
    assert.equal(writes.length, 0);
    await google.writeRows(1, 1000, [{ rowNumber: 2, values: ["=IMPORTXML(\"untrusted\")", 3] }]);
    const values = writes[0].requests[1].updateCells.rows[0].values;
    assert.deepEqual(values[0], { userEnteredValue: { stringValue: '=IMPORTXML("untrusted")' } });
    assert.deepEqual(values[1], { userEnteredValue: { numberValue: 3 } });
    assert.equal(writes[0].requests[1].updateCells.start.sheetId, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEmail === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL; else process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = previousEmail;
    if (previousKey === undefined) delete process.env.GOOGLE_PRIVATE_KEY; else process.env.GOOGLE_PRIVATE_KEY = previousKey;
  }
});
