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

export async function fetchAllSnapshots(onProgress?: (done: number, total: number) => void) {
  // Pull every snapshot row. Supabase caps a single select at 1,000 rows, and
  // one snapshot alone is ~1,600 rows, so we page through with .range() until a
  // short page tells us we've reached the end. Order by id for stable paging
  // (classify re-sorts by date internally).
  const PAGE = 1000;

  // Probe once whether reorder_min exists (added by a later migration).
  let cols = "snapshot_date,item,vendor,qoh,po,reorder_min";
  const probe = await supabase.from("snapshots").select(cols).limit(1);
  if (probe.error) cols = "snapshot_date,item,vendor,qoh,po";

  // Total row count so we can fetch all pages in parallel (much faster than
  // walking them one-by-one as history grows).
  const head = await supabase.from("snapshots").select("id", { count: "exact", head: true });
  const total = typeof head.count === "number" ? head.count : 0;

  if (!total) {
    // Unknown count — fall back to a simple sequential walk.
    const all: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from("snapshots").select(cols).order("id").range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      onProgress?.(all.length, all.length);
      if (data.length < PAGE) break;
    }
    return all;
  }

  const pageCount = Math.ceil(total / PAGE);
  let done = 0;
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => i).map(async (i) => {
      const { data, error } = await supabase.from("snapshots").select(cols).order("id").range(i * PAGE, i * PAGE + PAGE - 1);
      if (error) throw error;
      done += 1;
      onProgress?.(done, pageCount);
      return data || [];
    })
  );
  return pages.flat();
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
  rows: { item: string; vendor: string; qoh: number; po: number; min?: number }[],
  filename: string
) {
  // Remove any existing rows for this date first (allows re-uploading a corrected file).
  await supabase.from("snapshots").delete().eq("snapshot_date", date);

  const withMin = rows.map((r) => ({
    snapshot_date: date, item: r.item, vendor: r.vendor, qoh: r.qoh, po: r.po, reorder_min: r.min ?? null,
  }));
  const baseOnly = rows.map((r) => ({
    snapshot_date: date, item: r.item, vendor: r.vendor, qoh: r.qoh, po: r.po,
  }));

  // Insert in chunks. If the reorder_min column doesn't exist yet, fall back to
  // the base columns so uploads keep working before the migration is run.
  const CHUNK = 500;
  let useMin = true;
  for (let i = 0; i < rows.length; i += CHUNK) {
    if (useMin) {
      const { error } = await supabase.from("snapshots").insert(withMin.slice(i, i + CHUNK));
      if (error && /reorder_min|column/i.test(error.message)) {
        useMin = false;
        const retry = await supabase.from("snapshots").insert(baseOnly.slice(i, i + CHUNK));
        if (retry.error) throw retry.error;
      } else if (error) {
        throw error;
      }
    } else {
      const { error } = await supabase.from("snapshots").insert(baseOnly.slice(i, i + CHUNK));
      if (error) throw error;
    }
  }

  await supabase.from("imported_files").insert({
    snapshot_date: date,
    filename,
    row_count: rows.length,
  });
}

export interface ProductRow {
  item: string;
  cost: number;
  price: number;
  updated_at?: string;
}

export async function fetchProducts(): Promise<ProductRow[]> {
  // Page through so a large catalogue isn't clipped at the 1,000-row select cap.
  const PAGE = 1000;
  const all: ProductRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("item,cost,price,updated_at")
      .order("item")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as ProductRow[]));
    if (data.length < PAGE) break;
  }
  return all;
}

export async function upsertProduct(item: string, cost: number, price: number) {
  const { error } = await supabase
    .from("products")
    .upsert({ item, cost, price, updated_at: new Date().toISOString() }, { onConflict: "item" });
  if (error) throw error;
}

// Remove a whole snapshot for a date: the inventory rows plus its import-log entry.
export async function deleteSnapshot(date: string) {
  const { error: e1 } = await supabase.from("snapshots").delete().eq("snapshot_date", date);
  if (e1) throw e1;
  const { error: e2 } = await supabase.from("imported_files").delete().eq("snapshot_date", date);
  if (e2) throw e2;
}

export async function upsertProducts(rows: ProductRow[]) {
  const CHUNK = 500;
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const payload = rows.slice(i, i + CHUNK).map((r) => ({ item: r.item, cost: r.cost, price: r.price, updated_at: stamp }));
    const { error } = await supabase.from("products").upsert(payload, { onConflict: "item" });
    if (error) throw error;
  }
}

export interface ItemFlagRow { item: string; status: string; note: string; tags: string; group: string; }

export async function fetchItemFlags(): Promise<ItemFlagRow[]> {
  const { data, error } = await supabase.from("item_flags").select("item,status,note,tags,group_name");
  if (error) throw error;
  return ((data || []) as any[]).map((r) => ({ item: r.item, status: r.status || "", note: r.note || "", tags: r.tags || "", group: r.group_name || "" }));
}

// Save an item's status/note/tags/group, or delete the row entirely if all are empty.
export async function saveItemMeta(item: string, meta: { status: string; note: string; tags: string; group: string }) {
  const empty = !meta.status && !meta.note.trim() && !meta.tags.trim() && !meta.group.trim();
  if (empty) {
    const { error } = await supabase.from("item_flags").delete().eq("item", item);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("item_flags")
      .upsert({ item, status: meta.status, note: meta.note.trim() || null, tags: meta.tags.trim() || null, group_name: meta.group.trim() || null, updated_at: new Date().toISOString() }, { onConflict: "item" });
    if (error) throw error;
  }
}

export async function updateVendor(name: string, patch: Partial<VendorRow>) {
  const { error } = await supabase.from("vendors").update(patch).eq("name", name);
  if (error) throw error;
}

export async function addVendor(name: string, lead_days = 14, excluded = false) {
  const { error } = await supabase.from("vendors").insert({ name, lead_days, excluded });
  if (error) throw error;
}
