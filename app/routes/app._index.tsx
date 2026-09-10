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
  customerName: string;
  customerEmail: string;
  sessions: EventSession[];
};

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

            customer {
              displayName
              email
            }

            lineItems(first: 50) {
              nodes {
                quantity
                title

                variant {
                  title

                  product {
                    title
                  }
                }
              }
            }
          }
        }
      }
    `,
  );

  const responseJson = await response.json();

  const orders: Order[] =
    responseJson.data?.orders?.nodes?.map((order: any) => {
      const sessions: EventSession[] = [];

      for (const item of order.lineItems?.nodes || []) {
        const event =
          item.variant?.product?.title ||
          item.title ||
          "Unknown Event";

        const parsed = parseSession(
          event,
          item.variant?.title || null,
        );

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
        customerName:
          order.customer?.displayName || "Guest",
        customerEmail:
          order.customer?.email || "-",
        sessions,
      };
    }) || [];

  return { orders };
};

export default function Index() {
  const { orders } = useLoaderData<typeof loader>();

  const [search, setSearch] = useState("");

  const filteredOrders = useMemo(() => {
    const value = search.toLowerCase().trim();

    if (!value) {
      return orders;
    }

    return orders.filter((order) => {
      const orderText = [
        order.name,
        order.customerName,
        order.customerEmail,
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
  }, [orders, search]);

  const totalSessions = orders.reduce(
    (total, order) => total + order.sessions.length,
    0,
  );

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
        </s-stack>
      </s-section>

      <s-section heading="Event & Session Orders">

        <s-stack direction="block" gap="base">

          <s-text-field
            label="Search orders, customers, events or sessions"
            value={search}
            onInput={(event) => {
              setSearch(
                (event.target as HTMLInputElement).value,
              );
            }}
          />

          {filteredOrders.length === 0 ? (
            <s-box padding="large">
              <s-text>
                No orders found.
              </s-text>
            </s-box>
          ) : (
            filteredOrders.map((order) => (
              <s-box
                key={order.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">

                  <s-stack
                    direction="inline"
                    gap="base"
                    justifyContent="space-between"
                  >
                    <s-heading>
                      Order {order.name}
                    </s-heading>

                    <s-text>
                      {new Date(
                        order.createdAt,
                      ).toLocaleDateString()}
                    </s-text>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="block" gap="small">

                    <s-text>
                      <strong>Customer:</strong>{" "}
                      {order.customerName}
                    </s-text>

                    <s-text>
                      <strong>Email:</strong>{" "}
                      {order.customerEmail}
                    </s-text>

                    <s-text>
                      <strong>Payment:</strong>{" "}
                      {order.financialStatus || "-"}
                    </s-text>

                    <s-text>
                      <strong>Fulfillment:</strong>{" "}
                      {order.fulfillmentStatus || "-"}
                    </s-text>

                  </s-stack>

                  <s-heading>
                    Event Sessions
                  </s-heading>

                  {order.sessions.map(
                    (session, index) => (
                      <s-box
                        key={`${order.id}-${index}`}
                        padding="base"
                        borderWidth="base"
                        borderRadius="base"
                        background="subdued"
                      >
                        <s-stack
                          direction="block"
                          gap="small"
                        >

                          <s-text>
                            <strong>Event:</strong>{" "}
                            {session.event}
                          </s-text>

                          <s-text>
                            <strong>Date:</strong>{" "}
                            {session.date}
                          </s-text>

                          <s-text>
                            <strong>Time:</strong>{" "}
                            {session.time}
                          </s-text>

                          <s-text>
                            <strong>Session:</strong>{" "}
                            {session.session}
                          </s-text>

                        </s-stack>
                      </s-box>
                    ),
                  )}

                </s-stack>
              </s-box>
            ))
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

        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};