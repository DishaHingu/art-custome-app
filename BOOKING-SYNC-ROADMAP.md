# Workshop booking sync options

Researched 14 September 2026. Google Sheets stored in Google Drive is the practical destination for a live booking list.

## Initial option: Shopify Flow and Google Sheets

Shopify's built-in Flow connector can append spreadsheet rows, including a row per order line item. This is a suitable pilot for new bookings. Appending alone does not keep an existing booking row correct after cancellation, refund, rescheduling or quantity changes; those cases need a separate update strategy before treating the sheet as an attendance register.

Source: https://help.shopify.com/en/manual/shopify-flow/reference/connectors/add-row-to-spreadsheet

## App to evaluate: eCommix – Google Sheets Sync

The Shopify App Store lists order exports and automatic Google Sheets sync. Trial it with the actual workshop variants before purchase. Verify refresh frequency, historical import, one row per line item, order edits, cancellations, refunds, permissions and current pricing with the vendor.

Source: https://apps.shopify.com/ecommix-google-sheets-sync

## Growing business: extend this app

Recommended architecture: Shopify booking events → persistent booking database → Google Sheets in the client's Drive. Use stable order and line-item IDs to update existing rows rather than append duplicates. Include retry handling, reconciliation, cancellation/refund updates and an initial historical import. Keep workshop date, time and session in separate fields, with a summary tab for quantities per date/session. Test orders containing multiple dates and sessions and quantities greater than one.

This is a proposed design, not an installed integration. Google account authorization and the target spreadsheet will be needed when implementation begins.

## Current dashboard

The date dropdown is derived from loaded orders. Date downloads group matching session rows in one CSV; individual session buttons export separate CSVs. Counts reflect ordered quantities and active filters, not unique customers or confirmed attendance. Refresh bookings fetches current data.

The loader now paginates all accessible orders and line items, and checks whether Shopify granted access to orders older than 60 days. The Google Sheets integration has now been implemented; see GOOGLE-SHEETS-SETUP.md for activation, backfill and operating limitations. Google credentials and Shopify's older-order permission are required before full live sync can be verified.
