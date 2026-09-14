export type PageInfo = { hasNextPage: boolean; endCursor: string | null };
export type LineItem = {
  id: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  currentQuantity: number;
};
export type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  lineItems: { nodes: LineItem[]; pageInfo: PageInfo };
};
// A structural interface also allows pagination/error cases to be tested without credentials.
export type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json(): Promise<unknown> }>;
};

const ORDER_FIELDS = `
  id name createdAt updatedAt cancelledAt
  displayFinancialStatus displayFulfillmentStatus
  lineItems(first: 20) {
    nodes { id title variantTitle quantity currentQuantity }
    pageInfo { hasNextPage endCursor }
  }
`;
export const ORDERS_QUERY = `#graphql
  query DashboardOrders($after: String) {
    currentAppInstallation { accessScopes { handle } }
    orders(first: 20, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes { ${ORDER_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
export const ORDER_QUERY = `#graphql
  query SyncOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }
`;
export const ITEMS_QUERY = `#graphql
  query RemainingOrderItems($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: 250, after: $after) {
        nodes { id title variantTitle quantity currentQuantity }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

async function query<T>(admin: AdminClient, document: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Awaited<ReturnType<AdminClient["graphql"]>>;
    try {
      response = await admin.graphql(document, { variables });
    } catch (error) {
      const sdkErrors = (error as { body?: { errors?: { graphQLErrors?: { extensions?: { code?: string } }[] } } })?.body?.errors?.graphQLErrors;
      if (sdkErrors?.length && sdkErrors.every((item) => item.extensions?.code === "THROTTLED") && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error("Shopify could not load orders. Check order permissions and try again.");
    }
    const body = await response.json() as { data?: T; errors?: { extensions?: { code?: string } }[] };
    if (body.errors?.length) {
      if (body.errors.every((error) => error.extensions?.code === "THROTTLED") && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error("Shopify could not load orders. Check order permissions and try again.");
    }
    if (!body.data) throw new Error("Shopify returned no order data. Please retry.");
    return body.data;
  }
  throw new Error("Shopify is busy. Please retry.");
}

function nextCursor(page: PageInfo, previous: string | null): string | null {
  if (!page.hasNextPage) return null;
  if (!page.endCursor || page.endCursor === previous) throw new Error("Shopify pagination did not advance. Please retry.");
  return page.endCursor;
}

async function completeItems(admin: AdminClient, order: ShopifyOrder) {
  let after = nextCursor(order.lineItems.pageInfo, null);
  while (after) {
    const data = await query<{ order: { lineItems: ShopifyOrder["lineItems"] } | null }>(admin, ITEMS_QUERY, { id: order.id, after });
    if (!data.order) throw new Error("An order changed while loading. Refresh to retry.");
    order.lineItems.nodes.push(...data.order.lineItems.nodes);
    after = nextCursor(data.order.lineItems.pageInfo, after);
  }
  order.lineItems.nodes = [...new Map(order.lineItems.nodes.map((item) => [item.id, item])).values()];
  return order;
}

export async function loadOrder(admin: AdminClient, id: string) {
  const data = await query<{ order: ShopifyOrder | null }>(admin, ORDER_QUERY, { id });
  return data.order ? completeItems(admin, data.order) : null;
}

export async function loadAllOrders(admin: AdminClient) {
  const orders = new Map<string, ShopifyOrder>();
  let after: string | null = null;
  let hasAllOrdersAccess = false;
  do {
    const data: {
      currentAppInstallation: { accessScopes: { handle: string }[] };
      orders: { nodes: ShopifyOrder[]; pageInfo: PageInfo };
    } = await query(admin, ORDERS_QUERY, { after });
    hasAllOrdersAccess = data.currentAppInstallation.accessScopes.some((scope) => scope.handle === "read_all_orders");
    for (const order of data.orders.nodes) orders.set(order.id, await completeItems(admin, order));
    after = nextCursor(data.orders.pageInfo, after);
  } while (after);
  return { orders: [...orders.values()], hasAllOrdersAccess };
}

export function parseSession(event: string, variantTitle: string | null) {
  const parts = variantTitle && variantTitle !== "Default Title"
    ? variantTitle.split("/").map((part) => part.trim()).filter(Boolean)
    : [];
  return { event, date: parts[0] || "-", time: parts[1] || "-", session: parts.slice(2).join(" / ") || "-" };
}

export function dashboardOrder(order: ShopifyOrder) {
  return {
    id: order.id, name: order.name, createdAt: order.createdAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    sessions: order.lineItems.nodes.length ? order.lineItems.nodes.flatMap((item) =>
      Array.from({ length: Math.max(1, item.quantity) }, () => ({ ...parseSession(item.title, item.variantTitle), places: item.quantity > 0 ? 1 : 0 })))
      : [{ ...parseSession("No line items", null), places: 0 }],
  };
}
