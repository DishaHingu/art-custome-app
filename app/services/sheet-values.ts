import { parseSession, type ShopifyOrder } from "./orders.server";

export const SHEET_HEADERS = ["Order ID", "Line item ID", "Order", "Order date (UTC)", "Event", "Workshop date", "Time", "Session", "Ordered quantity", "Current quantity", "Payment", "Fulfillment", "Cancelled at", "Order updated at", "Record status", "Synced at (UTC)"];

export function orderSheetRows(order: ShopifyOrder, syncedAt: string) {
  const items = order.lineItems.nodes;
  if (!items.length) return [{ lineId: "__order__", values: [order.id, "", order.name, order.createdAt, "", "", "", "", 0, 0, order.displayFinancialStatus || "", order.displayFulfillmentStatus || "", order.cancelledAt || "", order.updatedAt, "No line items", syncedAt] }];
  return items.map((item) => {
    const session = parseSession(item.title, item.variantTitle);
    return {
      lineId: item.id,
      values: [order.id, item.id, order.name, order.createdAt, item.title, session.date, session.time, session.session, item.quantity, item.currentQuantity, order.displayFinancialStatus || "", order.displayFulfillmentStatus || "", order.cancelledAt || "", order.updatedAt, order.cancelledAt ? "Cancelled" : "Current", syncedAt],
    };
  });
}
