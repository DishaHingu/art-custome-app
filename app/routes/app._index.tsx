import { useMemo, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

type EventSession = {
  event: string;
  date: string;
  time: string;
  session: string;
};

type Order = {
  id: string;
  name: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  sessions: EventSession[];
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

function parseSession(
  event: string,
  variantTitle: string | null,
): EventSession {
  if (!variantTitle) {
    return {
      event,
      date: "-",
      time: "-",
      session: "-",
    };
  }

  const parts = variantTitle
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    event,
    date: parts[0] || "-",
    time: parts[1] || "-",
    session: parts.slice(2).join(" / ") || "-",
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query GetOrders {
        orders(
          first: 100
          sortKey: CREATED_AT
          reverse: true
        ) {
          nodes {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus

            lineItems(first: 50) {
              nodes {
                quantity
                title
                variant {
                  title
                }
              }
            }
          }
        }
      }
    `,
  );

  const responseJson = (await response.json()) as {
    data?: { orders?: { nodes?: unknown[] } };
    errors?: unknown[];
  };

  if (responseJson.errors?.length) {
    console.error("Shopify orders query failed", responseJson.errors);
    throw new Response("Unable to load orders from Shopify", { status: 502 });
  }

  const orders: Order[] =
    responseJson.data?.orders?.nodes?.map((order: any) => {
      const sessions: EventSession[] = [];

      for (const item of order.lineItems?.nodes || []) {
        const event = item.title || "Unknown Event";
        const parsed = parseSession(event, item.variant?.title || null);

        for (let i = 0; i < (item.quantity || 1); i++) {
          sessions.push(parsed);
        }
      }

      return {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        financialStatus: order.displayFinancialStatus,
        fulfillmentStatus: order.displayFulfillmentStatus,
        sessions,
      };
    }) || [];

  return { orders };
};

export default function Index() {
  const { orders } = useLoaderData<typeof loader>();

  const [search, setSearch] = useState("");
  const [orderPeriod, setOrderPeriod] = useState<"new" | "old" | "all">(
    "new",
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
        })),
      ),
    [filteredOrders],
  );

  const downloadExcel = () => {
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
    const escapeCsv = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const csv = [
      header,
      ...tableRows.map((row) => [
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
    link.download = `event-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const totalSessions = orders.reduce(
    (total, order) => total + order.sessions.length,
    0,
  );
  const newOrderCount = orders.filter((order) =>
    isNewOrder(order.createdAt),
  ).length;
  const oldOrderCount = orders.length - newOrderCount;

  return (
    <s-page heading="Art N Melody Event Dashboard">

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-box>
            <s-heading>Total Orders</s-heading>
            <s-text>{orders.length}</s-text>
          </s-box>

          <s-box>
            <s-heading>Total Sessions</s-heading>
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
            <s-button onClick={downloadExcel} disabled={tableRows.length === 0}>
              Download Excel (.csv)
            </s-button>
          </s-stack>

          {filteredOrders.length === 0 ? (
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
