import { createSign } from "node:crypto";
import { SHEET_HEADERS } from "./sheet-values";

export const SPREADSHEET_ID = "1IY9m4LnEvNv3YUYWhpYEVyQnAXPwj5ENVB-szVGS26c";
export const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
const TAB_TITLE = "Art N Melody Orders (app)";
let cachedToken: { token: string; expiresAt: number } | undefined;

export function sheetsConfigured(shop: string) {
  const allowedShops = (process.env.SHOPIFY_SYNC_SHOP || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY &&
    allowedShops.includes(shop.toLowerCase()),
  );
}

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.token;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !privateKey) throw new Error("Google Sheets connection is not configured.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!response.ok) {
    throw new Error(
      "Google service-account email and private key do not match. In Vercel, replace both Google variables using the same downloaded JSON file.",
    );
  }
  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function sheets<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const token = await accessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    method, signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    if (response.status === 401) cachedToken = undefined;
    throw new Error(
      response.status === 403
        ? "Google cannot edit the demo Sheet. Share it with the exact client_email from the JSON file as Editor, then retry."
        : "Google Sheets API could not be reached. Confirm it is enabled in the same Google Cloud project as the service account, then retry.",
    );
  }
  return response.json() as Promise<T>;
}

export async function ensureTab(existingId: number | null) {
  const metadata = await sheets<{ sheets: { properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } }[] }>("?fields=sheets.properties");
  if (existingId !== null) {
    const tab = metadata.sheets.find((sheet) => sheet.properties.sheetId === existingId);
    if (!tab) throw new Error("The app's sync tab was deleted. Restore it before retrying.");
    return tab.properties;
  }
  if (metadata.sheets.some((sheet) => sheet.properties.title === TAB_TITLE)) {
    throw new Error(`A tab named ${TAB_TITLE} already exists. Rename that tab so the app can create its own sync tab safely.`);
  }
  const created = await sheets<{ replies: { addSheet: { properties: { sheetId: number; title: string; gridProperties: { rowCount: number } } } }[] }>(":batchUpdate", "POST", {
    requests: [{ addSheet: { properties: { title: TAB_TITLE, gridProperties: { rowCount: 1000, columnCount: SHEET_HEADERS.length, frozenRowCount: 1 } } } }],
  });
  return created.replies[0].addSheet.properties;
}

// Explicit stringValue prevents customer-controlled text from becoming formulas.
export async function writeRows(tabId: number, existingRowCount: number, rows: { rowNumber: number; values: (string | number)[] }[]) {
  const lastRow = Math.max(1, ...rows.map((row) => row.rowNumber));
  const requests: unknown[] = [];
  if (lastRow > existingRowCount) requests.push({ updateSheetProperties: { properties: { sheetId: tabId, gridProperties: { rowCount: lastRow + 100 } }, fields: "gridProperties.rowCount" } });
  for (const row of [{ rowNumber: 1, values: SHEET_HEADERS }, ...rows]) {
    requests.push({ updateCells: {
      start: { sheetId: tabId, rowIndex: row.rowNumber - 1, columnIndex: 0 },
      rows: [{ values: row.values.map((value) => ({ userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value } })) }],
      fields: "userEnteredValue",
    } });
  }
  await sheets(":batchUpdate", "POST", { requests });
}
