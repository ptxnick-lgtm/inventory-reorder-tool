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

function rowsToTable(raw: string[][]): ParseResult {
  // Find the header row: the first row containing both an item-ish and a vendor-ish column.
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
    if (!vendor) {
      unmatched[vendorRaw] = (unmatched[vendorRaw] || 0) + 1;
      continue;
    }
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

export function parseCSVText(text: string): ParseResult {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const result = rowsToTable(parsed.data as string[][]);
  result.detectedDate = detectDateFromText(text);
  return result;
}

export function parseXLSX(buf: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: "" });
  const result = rowsToTable(raw as string[][]);
  const flat = (raw as string[][]).flat().join(" ");
  result.detectedDate = detectDateFromText(flat);
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
