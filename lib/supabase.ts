import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anon);

export interface VendorRow {
  name: string;
  lead_days: number;
  excluded: boolean;
}

export async function fetchVendors(): Promise<VendorRow[]> {
  const { data, error } = await supabase.from("vendors").select("*").order("name");
  if (error) throw error;
  return data as VendorRow[];
}

export async function fetchAllSnapshots() {
  // Pull every snapshot row. Supabase caps a single select at 1,000 rows, and
  // one snapshot alone is ~1,600 rows, so we page through with .range() until a
  // short page tells us we've reached the end. Order by id for stable paging
  // (classify re-sorts by date internally).
  const PAGE = 1000;
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("snapshots")
      .select("snapshot_date,item,vendor,qoh,po")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

export async function fetchImportedDates(): Promise<string[]> {
  // Read the date list from imported_files (one row per upload) rather than the
  // huge snapshots table — otherwise the 1,000-row select cap collapses every
  // date into just the earliest snapshot's date.
  const { data, error } = await supabase
    .from("imported_files")
    .select("snapshot_date")
    .order("snapshot_date");
  if (error) throw error;
  const set = new Set((data || []).map((r: any) => r.snapshot_date));
  return Array.from(set).sort();
}

export async function insertSnapshot(
  date: string,
  rows: { item: string; vendor: string; qoh: number; po: number }[],
  filename: string
) {
  // Remove any existing rows for this date first (allows re-uploading a corrected file).
  await supabase.from("snapshots").delete().eq("snapshot_date", date);

  const payload = rows.map((r) => ({
    snapshot_date: date,
    item: r.item,
    vendor: r.vendor,
    qoh: r.qoh,
    po: r.po,
  }));

  // Insert in chunks to stay well under request limits.
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await supabase.from("snapshots").insert(payload.slice(i, i + CHUNK));
    if (error) throw error;
  }

  await supabase.from("imported_files").insert({
    snapshot_date: date,
    filename,
    row_count: rows.length,
  });
}

export async function updateVendor(name: string, patch: Partial<VendorRow>) {
  const { error } = await supabase.from("vendors").update(patch).eq("name", name);
  if (error) throw error;
}

export async function addVendor(name: string, lead_days = 14, excluded = false) {
  const { error } = await supabase.from("vendors").insert({ name, lead_days, excluded });
  if (error) throw error;
}
