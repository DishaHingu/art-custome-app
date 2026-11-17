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
  customerName: string;
  email: string;
  product: string;
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

function timeMinutes(value: string) {
  const match = value.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]) % 12;
  if (match[3]?.toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(match[2] || 0);
}

function workshopTitle(date: string) {
  const match = date.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?/i);
  if (!match) return `${date} Workshop`;
  const month = new Date(`${match[1]} 1, 2000`).toLocaleString("en-US", { month: "long" });
  return `${month} ${match[2]} Workshop`;
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
  const [selectedSession, setSelectedSession] = useState("");
  const availableSessions = [...new Set(orders.flatMap((order) => order.sessions.map((session) => session.session)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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
          customerName: order.customerName,
          email: order.email,
          orderDate: new Date(order.createdAt).toLocaleDateString(),
          financialStatus: order.financialStatus || "-",
          fulfillmentStatus: order.fulfillmentStatus || "-",
        })).filter((row) => (!selectedDate || row.date === selectedDate) &&
          (!selectedSession || row.session === selectedSession) &&
          (!search.trim() || [row.orderName, row.event, row.date, row.time, row.session].join(" ").toLowerCase().includes(search.toLowerCase().trim()))),
      ),
    [filteredOrders, selectedDate, selectedSession, search],
  );

  const sessionGroups = useMemo(() => {
    const groups = new Map<string, TableRow[]>();
    for (const row of tableRows) {
      const key = JSON.stringify([row.date, row.event, row.time]);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.entries()].sort(([, a], [, b]) => timeMinutes(a[0].time) - timeMinutes(b[0].time) || a[0].event.localeCompare(b[0].event));
  }, [tableRows]);

  const selectedDateRows = useMemo<TableRow[]>(() => orders.flatMap((order) =>
    order.sessions.map((session, index) => ({
      ...session,
      id: `${order.id}-${index}`,
      orderName: order.name,
      customerName: order.customerName,
      email: order.email,
      product: session.product,
      orderDate: order.createdAt,
      financialStatus: order.financialStatus || "-",
      fulfillmentStatus: order.fulfillmentStatus || "-",
    })).filter((row) => row.date === selectedDate),
  ), [orders, selectedDate]);

  const downloadExcel = (rows: TableRow[], label: string) => {
    const sorted = [...rows].filter((row) => row.places > 0).sort((a, b) => timeMinutes(a.time) - timeMinutes(b.time) || a.orderName.localeCompare(b.orderName, undefined, { numeric: true }));
    const products = [...new Set(sorted.map((row) => row.product || row.event))];
    const sessions = [...new Map(sorted.map((row) => [row.time, row])).entries()].sort(([, a], [, b]) => timeMinutes(a.time) - timeMinutes(b.time));
    const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
    const cell = (value: string | number, style?: string) => `<Cell${style ? ` ss:StyleID="${style}"` : ""}><Data ss:Type="${typeof value === "number" ? "Number" : "String"}">${xml(String(value))}</Data></Cell>`;
    const row = (values: (string | number)[], styles: (string | undefined)[] = []) => `<Row>${values.map((value, index) => cell(value, styles[index])).join("")}</Row>`;
    const lines = [
      row([workshopTitle(sorted[0]?.date || label)], ["Title"]),
      row(["WORKSHOP STATUS", `Date: ${sorted[0]?.date || label}`], ["Section", "Body"]),
      row(["Product type", ...sessions.map(([time], index) => `Session ${index + 1} (${time}) counts`), "Total"], ["Header"]),
      ...products.map((product) => {
        const counts = sessions.map(([, session]) => sorted.filter((item) => (item.product || item.event) === product && item.time === session.time).reduce((sum, item) => sum + item.places, 0));
        return row([product, ...counts, counts.reduce((sum, count) => sum + count, 0)]);
      }),
      row(["Total counts", ...sessions.map(([, session]) => sorted.filter((item) => item.time === session.time).reduce((sum, item) => sum + item.places, 0)), sorted.reduce((sum, item) => sum + item.places, 0)], ["Header"]),
      row([""]),
      ...sessions.flatMap(([time], sessionIndex) => {
        const group = sorted.filter((item) => item.time === time);
        return [row([`Session ${sessionIndex + 1}: ${time} – Participants List`], ["Section"]), row(["Number", "Order ID", "First Name & Last Name", "Product Type", "Email Address", "Workshop Date", "Session Time"], Array(7).fill("Header")), ...group.map((item, index) => row([index + 1, item.orderName, item.customerName, item.product || item.event, item.email, item.date, item.time]))];
      }),
    ];
    const workbook = `<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel"><Styles><Style ss:ID="Title"><Font ss:Bold="1" ss:Size="16"/></Style><Style ss:ID="Section"><Font ss:Bold="1" ss:Size="11"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#EEEEEE" ss:Pattern="Solid"/></Style><Style ss:ID="Body"><Alignment ss:Vertical="Center"/></Style></Styles><Worksheet ss:Name="Workshop"><Table>${lines.join("")}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><PageSetup><Layout x:Orientation="Landscape"/><PageMargins x:Bottom="0.25" x:Left="0.25" x:Right="0.25" x:Top="0.25"/></PageSetup><FitToPage/><Print><FitWidth>1</FitWidth><FitHeight>1</FitHeight></Print><Selected/></WorksheetOptions></Worksheet></Workbook>`;
    const url = URL.createObjectURL(new Blob(["\uFEFF" + workbook], { type: "application/vnd.ms-excel;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `workshop-${label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 140)}.xls`;
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
            <label>
              Product type
              <select value={selectedSession} onChange={(event) => setSelectedSession(event.target.value)} style={{ display: "block", padding: "10px", minWidth: "220px", marginTop: "6px" }}>
                <option value="">All product types</option>
                {availableSessions.map((session) => <option key={session} value={session}>{session === "-" ? "Session unavailable" : session}</option>)}
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
            label="Search orders, events, dates or product types"
            value={search}
            onInput={(event) => {
              setSearch(
                (event.target as HTMLInputElement).value,
              );
            }}
            />
            <s-button onClick={() => downloadExcel(selectedDateRows, selectedDate)} disabled={!selectedDate || selectedDateRows.length === 0}>
              Download date report (.xls)
            </s-button>
          </s-stack>

          <s-heading>{tableRows.reduce((total, row) => total + row.places, 0)} booked places · {sessionGroups.length} workshop sessions</s-heading>
          <s-text>The filtered results below are grouped by workshop time. Product types are counted inside each session, followed by that session’s participant list.</s-text>

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
            <s-stack direction="block" gap="base">
              {sessionGroups.map(([key, rows], sessionIndex) => {
                const products = [...new Set(tableRows.map((row) => row.product || row.event))];
                const participants = [...rows].sort((a, b) => a.customerName.localeCompare(b.customerName) || a.orderName.localeCompare(b.orderName, undefined, { numeric: true }));
                return (
                  <div key={key} style={{ border: "1px solid #c9cccf", borderRadius: "8px", padding: "16px" }}>
                    <s-heading>Session {sessionIndex + 1}: {rows[0].time}</s-heading>
                    <s-text>{rows[0].event} · {rows[0].date} · {rows.reduce((total, row) => total + row.places, 0)} booked places</s-text>
                    <h4>Product counts</h4>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "16px" }}>
                        <thead><tr>{["Product type", "Count"].map((heading) => <th key={heading} style={{ borderBottom: "1px solid #c9cccf", padding: "8px", textAlign: "left" }}>{heading}</th>)}</tr></thead>
                        <tbody>{products.map((product) => <tr key={product}><td style={{ borderBottom: "1px solid #e1e3e5", padding: "8px" }}>{product}</td><td style={{ borderBottom: "1px solid #e1e3e5", padding: "8px" }}>{rows.filter((row) => (row.product || row.event) === product).reduce((total, row) => total + row.places, 0)}</td></tr>)}</tbody>
                      </table>
                    </div>
                    <h4>Session {sessionIndex + 1} participant list</h4>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", minWidth: "760px", width: "100%" }}>
                        <thead><tr>{["#", "Order ID", "Name", "Product type", "Email address", "Workshop date", "Session time"].map((heading) => <th key={heading} style={{ borderBottom: "1px solid #c9cccf", padding: "8px", textAlign: "left", whiteSpace: "nowrap" }}>{heading}</th>)}</tr></thead>
                        <tbody>{participants.map((row, index) => <tr key={row.id}>{[index + 1, row.orderName, row.customerName, row.product || row.event, row.email, row.date, row.time].map((value, cellIndex) => <td key={cellIndex} style={{ borderBottom: "1px solid #e1e3e5", padding: "8px" }}>{value}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </s-stack>
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
