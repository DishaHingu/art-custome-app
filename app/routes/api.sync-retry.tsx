import { timingSafeEqual } from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import { processSyncQueue } from "../services/sheet-sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const provided = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret || ""}`);
  if (!secret || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const shop = process.env.SHOPIFY_SYNC_SHOP;
  if (!shop) return new Response("Sync store is not configured", { status: 503 });
  await processSyncQueue(shop);
  return Response.json({ ok: true });
};
