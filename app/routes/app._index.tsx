import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { waitUntil } from "@vercel/functions";
import { dashboardOrder, loadAllOrders } from "../services/orders.server";
import { enqueueOrders, processSyncQueue, retrySync, syncStatus } from "../services/sheet-sync.server";

type EventSession = {
  places: number;
  event: string;
  date: string;
  time: string;
  session: string;
};

type TableRow = EventSession & {
  id: string;
  orderName: string;
  orderDate: string;
  financialStatus: string;
  fulfillmentStatus: string;
};

const NEW_ORDER_DAYS = 30;

function isNewOrder(createdAt: string) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - NEW_ORDER_DAYS);
  return new Date(createdAt) >= cutoff;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { orders, hasAllOrdersAccess } = await loadAllOrders(admin);
  return {
    orders: orders.map(dashboardOrder),
    hasAllOrdersAccess,
    sheetSync: await syncStatus(session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "sync-all" && intent !== "retry-sync") return { error: "Unknown action", message: null };
  const status = await syncStatus(session.shop);
  if (!status.configured) return { error: "Google Sheets connection needs setup first.", message: null };
  if (intent === "retry-sync") {
    await retrySync(session.shop);
    waitUntil(processSyncQueue(session.shop));
    return { error: null, message: "Pending orders queued for retry." };
  }
  const { orders, hasAllOrdersAccess } = await loadAllOrders(admin);
  await enqueueOrders(session.shop, orders.map((order) => order.id));
  waitUntil(processSyncQueue(session.shop));
  return { error: null, message: `${orders.length} orders queued for Google Sheets.${hasAllOrdersAccess ? "" : " Older than 60 days: Shopify permission is still required."}` };
};
export default function Index() {
  const { orders, hasAllOrdersAccess, sheetSync } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const sync = useFetcher<typeof action>();
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle" && sync.state === "idle") revalidator.revalidate();
    }, 15000);
    return () => clearInterval(interval);
  }, [revalidator, sync.state]);
  const [selectedDate, setSelectedDate] = useState("");
  const availableDates = [...new Set(orders.flatMap((order) => order.sessions.map((session) => session.date)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const [search, setSearch] = useState("");
  const [orderPeriod, setOrderPeriod] = useState<"new" | "old" | "all">(
    "all",
  );

  const filteredOrders = useMemo(() => {
    const value = search.toLowerCase().trim();

    return orders.filter((order) => {
      const matchesPeriod =
        orderPeriod === "all" ||
        (orderPeriod === "new" && isNewOrder(order.createdAt)) ||
        (orderPeriod === "old" && !isNewOrder(order.createdAt));

      if (!matchesPeriod) {
        return false;
      }

      if (!value) {
        return true;
      }

      const orderText = [
        order.name,
        ...order.sessions.flatMap((session) => [
          session.event,
          session.date,
          session.time,
          session.session,
        ]),
      ]
        .join(" ")
        .toLowerCase();

      return orderText.includes(value);
    });
  }, [orderPeriod, orders, search]);

  const tableRows = useMemo<TableRow[]>(
    () =>
      filteredOrders.flatMap((order) =>
        order.sessions.map((session, index) => ({
          ...session,
          id: `${order.id}-${index}`,
          orderName: order.name,
          orderDate: new Date(order.createdAt).toLocaleDateString(),
          financialStatus: order.financialStatus || "-",
          fulfillmentStatus: order.fulfillmentStatus || "-",
        })).filter((row) => (!selectedDate || row.date === selectedDate) &&
          (!search.trim() || [row.orderName, row.event, row.date, row.time, row.session].join(" ").toLowerCase().includes(search.toLowerCase().trim()))),
      ),
    [filteredOrders, selectedDate, search],
  );

  const sessionGroups = useMemo(() => {
    const groups = new Map<string, TableRow[]>();
    for (const row of tableRows) {
      const key = JSON.stringify([row.date, row.event, row.time, row.session]);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [tableRows]);

  const downloadExcel = (rows: TableRow[], label: string) => {
    const header = [
      "Order",
      "Order date",
      "Event",
      "Event date",
      "Time",
      "Session",
      "Payment",
      "Fulfillment",
    ];
    const escapeCsv = (value: string) => {
      const safe = /^[=+@\-\t\r\n]/.test(value) ? "'" + value : value;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = [
      header,
      ...rows.map((row) => [
        row.orderName,
        row.orderDate,
        row.event,
        row.date,
        row.time,
        row.session,
        row.financialStatus,
        row.fulfillmentStatus,
      ]),
    ]
      .map((row) => row.map(escapeCsv).join(","))
      .join("\r\n");

    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `event-orders-${label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 140)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const totalSessions = orders.reduce(
    (total, order) => total + order.sessions.reduce((places, session) => places + session.places, 0),
    0,
  );
  const newOrderCount = orders.filter((order) =>
    isNewOrder(order.createdAt),
  ).length;
  const oldOrderCount = orders.length - newOrderCount;

  return (
    <s-page heading="Art N Melody Event Dashboard">

      {!hasAllOrdersAccess && (
        <s-section heading="Older orders need Shopify permission">
          <s-text>This app currently has access to the last 60 days only. To show the older orders from Shopify, the app owner must enable All orders access in Shopify, add read_all_orders to the app scopes, and approve the updated app permissions. Refresh afterwards to load the full history.</s-text>
        </s-section>
      )}

      <s-section heading="Google Sheets sync">
        <s-stack direction="block" gap="base">
          <s-text>{sheetSync.configured ? "New and updated orders sync automatically after Shopify delivers their notifications. Use Import all orders once for existing bookings." : "Connection setup required: configure the Google service account and share the destination sheet with it. Automatic sync is not active yet."}</s-text>
          <s-text>{sheetSync.pending} orders pending · Last successful sync: {sheetSync.lastSyncedAt ? new Date(sheetSync.lastSyncedAt).toLocaleString() : "Not synced yet"}</s-text>
          {sheetSync.lastError && <s-text>{sheetSync.lastError}</s-text>}
          {sync.data?.error && <s-text>{sync.data.error}</s-text>}
          {sync.data?.message && <s-text>{sync.data.message}</s-text>}
          <s-stack direction="inline" gap="base">
            <s-button disabled={!sheetSync.configured || sync.state !== "idle"} onClick={() => sync.submit({ intent: "sync-all" }, { method: "post" })}>Import all orders to Sheet</s-button>
            <s-button disabled={!sheetSync.configured || !sheetSync.pending || sync.state !== "idle"} onClick={() => sync.submit({ intent: "retry-sync" }, { method: "post" })}>Retry pending sync</s-button>
            <s-link href={sheetSync.url} target="_blank">Open Google Sheet</s-link>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-box>
            <s-heading>Total Orders</s-heading>
            <s-text>{orders.length}</s-text>
          </s-box>

          <s-box>
            <s-heading>Booked places</s-heading>
            <s-text>{totalSessions}</s-text>
          </s-box>

          <s-box>
            <s-heading>New Orders (30 days)</s-heading>
            <s-text>{newOrderCount}</s-text>
          </s-box>

          <s-box>
            <s-heading>Older Orders</s-heading>
            <s-text>{oldOrderCount}</s-text>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Event & Session Orders">

        <s-stack direction="block" gap="base">

          <s-text>Showing all {orders.length} orders Shopify currently permits this app to read. The dashboard refreshes every 15 seconds while open. Places are based on ordered quantities, including unpaid or refunded orders, not confirmed attendance.</s-text>
          <s-stack direction="inline" gap="base">
            <label>
              Workshop date
              <select value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} style={{ display: "block", padding: "10px", minWidth: "220px", marginTop: "6px" }}>
                <option value="">All workshop dates</option>
                {availableDates.map((date) => <option key={date} value={date}>{date === "-" ? "Date unavailable" : date}</option>)}
              </select>
            </label>
            <s-button onClick={() => revalidator.revalidate()} disabled={revalidator.state !== "idle"}>
              {revalidator.state === "idle" ? "Refresh bookings" : "Refreshing…"}
            </s-button>
          </s-stack>

          <s-stack direction="inline" gap="small">
            <s-button
              variant={orderPeriod === "new" ? "primary" : "secondary"}
              onClick={() => setOrderPeriod("new")}
            >
              New orders ({newOrderCount})
            </s-button>
            <s-button
              variant={orderPeriod === "old" ? "primary" : "secondary"}
              onClick={() => setOrderPeriod("old")}
            >
              Older orders ({oldOrderCount})
            </s-button>
            <s-button
              variant={orderPeriod === "all" ? "primary" : "secondary"}
              onClick={() => setOrderPeriod("all")}
            >
              All orders ({orders.length})
            </s-button>
          </s-stack>

          <s-stack direction="inline" gap="base" justifyContent="space-between">
            <s-text-field
              label="Search orders, events, dates or sessions"
            value={search}
            onInput={(event) => {
              setSearch(
                (event.target as HTMLInputElement).value,
              );
            }}
            />
            <s-button onClick={() => downloadExcel(sessionGroups.flatMap(([, rows]) => rows), selectedDate || "all-dates")} disabled={tableRows.length === 0}>
              Download {selectedDate ? "selected date" : "all dates"} (.csv)
            </s-button>
          </s-stack>

          <s-heading>{tableRows.reduce((total, row) => total + row.places, 0)} booked places · {sessionGroups.length} date/session groups</s-heading>
          <s-text>Counts and downloads follow the date, order period and search. The date CSV includes all matching sessions grouped together. Download individual sessions below for separate files.</s-text>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
            {sessionGroups.map(([key, rows]) => (
              <div key={key} style={{ border: "1px solid #c9cccf", borderRadius: "8px", padding: "16px" }}>
                <s-stack direction="block" gap="small">
                  <s-heading>{rows[0].event}</s-heading>
                  <s-text>{rows[0].date} · {rows[0].time} · {rows[0].session}</s-text>
                  <s-text>{rows.reduce((total, row) => total + row.places, 0)} booked places · {new Set(rows.map((row) => row.orderName)).size} orders</s-text>
                  <s-button onClick={() => downloadExcel(rows, `${rows[0].date}-${rows[0].event}-${rows[0].time}-${rows[0].session}`)}>Download this session (.csv)</s-button>
                </s-stack>
              </div>
            ))}
          </div>

          {tableRows.length === 0 ? (
            <s-box padding="large">
              <s-text>
                No {orderPeriod === "new"
                  ? "new"
                  : orderPeriod === "old"
                    ? "older"
                    : "matching"} orders found.
              </s-text>
            </s-box>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", minWidth: "900px", width: "100%" }}>
                <thead>
                  <tr>
                    {["Order", "Order date", "Event", "Event date", "Time", "Session", "Payment", "Fulfillment"].map((heading) => (
                      <th key={heading} style={{ borderBottom: "1px solid #c9cccf", padding: "12px 10px", textAlign: "left", whiteSpace: "nowrap" }}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row) => (
                    <tr key={row.id}>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px" }}>{row.orderName}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px", whiteSpace: "nowrap" }}>{row.orderDate}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px" }}>{row.event}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px", whiteSpace: "nowrap" }}>{row.date}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px", whiteSpace: "nowrap" }}>{row.time}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px" }}>{row.session}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px" }}>{row.financialStatus}</td>
                      <td style={{ borderBottom: "1px solid #e1e3e5", padding: "12px 10px" }}>{row.fulfillmentStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        </s-stack>

      </s-section>

      <s-section slot="aside" heading="Dashboard">
        <s-stack direction="block" gap="base">

          <s-text>
            This dashboard displays Shopify orders
            with their event date, time and session.
          </s-text>

          <s-text>
            Orders are loaded directly from the
            Shopify Admin API.
          </s-text>

          <s-text>
            Use Download Excel to export the table currently shown.
          </s-text>

          <s-text>
            New means orders placed in the last {NEW_ORDER_DAYS} days.
          </s-text>

        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
