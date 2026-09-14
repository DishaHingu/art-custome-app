# Activate full order history and Google Sheets sync

The implementation is ready for configuration. A shared spreadsheet URL does not supply credentials for a server to write to it.

## Deployment status — 14 September 2026

Latest connection update: the client selected the original **demo** spreadsheet and confirmed sharing it with the service account. Google credential variable names are now present in Vercel Production; their values are non-exportable secrets, so they have not been locally inspected or authenticated. `shopify.app.current-orders.toml` was validated and successfully released as **art-n-melody-event-dashboard-6**, enabling order webhooks with `read_orders,read_products`. The full-history configurations still require Shopify approval for `read_all_orders`. The exact canonical store domain is still needed for `SHOPIFY_SYNC_SHOP`, followed by redeployment and an actual Sheet sync check. Do not treat the earlier missing-credential report below as the current variable inventory.

- Updated web app deployed successfully to https://art-custome-app-creh.vercel.app and the sync database migration was applied.
- Public app health check returned HTTP 200; the retry endpoint correctly returned HTTP 401 without its secret.
- Both Shopify configuration files validated locally, and the order queries passed Shopify's 2025-10 API schema validation.
- Shopify rejected publishing the new app version with `app_access` → `scopes: read_all_orders`. The new Shopify scope/webhook configuration was **not released**. Resolve All orders access, then rerun `shopify app deploy --allow-updates` with the current CLI.
- Production has no Google service-account variables configured. No orders have been written to the supplied spreadsheet by this implementation, and live end-to-end sync is not yet verified.
- Nine local tests passed, including failure/retry, repeated import, concurrent worker exclusion and an update arriving during a Sheet write. TypeScript, changed-file lint and production build passed.

## 1. Enable older Shopify orders

The existing app only requested `read_orders`, which normally exposes the last 60 days. This explains why September's dashboard can show six recent orders while older June/July orders remain visible in Shopify Admin.

In the Shopify Dev/Partner Dashboard, open **Art N Melody Event Dashboard** (client ID `84ad78e10b01817331fb18f4a10b6927`) and request/enable **All orders** access. Shopify approval may be required for this app's distribution. After access is available:

1. Set Vercel Production `SCOPES` to `read_orders,read_products,read_all_orders`.
2. Deploy the updated Shopify configuration with `shopify app deploy` from this directory. Both local configurations now request the same scopes and order webhooks.
3. Approve the updated app permissions in the store, then reopen the app.
4. Confirm the older-orders permission notice disappears and compare order IDs/counts against Shopify's Orders list. The sidebar badge alone is not a reliable total-order count.

The app checks the installation's granted scopes, not just configured scopes. Pagination loads all accessible orders and all of their line items. No API code can bypass Shopify's history access restriction.

Source: https://shopify.dev/docs/api/usage/access-scopes#orders-permissions

## 2. Connect the supplied spreadsheet

Destination: https://docs.google.com/spreadsheets/d/1IY9m4LnEvNv3YUYWhpYEVyQnAXPwj5ENVB-szVGS26c/edit

1. In the client's Google Cloud project, enable the **Google Sheets API** and create a service account for this integration. Keep the private key out of chat and source control.
2. Share this spreadsheet with the service account email as **Editor**. Only this spreadsheet needs to be shared with that account.
3. Add these server-side Vercel Production variables:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: service account email.
   - `GOOGLE_PRIVATE_KEY`: the service account private key; actual newlines or escaped `\n` are supported.
   - `SHOPIFY_SYNC_SHOP`: the store's exact canonical `*.myshopify.com` domain, as recorded by the app's Shopify session. Do not use the Admin URL slug unless it matches that domain.
   - `CRON_SECRET`: a randomly generated secret of at least 32 bytes for the retry endpoint.
4. Deploy the app to Vercel. Its existing build command runs Prisma generation and the additive database migration before building the app. Keep the function duration at least 60 seconds for background work.
5. Open the app and click **Import all orders to Sheet** once. This queues historical orders independently of date/search filters. Repeating it safely updates the same rows.
6. Verify the first successful sync time, zero pending jobs, and older/newer order IDs in the sheet. Make one controlled test booking, edit/refund it, and confirm its existing rows update.

The app creates a dedicated **Art N Melody Orders (app)** tab. Existing tabs are preserved. If a tab with that name already exists before the first connection, the app stops rather than overwrite it; rename the conflicting tab before retrying.

Do not sort, insert, move or delete physical rows in the app-managed tab: stable row positions are used for duplicate-free updates. Use a separate reporting tab or filter view instead. Renaming the app tab is supported because its numeric sheet ID is stored. Restore the same tab if it is accidentally deleted. Keep the sync database and its row mappings when redeploying or reconnecting.

Each row represents one order line item, with separate date/time/session, ordered quantity and current quantity. Orders without line items remain represented. Refunds/cancellations are retained, not silently removed. No customer email, phone or postal address is requested or exported by this implementation.

## Delivery and recovery

- Authenticated Shopify webhooks for creation, updates, payment, cancellation, refunds and deletion persist jobs before acknowledgement.
- Vercel background work starts immediately after notification delivery; this is near real time, not a zero-delay guarantee.
- The worker rereads the current Shopify order instead of trusting potentially stale webhook payloads.
- A per-store database lease serializes sheet writers. Stable row mappings make retries safe. A newer event received during a write stays queued.
- Failed writes remain queued with retry backoff. A new notification or **Retry pending sync** processes due jobs. The app polls the status every 15 seconds while visible.
- A daily Vercel cron at 03:00 UTC drains pending work. For faster unattended retry recovery, configure an authenticated scheduler to call `/api/sync-retry` every minute (and confirm your hosting plan supports that frequency). The daily default does not provide minute-by-minute recovery from outages.
- Large historical imports may need several **Retry pending sync** runs; workers process bounded batches within the request runtime. At larger scale, replace the daily recovery trigger with a continuously scheduled worker/queue and use Shopify bulk import for initial history.
- The retry endpoint rejects requests without `Authorization: Bearer <CRON_SECRET>`.
- Before updating webhook registrations, deploy the corresponding server routes and database migration. Do not claim sync is active until actual webhook delivery and Sheet writes have been verified.

Sources:
- https://shopify.dev/docs/apps/build/webhooks
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate

## Validation performed locally

Run `npm test`, `npm run typecheck`, and lint the changed files. Tests cover order/item pagination, restricted history, API failures, empty orders, session edits/refunds, stable identifiers, literal Google cell values and existing-tab protection. Live verification requires the Shopify access grant and Google credentials above.
