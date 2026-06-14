import Papa from "papaparse";
import * as XLSX from "xlsx";
import { canonicalVendor } from "./vendors";

export interface ParsedRow {
  qoh: number;
  item: string;
  vendor: string;
  po: number;
}

export interface ParseResult {
  rows: ParsedRow[];
  unmatchedVendors: { raw: string; count: number }[];
  skipped: number;
  detectedDate: string | null;
}

const HEADER_ALIASES: Record<string, string[]> = {
  qoh: ["quantity on hand", "qty on hand", "qoh", "on hand", "quantity"],
  item: ["item", "product", "name", "description"],
  vendor: ["preferred vendor", "vendor", "supplier", "preferred ven"],
  po: ["quantity on purchase order", "quantity on pu", "qty on po", "on purchase order", "on order", "po qty"],
};

function matchHeader(header: string): keyof typeof HEADER_ALIASES | null {
  const h = header.toLowerCase().trim().replace(/\.\.\.$/, "");
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) if (h === a || h.startsWith(a)) return key as keyof typeof HEADER_ALIASES;
  }
  return null;
}

// QuickBooks "Physical Inventory Worksheet" CSV export is NOT real CSV — each row
// is one quoted string with columns separated by runs of spaces. Detect and handle it.
function parseQuickBooksSpaceFormat(lines: string[]): ParseResult | null {
  const rows: ParsedRow[] = [];
  const unmatched: Record<string, number> = {};
  let skipped = 0;
  let matchedAny = false;

  for (const raw of lines) {
    const line = raw.trim().replace(/^"+|"+$/g, "").trim();
    if (!line) continue;
    const m = line.match(/^(-?\d+)\s+(.+)$/);
    if (!m) continue;
    const qoh = parseInt(m[1], 10);
    if (Number.isNaN(qoh)) continue;

    let rest = m[2];
    const poMatch = rest.match(/\s+(-?\d+)\s*$/);
    let po = 0;
    if (poMatch) {
      po = parseInt(poMatch[1], 10);
      rest = rest.slice(0, poMatch.index).trimEnd();
    }
    const parts = rest.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) { continue; }

    const vendorRaw = parts[parts.length - 1];
    const itemRaw = parts.slice(0, -1).join(" ");
    const vendor = canonicalVendor(vendorRaw);
    if (!vendor) { unmatched[vendorRaw] = (unmatched[vendorRaw] || 0) + 1; continue; }
    if (!itemRaw) { skipped++; continue; }

    matchedAny = true;
    rows.push({ qoh, item: itemRaw, vendor, po: Number.isNaN(po) ? 0 : po });
  }

  if (!matchedAny) return null;
  return {
    rows,
    unmatchedVendors: Object.entries(unmatched).map(([raw, count]) => ({ raw, count })),
    skipped,
    detectedDate: null,
  };
}

function rowsToTable(raw: string[][]): ParseResult {
  let headerIdx = -1;
  let colMap: Partial<Record<string, number>> = {};
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const map: Partial<Record<string, number>> = {};
    raw[i].forEach((cell, idx) => {
      const m = matchHeader(String(cell || ""));
      if (m && map[m] === undefined) map[m] = idx;
    });
    if (map.item !== undefined && map.vendor !== undefined) {
      headerIdx = i;
      colMap = map;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      "Could not find the expected columns. The file needs an 'Item' column and a 'Preferred Vendor' column (a Quantity On Hand column is also expected)."
    );
  }

  const rows: ParsedRow[] = [];
  const unmatched: Record<string, number> = {};
  let skipped = 0;

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.every((c) => String(c || "").trim() === "")) continue;

    const itemRaw = colMap.item !== undefined ? String(r[colMap.item] || "").trim() : "";
    const vendorRaw = colMap.vendor !== undefined ? String(r[colMap.vendor] || "").trim() : "";
    const qohRaw = colMap.qoh !== undefined ? String(r[colMap.qoh] || "").trim() : "";
    const poRaw = colMap.po !== undefined ? String(r[colMap.po] || "").trim() : "";

    if (!itemRaw && !vendorRaw) continue;

    const qoh = parseInt(qohRaw, 10);
    if (Number.isNaN(qoh)) { skipped++; continue; }
    const po = Number.isNaN(parseInt(poRaw, 10)) ? 0 : parseInt(poRaw, 10);

    const vendor = canonicalVendor(vendorRaw);
    if (!vendor) { unmatched[vendorRaw] = (unmatched[vendorRaw] || 0) + 1; continue; }
    if (!itemRaw) { skipped++; continue; }

    rows.push({ qoh, item: itemRaw, vendor, po });
  }

  return {
    rows,
    unmatchedVendors: Object.entries(unmatched).map(([raw, count]) => ({ raw, count })),
    skipped,
    detectedDate: null,
  };
}

export interface PricingRow { item: string; cost: number; price: number; }

// Parse a QuickBooks "Inventory Valuation" style CSV that carries Avg Cost and
// Sales Price per item (item is the first, header-less column). Used to bulk-fill
// product pricing for the revenue dashboard.
export function parsePricingCSV(text: string): PricingRow[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const rows = parsed.data as string[][];
  let headerIdx = -1, costIdx = -1, priceIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const lc = rows[i].map((c) => String(c || "").toLowerCase().trim());
    const ci = lc.findIndex((c) => c.includes("avg cost") || c === "cost" || c.includes("average cost"));
    const pi = lc.findIndex((c) => c.includes("sales price") || c === "price");
    if (ci !== -1 && pi !== -1) { headerIdx = i; costIdx = ci; priceIdx = pi; break; }
  }
  if (headerIdx === -1) {
    throw new Error("Could not find 'Avg Cost' and 'Sales Price' columns in this file. Make sure it's the inventory valuation / pricing export.");
  }
  const out: PricingRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const item = String(r[0] || "").trim();
    if (!item || /^(inventory|total)\b/i.test(item)) continue;
    const cost = parseFloat(String(r[costIdx] || "").replace(/[^0-9.\-]/g, ""));
    const price = parseFloat(String(r[priceIdx] || "").replace(/[^0-9.\-]/g, ""));
    if (Number.isNaN(cost) && Number.isNaN(price)) continue;
    out.push({ item, cost: Number.isNaN(cost) ? 0 : cost, price: Number.isNaN(price) ? 0 : price });
  }
  return out;
}

export function parseCSVText(text: string, filename = ""): ParseResult {
  const lines = text.split(/\r?\n/);
  // Try the QuickBooks space-aligned format first.
  const qb = parseQuickBooksSpaceFormat(lines);
  if (qb && qb.rows.length > 0) {
    qb.detectedDate = detectDateFromText(text) || detectDateFromFilename(filename);
    return qb;
  }
  // Fall back to a normal comma-separated CSV.
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const result = rowsToTable(parsed.data as string[][]);
  result.detectedDate = detectDateFromText(text) || detectDateFromFilename(filename);
  return result;
}

export function parseXLSX(buf: ArrayBuffer, filename = ""): ParseResult {
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: "" });
  const flat = (raw as string[][]).flat().join(" ");

  // If Excel collapsed everything into one column per row (QuickBooks space format
  // saved as xlsx), try the space parser on the joined rows.
  const looksSingleCol = (raw as string[][]).slice(0, 10).every((r) => r.filter((c) => String(c).trim()).length <= 1);
  if (looksSingleCol) {
    const lines = (raw as string[][]).map((r) => r.map((c) => String(c || "")).join(" "));
    const qb = parseQuickBooksSpaceFormat(lines);
    if (qb && qb.rows.length > 0) {
      qb.detectedDate = detectDateFromText(flat) || detectDateFromFilename(filename);
      return qb;
    }
  }

  const result = rowsToTable(raw as string[][]);
  result.detectedDate = detectDateFromText(flat) || detectDateFromFilename(filename);
  return result;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

export function detectDateFromText(text: string): string | null {
  const spelled = text.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (spelled) {
    const mon = MONTHS[spelled[1].toLowerCase()];
    return `${spelled[3]}-${mon}-${String(spelled[2]).padStart(2, "0")}`;
  }
  const slash = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    let [, mm, dd, yy] = slash;
    if (yy.length === 2) yy = "20" + yy;
    return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  return null;
}

// Inventory exports are often named with the date (e.g. "Inventory_2026-05-06.csv"
// or "Inventory-6-12-2026.csv") while the file's contents carry no date at all.
// This reads the date out of the filename, accepting -, _, ., or / separators and
// either order (year first or year last).
export function detectDateFromFilename(name: string): string | null {
  if (!name) return null;
  // Year first: 2026-05-06 / 2026_05_06 / 2026.05.06
  let m = name.match(/(20\d\d)[-_.](\d{1,2})[-_.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // Year last, 4-digit year: 6-12-2026 / 06_12_2026 / 6/12/2026
  m = name.match(/(\d{1,2})[-_.\/](\d{1,2})[-_.\/](20\d\d)/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  // Year last, 2-digit year: 6-12-26
  m = name.match(/(\d{1,2})[-_.\/](\d{1,2})[-_.\/](\d{2})(?:\D|$)/);
  if (m) return `20${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}
