import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { authenticate } from "../shopify.server";
import { enqueueOrders, processSyncQueue } from "../services/sheet-sync.server";
import { sheetsConfigured } from "../services/google-sheets.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (!sheetsConfigured(shop)) return new Response("Google Sheets is not configured", { status: 503 });
  const allowed = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "ORDERS_PAID", "ORDERS_DELETE", "REFUNDS_CREATE"];
  if (!allowed.includes(topic)) return new Response("Unsupported topic", { status: 400 });
  const rawId = topic === "REFUNDS_CREATE" ? payload.order_id : payload.id;
  const id = String(rawId || "");
  if (!/^\d+$/.test(id)) return new Response("Missing order ID", { status: 400 });
  await enqueueOrders(shop, [`gid://shopify/Order/${id}`], topic === "ORDERS_DELETE");
  // Persist before acknowledging; Vercel keeps this background work alive.
  waitUntil(processSyncQueue(shop));
  return new Response(null, { status: 200 });
};
