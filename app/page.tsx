"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { parseCSVText, parseXLSX, parsePricingCSV, ParseResult } from "@/lib/parser";
import { classify, inventoryChanges, ClassifiedItem, TIER_META, Tier, SnapshotRow } from "@/lib/classify";
import {
  fetchVendors, fetchAllSnapshots, insertSnapshot, fetchImportedDates,
  updateVendor, addVendor, fetchProducts, upsertProduct, upsertProducts, deleteSnapshot,
  fetchItemFlags, saveItemMeta, VendorRow, ProductRow,
} from "@/lib/supabase";

type ItemMeta = { status: string; note: string; tags: string; group: string };
const isHiddenStatus = (s: string) => s === "discontinued" || s === "one_time";
import { exportSortedPdf } from "@/lib/exportPdf";

type Stage = "idle" | "parsing" | "review" | "saving" | "done";

type SoldItem = { item: string; vendor: string; units: number; revenue: number; profit: number };
type Period = { date: string; sold: SoldItem[]; restockCost: number };
type RevPoint = { date: string; revenue: number; profit: number };

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Most recent updated_at across a product map (when pricing was last touched).
function pricingUpdatedAt(productMap: Map<string, ProductRow>): string | null {
  let max = "";
  for (const p of productMap.values()) if (p.updated_at && p.updated_at > max) max = p.updated_at;
  return max || null;
}

// Per-item reorder min/max overrides drawn from the products table.
function reorderOverrides(prods: ProductRow[]): { min: Record<string, number>; max: Record<string, number> } {
  const min: Record<string, number> = {}, max: Record<string, number> = {};
  for (const p of prods) {
    if (p.reorderMin != null) min[p.item] = p.reorderMin;
    if (p.reorderMax != null) max[p.item] = p.reorderMax;
  }
  return { min, max };
}

export default function Page() {
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [importedDates, setImportedDates] = useState<string[]>([]);
  const [stage, setStage] = useState<Stage>("idle");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [snapshotDate, setSnapshotDate] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [classified, setClassified] = useState<ClassifiedItem[] | null>(null);
  const [allSnapshots, setAllSnapshots] = useState<SnapshotRow[]>([]);
  const [activeDate, setActiveDate] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [itemMeta, setItemMeta] = useState<Map<string, ItemMeta>>(new Map());
  const [dragOver, setDragOver] = useState(false);
  const [booting, setBooting] = useState(true);
  const [loadPct, setLoadPct] = useState(0);

  const loadDb = useCallback(async () => {
    try {
      const [v, d] = await Promise.all([fetchVendors(), fetchImportedDates()]);
      setVendors(v);
      setImportedDates(d);
      // Products and item flags are optional (their tables may not exist yet).
      let prods: ProductRow[] = [];
      try { prods = await fetchProducts(); setProducts(prods); } catch { /* pricing not set up yet */ }
      let meta = new Map<string, ItemMeta>();
      try { meta = new Map((await fetchItemFlags()).map((f) => [f.item, { status: f.status, note: f.note, tags: f.tags, group: f.group }])); setItemMeta(meta); } catch { /* flags not set up yet */ }
      const hidden = [...meta.entries()].filter(([, m]) => isHiddenStatus(m.status)).map(([i]) => i);
      if (d.length) { setActiveDate(d[d.length - 1]); await runClassify(d[d.length - 1], v, hidden, reorderOverrides(prods)); }
    } catch (e: any) {
      setError("Could not connect to the database. Check that Supabase is set up (see SETUP.md). Details: " + e.message);
    }
  }, []);

  useEffect(() => { loadDb().finally(() => setBooting(false)); }, [loadDb]);

  // Re-run classification from snapshots already in memory (no network) — used
  // when only the selected date (or hidden-item flags) change.
  function classifyFrom(snaps: SnapshotRow[], date: string, vendorList: VendorRow[], hidden?: string[], overrides?: { min: Record<string, number>; max: Record<string, number> }) {
    const excluded = vendorList.filter((v) => v.excluded).map((v) => v.name);
    const leadMap: Record<string, number> = {};
    vendorList.forEach((v) => (leadMap[v.name] = v.lead_days));
    const hiddenItems = hidden ?? [...itemMeta.entries()].filter(([, m]) => isHiddenStatus(m.status)).map(([i]) => i);
    const ov = overrides ?? reorderOverrides(products);
    setClassified(classify(snaps, date, { excludedVendors: excluded, leadDaysByVendor: leadMap, defaultLeadDays: 14, hiddenItems, reorderMinByItem: ov.min, reorderMaxByItem: ov.max }));
  }

  // Fetch all snapshots, then classify — used on load and after upload/delete.
  async function runClassify(date: string, vendorList: VendorRow[], hidden?: string[], overrides?: { min: Record<string, number>; max: Record<string, number> }) {
    const snaps = (await fetchAllSnapshots((done, total) => setLoadPct(total ? Math.round((done / total) * 100) : 0))) as SnapshotRow[];
    setAllSnapshots(snaps);
    classifyFrom(snaps, date, vendorList, hidden, overrides);
  }

  async function handleSaveMeta(item: string, meta: ItemMeta) {
    const next = new Map(itemMeta);
    if (!meta.status && !meta.note.trim() && !meta.tags.trim() && !meta.group.trim()) next.delete(item);
    else next.set(item, { status: meta.status, note: meta.note.trim(), tags: meta.tags.trim(), group: meta.group.trim() });
    setItemMeta(next);
    const hidden = [...next.entries()].filter(([, m]) => isHiddenStatus(m.status)).map(([i]) => i);
    classifyFrom(allSnapshots, activeDate, vendors, hidden);
    try { await saveItemMeta(item, meta); }
    catch (e: any) { setError("Couldn't save that change — is the item_flags table set up in Supabase? Details: " + e.message); }
  }

  const excludedNames = useMemo(() => vendors.filter((v) => v.excluded).map((v) => v.name), [vendors]);
  const productMap = useMemo(() => {
    const m = new Map<string, ProductRow>();
    products.forEach((p) => m.set(p.item, p));
    return m;
  }, [products]);
  // Per-period item-level sales between each pair of consecutive snapshots, so
  // the Revenue tab can aggregate over any timeframe (chart, totals, top sellers).
  const periodSales = useMemo<Period[]>(() => {
    const out: Period[] = [];
    for (let i = 1; i < importedDates.length; i++) {
      const ch = inventoryChanges(allSnapshots, importedDates[i], importedDates[i - 1], excludedNames);
      const sold: SoldItem[] = [];
      let restockCost = 0;
      for (const c of ch) {
        const p = productMap.get(c.item);
        const price = p?.price || 0, cost = p?.cost || 0;
        if (c.delta < 0) {
          const units = -c.delta;
          sold.push({ item: c.item, vendor: c.vendor, units, revenue: units * price, profit: units * (price - cost) });
        } else if (c.delta > 0) {
          restockCost += c.delta * cost;
        }
      }
      out.push({ date: importedDates[i], sold, restockCost });
    }
    return out;
  }, [allSnapshots, importedDates, excludedNames, productMap]);
  const catalogueItems = useMemo(() => {
    const seen = new Map<string, string>();
    allSnapshots.forEach((s) => { if (s.item && !seen.has(s.item)) seen.set(s.item, s.vendor); });
    return Array.from(seen.entries()).map(([item, vendor]) => ({ item, vendor })).sort((a, b) => a.item.localeCompare(b.item));
  }, [allSnapshots]);

  async function handleDeleteSnapshot(date: string) {
    setError("");
    try {
      await deleteSnapshot(date);
      const d = await fetchImportedDates();
      setImportedDates(d);
      if (d.length) { const nd = d[d.length - 1]; setActiveDate(nd); await runClassify(nd, vendors); }
      else { setActiveDate(""); setClassified(null); setAllSnapshots([]); }
    } catch (e: any) {
      setError("Could not delete that snapshot: " + e.message);
    }
  }

  async function saveProduct(item: string, cost: number, price: number, reorderMin: number | null = null, reorderMax: number | null = null) {
    const next = products.filter((p) => p.item !== item).concat([{ item, cost, price, reorderMin, reorderMax, updated_at: new Date().toISOString() }]);
    setProducts(next);
    // Reorder min/max affect the reorder list, so re-run classification.
    classifyFrom(allSnapshots, activeDate, vendors, undefined, reorderOverrides(next));
    try { await upsertProduct(item, cost, price, reorderMin, reorderMax); }
    catch (e: any) { setError("Couldn't save that change: " + e.message); }
  }

  // Save just the reorder min/max for an item, preserving its existing cost/price.
  async function saveReorder(item: string, reorderMin: number | null, reorderMax: number | null) {
    const p = products.find((x) => x.item === item);
    await saveProduct(item, p?.cost ?? 0, p?.price ?? 0, reorderMin, reorderMax);
  }

  // The reorder minimum as it arrived in the latest upload, shown as a hint in the editor.
  const uploadedMin = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allSnapshots) if (s.snapshot_date === activeDate && s.reorder_min != null) m.set(s.item, s.reorder_min);
    return m;
  }, [allSnapshots, activeDate]);

  // Bulk-load cost/price from a pricing export (Avg Cost + Sales Price columns).
  async function importPricing(file: File): Promise<number> {
    const rows = parsePricingCSV(await file.text());
    if (rows.length) {
      await upsertProducts(rows);
      setProducts(await fetchProducts());
    }
    return rows.length;
  }

  async function handleFile(file: File) {
    setError(""); setStage("parsing"); setFileName(file.name);
    try {
      let result: ParseResult;
      if (file.name.toLowerCase().endsWith(".csv")) {
        result = parseCSVText(await file.text(), file.name);
      } else if (/\.xlsx?$/.test(file.name.toLowerCase())) {
        result = parseXLSX(await file.arrayBuffer(), file.name);
      } else {
        throw new Error("Please upload a .csv or .xlsx file (exported from QuickBooks).");
      }
      setParseResult(result);
      setSnapshotDate(result.detectedDate || todayStr());
      setStage("review");
    } catch (e: any) {
      setError(e.message); setStage("idle");
    }
  }

  async function confirmSave() {
    if (!parseResult) return;
    if (!snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      setError("Please set a valid snapshot date (YYYY-MM-DD)."); return;
    }
    setStage("saving"); setError("");
    try {
      // Auto-add any unmatched vendors so their rows aren't lost next time.
      for (const u of parseResult.unmatchedVendors) {
        try { await addVendor(u.raw, 14, false); } catch {}
      }
      await insertSnapshot(snapshotDate, parseResult.rows, fileName);
      await loadDb();
      setActiveDate(snapshotDate);
      const v = await fetchVendors();
      await runClassify(snapshotDate, v);
      setStage("done");
    } catch (e: any) {
      setError("Save failed: " + e.message); setStage("review");
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  };

  const tierCounts = (t: Tier) => classified?.filter((i) => i.tier === t).length ?? 0;

  if (booting) {
    return (
      <PasswordGate>
        <BootScreen pct={loadPct} />
      </PasswordGate>
    );
  }

  return (
    <PasswordGate>
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0, color: "#1a202c" }}>
          Inventory Reorder Tool
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setShowPricing(false); setShowSettings(!showSettings); }} style={btnGhost}>
            {showSettings ? "Close settings" : "Vendor settings"}
          </button>
          <button onClick={() => { setShowSettings(false); setShowPricing(!showPricing); }} style={btnGhost}>
            {showPricing ? "Close pricing" : "Product pricing"}
          </button>
        </div>
      </div>
      <div style={{ height: 2, background: ACCENT, borderRadius: 2, margin: "10px 0 0", maxWidth: 160 }} />
      <p style={{ color: "#555555", marginTop: 10 }}>
        Export your inventory from QuickBooks as CSV or Excel, drop it below, and get a sorted reorder list.
      </p>

      {error && <div style={errBox}>{error}</div>}

      {showSettings && <VendorSettings vendors={vendors} onChange={loadDb} />}
      {showPricing && <ProductPricing items={catalogueItems} productMap={productMap} uploadedMin={uploadedMin} onSave={saveProduct} onImport={importPricing} />}

      {/* Upload zone */}
      {(stage === "idle" || stage === "parsing") && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{ ...dropZone, borderColor: dragOver ? ACCENT : "#cbd5e0", background: dragOver ? "#e6f0fa" : "#ffffff" }}
        >
          {stage === "parsing" ? (
            <p>Reading {fileName}…</p>
          ) : (
            <>
              <p style={{ fontSize: 16, margin: 0 }}>Drag a CSV or Excel file here</p>
              <p style={{ color: "#777777", margin: "8px 0 16px" }}>or</p>
              <label style={btnPrimary}>
                Choose file
                <input type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }}
                  onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
              </label>
            </>
          )}
        </div>
      )}

      {/* Review before save */}
      {stage === "review" && parseResult && (
        <div style={card}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Review before saving</h2>
          <p><strong>{parseResult.rows.length}</strong> items read from <strong>{fileName}</strong>.</p>
          {parseResult.skipped > 0 && (
            <p style={{ color: "#a0670a" }}>{parseResult.skipped} rows were skipped (no readable quantity).</p>
          )}
          {parseResult.unmatchedVendors.length > 0 && (
            <div style={warnBox}>
              <strong>New vendors found</strong> — these aren&apos;t in your vendor list yet. They&apos;ll be added automatically so nothing is lost:
              <ul style={{ margin: "8px 0 0" }}>
                {parseResult.unmatchedVendors.map((u) => (
                  <li key={u.raw}>{u.raw} ({u.count} items)</li>
                ))}
              </ul>
            </div>
          )}
          {importedDates.includes(snapshotDate) && (
            <div style={warnBox}>This date ({snapshotDate}) was already imported. Saving will replace it with this file.</div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <label>Snapshot date:</label>
            <input type="date" value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)} style={input} />
            {parseResult.detectedDate && <span style={{ color: "#777777", fontSize: 13 }}>(auto-detected from file)</span>}
          </div>
          <p style={{ color: "#a0670a", fontSize: 13, margin: "8px 0 0" }}>
            Set this to the day the inventory was actually counted — not today — so past reports build the history correctly. Re-using a date replaces what&apos;s already saved for it.
          </p>
          <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
            <button onClick={confirmSave} style={btnPrimary}>Save & analyze</button>
            <button onClick={() => { setStage("idle"); setParseResult(null); }} style={btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {stage === "saving" && <div style={card}>Saving and analyzing…</div>}

      {/* Dashboard */}
      {classified && stage !== "review" && stage !== "saving" && (
        <Dashboard
          classified={classified}
          productMap={productMap}
          periodSales={periodSales}
          catalogue={catalogueItems}
          itemMeta={itemMeta}
          onSaveMeta={handleSaveMeta}
          uploadedMin={uploadedMin}
          onSaveReorder={saveReorder}
          activeDate={activeDate}
          importedDates={importedDates}
          onPickDate={(d) => { setActiveDate(d); classifyFrom(allSnapshots, d, vendors); }}
          tierCounts={tierCounts}
          onExport={() => exportSortedPdf(classified, activeDate)}
          onNewUpload={() => { setStage("idle"); setParseResult(null); }}
          onDeleteSnapshot={handleDeleteSnapshot}
        />
      )}

      {!classified && stage === "idle" && !error && (
        <p style={{ color: "#777777", marginTop: 24 }}>No inventory uploaded yet. Drop your first file above to begin.</p>
      )}

      <footer style={{ textAlign: "center", marginTop: 56, paddingTop: 16, borderTop: "1px solid #f0f0f0" }}>
        <span aria-hidden="true" style={{ color: "#bbbbbb", fontSize: 11, fontStyle: "italic", letterSpacing: 1 }}>
          ♥ love u mommy ♥
        </span>
      </footer>
    </main>
    </PasswordGate>
  );
}

// Simple shared-password gate. Note: this is a convenience lock for the UI — the
// real data protection is Supabase row-level security on the database side.
function BootScreen({ pct }: { pct: number }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 340, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px", color: "#1a202c" }}>Inventory Reorder Tool</h1>
        <p style={{ color: "#555555", fontSize: 14, marginTop: 0 }}>We are getting things ready for you…</p>
        <div style={{ background: "#f7fafc", borderRadius: 999, height: 8, overflow: "hidden", border: "1px solid #e2e8f0" }}>
          <div style={{ width: `${Math.max(6, pct)}%`, background: ACCENT, height: "100%", borderRadius: 999, transition: "width .25s ease" }} />
        </div>
        <p style={{ color: "#888888", fontSize: 12, marginTop: 8 }}>{pct > 0 ? `${pct}%` : "Connecting…"}</p>
      </div>
    </div>
  );
}

function PasswordGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);

  useEffect(() => {
    setUnlocked(localStorage.getItem("ir_unlocked") === "yes");
    setReady(true);
  }, []);

  if (!ready) return null;
  if (unlocked) return <>{children}</>;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw === "1287") { localStorage.setItem("ir_unlocked", "yes"); setUnlocked(true); }
    else { setErr(true); setPw(""); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <form onSubmit={submit} style={{ ...card, marginTop: 0, width: "100%", maxWidth: 340, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px", color: "#1a202c" }}>Inventory Reorder Tool</h1>
        <p style={{ color: "#555555", fontSize: 14, marginTop: 0 }}>Enter the password to continue.</p>
        <input
          type="password" autoFocus value={pw}
          onChange={(e) => { setPw(e.target.value); setErr(false); }}
          placeholder="Password"
          style={{ ...input, width: "100%", textAlign: "center", fontSize: 16, padding: "10px 12px", boxSizing: "border-box" }}
        />
        {err && <p style={{ color: "#9b1c1c", fontSize: 13, margin: "10px 0 0" }}>Incorrect password.</p>}
        <button type="submit" style={{ ...btnPrimary, width: "100%", marginTop: 14 }}>Unlock</button>
      </form>
    </div>
  );
}

interface DashboardProps {
  classified: ClassifiedItem[];
  productMap: Map<string, ProductRow>;
  periodSales: Period[];
  catalogue: { item: string; vendor: string }[];
  itemMeta: Map<string, ItemMeta>;
  onSaveMeta: (item: string, meta: ItemMeta) => void;
  uploadedMin: Map<string, number>;
  onSaveReorder: (item: string, min: number | null, max: number | null) => void;
  activeDate: string;
  importedDates: string[];
  onPickDate: (d: string) => void | Promise<void>;
  tierCounts: (t: Tier) => number;
  onExport: () => void;
  onNewUpload: () => void;
  onDeleteSnapshot: (date: string) => void | Promise<void>;
}

type View = "list" | "flagged" | "revenue" | "compare";

function Dashboard({ classified, productMap, periodSales, catalogue, itemMeta, onSaveMeta, uploadedMin, onSaveReorder, activeDate, importedDates, onPickDate, tierCounts, onExport, onNewUpload, onDeleteSnapshot }: DashboardProps) {
  const tiers: Tier[] = ["order_now", "order_soon", "chronic_low", "already_ordered"];
  const [openTier, setOpenTier] = useState<Tier | null>("order_now");
  const [view, setView] = useState<View>("list");
  const [listMode, setListMode] = useState<"priority" | "vendor">("priority");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  const itemTags = (item: string) => (itemMeta.get(item)?.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const i of classified) itemTags(i.item).forEach((t) => set.add(t));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [classified, itemMeta]);
  const toggleTag = (t: string) => setActiveTags((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const passesTags = (item: string) => activeTags.size === 0 || itemTags(item).some((tag) => activeTags.has(tag));
  const tierItems = (t: Tier) => classified.filter((i) => i.tier === t && passesTags(i.item));
  // Everything that needs attention (all tiers except "ok"), for the by-vendor view.
  const vendorItems = classified.filter((i) => i.tier !== "ok" && passesTags(i.item));

  // "In cart" checkboxes — persisted locally so progress survives refresh/tab switches.
  const [cart, setCart] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { const raw = localStorage.getItem("ir_cart"); if (raw) setCart(new Set(JSON.parse(raw))); } catch {}
  }, []);
  const saveCart = (next: Set<string>) => {
    try { localStorage.setItem("ir_cart", JSON.stringify([...next])); } catch {}
    setCart(next);
  };
  const toggleCart = (key: string) => {
    const next = new Set(cart);
    if (next.has(key)) next.delete(key); else next.add(key);
    saveCart(next);
  };
  const clearCart = (keys: string[]) => {
    const next = new Set(cart);
    keys.forEach((k) => next.delete(k));
    saveCart(next);
  };

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <SnapshotCalendar importedDates={importedDates} activeDate={activeDate} onPick={(d) => onPickDate(d)} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={onExport} style={btnPrimary}>Download PDF</button>
          <button onClick={onNewUpload} style={btnGhost}>Upload new file</button>
          {activeDate && (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{ ...btnGhost, color: "#9b1c1c", borderColor: "#f5c6c6" }}
            >
              Delete snapshot
            </button>
          )}
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete this snapshot?"
          confirmLabel="Yes, I'm sure"
          cancelLabel="No, go back"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); onDeleteSnapshot(activeDate); }}
        >
          <p style={{ margin: "0 0 10px" }}>
            You&apos;re about to permanently remove the inventory uploaded for <strong style={{ color: "#1a202c" }}>{activeDate}</strong>.
          </p>
          <p style={{ margin: 0 }}>
            This is worth a careful look first: the <strong>Revenue</strong> and <strong>Compare items</strong> tabs work by comparing days against each other — so removing this day can shift the sales and reorder numbers shown elsewhere. If you re-upload the same file later, the figures come back.
          </p>
        </ConfirmModal>
      )}

      {/* View tabs */}
      <div style={{ display: "flex", gap: 4, marginTop: 20, borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        {([["list", "Reorder list"], ["flagged", "Flagged"], ["revenue", "Revenue"], ["compare", "Compare items"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              background: "none", border: "none", cursor: "pointer", fontSize: 15,
              padding: "10px 16px", marginBottom: -1,
              color: view === key ? ACCENT : "#555555",
              fontWeight: view === key ? 600 : 400,
              borderBottom: view === key ? `2px solid ${ACCENT}` : "2px solid transparent",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "list" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginTop: 20 }}>
            {tiers.map((t) => (
              <div key={t} onClick={() => setOpenTier(t)} style={{ ...statCard, borderTop: `4px solid ${TIER_META[t].color}`, cursor: "pointer", opacity: openTier === t ? 1 : 0.85 }}>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{tierCounts(t)}</div>
                <div style={{ color: "#555555", fontSize: 14 }}>{TIER_META[t].label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 16, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#888888", marginRight: 4 }}>View:</span>
            {([["priority", "By priority"], ["vendor", "By vendor"]] as const).map(([m, label]) => (
              <button key={m} onClick={() => setListMode(m)}
                style={{ fontSize: 13, padding: "5px 12px", borderRadius: 6, cursor: "pointer", border: `1px solid ${listMode === m ? ACCENT : "#cbd5e0"}`, background: listMode === m ? "rgba(43,108,176,.12)" : "transparent", color: listMode === m ? "#1a4d8c" : "#555555" }}>
                {label}
              </button>
            ))}
          </div>
          {allTags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 12 }}>
              <span style={{ fontSize: 13, color: "#888888" }}>Filter by tag:</span>
              {allTags.map((t) => {
                const on = activeTags.has(t);
                return (
                  <button key={t} onClick={() => toggleTag(t)}
                    style={{ fontSize: 12, padding: "3px 11px", borderRadius: 999, cursor: "pointer", border: `1px solid ${on ? ACCENT : "#cbd5e0"}`, background: on ? "rgba(43,108,176,.12)" : "transparent", color: on ? "#1a4d8c" : "#555555" }}>
                    {t}
                  </button>
                );
              })}
              {activeTags.size > 0 && <button onClick={() => setActiveTags(new Set())} style={{ ...btnGhost, padding: "3px 11px", fontSize: 12 }}>Clear</button>}
            </div>
          )}
          {listMode === "priority"
            ? (openTier && <TierTable items={tierItems(openTier)} tier={openTier} cart={cart} onToggle={toggleCart} onClear={clearCart} itemMeta={itemMeta} onSaveMeta={onSaveMeta} productMap={productMap} uploadedMin={uploadedMin} onSaveReorder={onSaveReorder} />)
            : <VendorView items={vendorItems} cart={cart} onToggle={toggleCart} onClear={clearCart} itemMeta={itemMeta} onSaveMeta={onSaveMeta} productMap={productMap} uploadedMin={uploadedMin} onSaveReorder={onSaveReorder} />}
        </>
      )}
      {view === "flagged" && <FlaggedTab itemMeta={itemMeta} catalogue={catalogue} onSaveMeta={onSaveMeta} productMap={productMap} uploadedMin={uploadedMin} onSaveReorder={onSaveReorder} />}
      {view === "revenue" && <RevenueTab classified={classified} productMap={productMap} periodSales={periodSales} />}
      {view === "compare" && <CompareItems periodSales={periodSales} catalogue={catalogue} itemMeta={itemMeta} onSaveMeta={onSaveMeta} />}
    </div>
  );
}

const FLAG_LABELS: Record<string, string> = { discontinued: "Discontinued", one_time: "One-time buy" };

// Per-row ⋯ editor: status, note, custom tags, and reorder min/max.
function RowMenu({ item, meta, onSave, reorder, onSaveReorder }: {
  item: string;
  meta?: ItemMeta;
  onSave: (item: string, meta: ItemMeta) => void;
  reorder?: { min: number | null; max: number | null; uploadedMin?: number };
  onSaveReorder?: (item: string, min: number | null, max: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [minStr, setMinStr] = useState("");
  const [maxStr, setMaxStr] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  const openEditor = () => {
    setStatus(meta?.status || ""); setNote(meta?.note || ""); setTags(meta?.tags || "");
    setMinStr(reorder?.min != null ? String(reorder.min) : ""); setMaxStr(reorder?.max != null ? String(reorder.max) : "");
    // Position relative to the screen so the menu is never clipped by a table's
    // scroll box; flip above the button when there isn't room below.
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const W = 270;
      const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
      const p: React.CSSProperties = { position: "fixed", left, width: W, zIndex: 41 };
      if (window.innerHeight - r.bottom < 360) p.bottom = window.innerHeight - r.top + 6;
      else p.top = r.bottom + 6;
      setPos(p);
    }
    setOpen(true);
  };
  const save = () => {
    onSave(item, { status, note, tags, group: meta?.group || "" });
    if (onSaveReorder) {
      const min = minStr.trim() === "" ? null : (parseInt(minStr, 10) || 0);
      const max = maxStr.trim() === "" ? null : (parseInt(maxStr, 10) || 0);
      onSaveReorder(item, min, max);
    }
    setOpen(false);
  };

  const statusBtn = (val: string, label: string): React.CSSProperties => ({
    flex: 1, padding: "6px 4px", fontSize: 12, borderRadius: 6, cursor: "pointer",
    border: `1px solid ${status === val ? ACCENT : "#cbd5e0"}`,
    background: status === val ? "rgba(43,108,176,.12)" : "transparent",
    color: status === val ? "#1a4d8c" : "#555555",
  });

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button ref={btnRef} onClick={openEditor} aria-label={`Notes and tags for ${item}`}
        style={{ background: "none", border: "none", color: (meta?.note || meta?.tags) ? ACCENT : "#888888", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>⋯</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ ...pos, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,.18)", textAlign: "left", maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ fontSize: 11, color: "#888888", marginBottom: 5 }}>Status</div>
            <div style={{ display: "flex", gap: 5 }}>
              <button style={statusBtn("", "Active")} onClick={() => setStatus("")}>Active</button>
              <button style={statusBtn("discontinued", "Discontinued")} onClick={() => setStatus("discontinued")}>Discontinued</button>
              <button style={statusBtn("one_time", "One-time")} onClick={() => setStatus("one_time")}>One-time</button>
            </div>
            <div style={{ fontSize: 11, color: "#888888", margin: "10px 0 4px" }}>Note (why / how to order)</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              placeholder="e.g. Order 2 — rep discounts at 2. Ask Dr. before restocking."
              style={{ ...input, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }} />
            <div style={{ fontSize: 11, color: "#888888", margin: "10px 0 4px" }}>Tags (comma-separated)</div>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="seasonal, special order"
              style={{ ...input, width: "100%", boxSizing: "border-box" }} />
            {onSaveReorder && (
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#888888", marginBottom: 4 }}>Reorder min</div>
                  <input type="number" min={0} step={1} value={minStr} onChange={(e) => setMinStr(e.target.value)}
                    placeholder={reorder?.uploadedMin != null ? String(reorder.uploadedMin) : ""}
                    style={{ ...input, width: "100%", boxSizing: "border-box" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#888888", marginBottom: 4 }}>Max (order up to)</div>
                  <input type="number" min={0} step={1} value={maxStr} onChange={(e) => setMaxStr(e.target.value)}
                    style={{ ...input, width: "100%", boxSizing: "border-box" }} />
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={save} style={{ ...btnPrimary, flex: 1, padding: "7px 0" }}>Save</button>
              <button onClick={() => setOpen(false)} style={{ ...btnGhost, padding: "7px 12px" }}>Cancel</button>
            </div>
            {status === "discontinued" || status === "one_time"
              ? <p style={{ color: "#888888", fontSize: 11, margin: "8px 0 0" }}>This item will be hidden from the reorder lists.</p>
              : null}
          </div>
        </>
      )}
    </div>
  );
}

// Dedicated tab listing every flagged item (discontinued, one-time, or just
// annotated with a note/tags), with inline editing and clearing.
function FlaggedTab({ itemMeta, catalogue, onSaveMeta, productMap, uploadedMin, onSaveReorder }: {
  itemMeta: Map<string, ItemMeta>;
  catalogue: { item: string; vendor: string }[];
  onSaveMeta: (item: string, meta: ItemMeta) => void;
  productMap: Map<string, ProductRow>;
  uploadedMin: Map<string, number>;
  onSaveReorder: (item: string, min: number | null, max: number | null) => void;
}) {
  const vendorOf = useMemo(() => new Map(catalogue.map((c) => [c.item, c.vendor])), [catalogue]);
  const rows = useMemo(() =>
    Array.from(itemMeta.entries())
      .filter(([, m]) => m.status || m.note || m.tags)
      .map(([item, m]) => ({ item, vendor: vendorOf.get(item) || "", ...m }))
      .sort((a, b) => a.item.localeCompare(b.item)),
    [itemMeta, vendorOf]);

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ ...card, marginTop: 0 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Flagged items ({rows.length})</h3>
        <p style={{ color: "#777777", fontSize: 13, marginTop: 0 }}>
          Everything you&apos;ve marked or annotated. Discontinued and one-time items are hidden from the reorder lists; notes and tags also show on the list itself.
        </p>
        {rows.length === 0 ? (
          <p style={{ color: "#888888", fontSize: 14, marginBottom: 0 }}>No flagged items yet. Use the ⋯ menu on any reorder-list row to add a note, tags, or mark it discontinued.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                <th style={th}>Item</th>
                <th style={th}>Status</th>
                <th style={th}>Tags</th>
                <th style={th}>Note</th>
                <th style={{ ...th, width: 90 }}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const tagList = (r.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
                  return (
                    <tr key={r.item} style={{ borderBottom: "1px solid #f0f0f0" }}>
                      <td style={td}>{r.item}<div style={{ color: "#888888", fontSize: 12 }}>{r.vendor}</div></td>
                      <td style={{ ...td, color: r.status ? "#92591a" : "#888888" }}>{r.status ? (FLAG_LABELS[r.status] || r.status) : "Active"}</td>
                      <td style={td}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {tagList.map((t) => <span key={t} style={{ background: "#e6f0fa", color: "#2b6cb0", fontSize: 11, padding: "1px 7px", borderRadius: 999 }}>{t}</span>)}
                        </div>
                      </td>
                      <td style={{ ...td, color: "#92591a", fontSize: 13, fontStyle: r.note ? "italic" : "normal" }}>{r.note || "—"}</td>
                      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                        <RowMenu item={r.item} meta={r} onSave={onSaveMeta}
                          reorder={{ min: productMap.get(r.item)?.reorderMin ?? null, max: productMap.get(r.item)?.reorderMax ?? null, uploadedMin: uploadedMin.get(r.item) }}
                          onSaveReorder={onSaveReorder} />
                        <button onClick={() => onSaveMeta(r.item, { status: "", note: "", tags: "", group: r.group || "" })} style={{ ...btnGhost, padding: "4px 10px", fontSize: 13, marginLeft: 4 }}>Clear</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const cartKey = (i: { item: string; vendor: string }) => i.item + "||" + i.vendor;

function TierTable({ items, tier, cart, onToggle, onClear, itemMeta, onSaveMeta, productMap, uploadedMin, onSaveReorder }: {
  items: ClassifiedItem[];
  tier: Tier;
  cart: Set<string>;
  onToggle: (key: string) => void;
  onClear: (keys: string[]) => void;
  itemMeta: Map<string, ItemMeta>;
  onSaveMeta: (item: string, meta: ItemMeta) => void;
  productMap: Map<string, ProductRow>;
  uploadedMin: Map<string, number>;
  onSaveReorder: (item: string, min: number | null, max: number | null) => void;
}) {
  const sorted = [...items].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.item.localeCompare(b.item, undefined, { sensitivity: "base", numeric: true }));
  const checkedHere = sorted.filter((i) => cart.has(cartKey(i))).map(cartKey);
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, color: TIER_META[tier].color }}>{TIER_META[tier].label} — {items.length} items</h3>
        {checkedHere.length > 0 && (
          <button onClick={() => onClear(checkedHere)} style={{ ...btnGhost, padding: "5px 12px", fontSize: 13 }}>
            Clear cart ({checkedHere.length})
          </button>
        )}
      </div>
      {sorted.length === 0 ? <p style={{ color: "#777777" }}>Nothing in this category.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                <th style={th}>Vendor</th><th style={th}>Item</th>
                <th style={{ ...th, textAlign: "center" }}>On hand</th>
                <th style={{ ...th, textAlign: "center" }}>On order</th>
                <th style={{ ...th, textAlign: "center" }}>Trend</th>
                <th style={{ ...th, textAlign: "center" }}>Order qty</th>
                <th style={th}>Note</th>
                <th style={{ ...th, textAlign: "center" }}>In cart</th>
                <th style={{ ...th, width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((i, idx) => {
                const key = cartKey(i);
                const inCart = cart.has(key);
                const m = itemMeta.get(i.item);
                const tagList = (m?.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
                return (
                  <tr key={idx} style={{ borderBottom: "1px solid #f0f0f0", opacity: inCart ? 0.5 : 1 }}>
                    <td style={td}>{i.vendor}</td>
                    <td style={{ ...td, textDecoration: inCart ? "line-through" : "none" }}>
                      <div>{i.item}</div>
                      {tagList.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
                          {tagList.map((t) => (
                            <span key={t} style={{ background: "#e6f0fa", color: "#2b6cb0", fontSize: 11, padding: "1px 7px", borderRadius: 999 }}>{t}</span>
                          ))}
                        </div>
                      )}
                      {m?.note && <div style={{ color: "#92591a", fontSize: 12, fontStyle: "italic", marginTop: 3 }}>{m.note}</div>}
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>{i.qoh}</td>
                    <td style={{ ...td, textAlign: "center" }}>{i.po}</td>
                    <td style={{ ...td, textAlign: "center" }}><Sparkline history={i.history} /></td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 600, color: i.suggestedQty ? ACCENT : "#aaaaaa" }}>{i.suggestedQty ? i.suggestedQty : "—"}</td>
                    <td style={{ ...td, color: "#555555", fontSize: 13 }}>{i.reason}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <input type="checkbox" checked={inCart} onChange={() => onToggle(key)}
                        aria-label={`Mark ${i.item} as added to cart`}
                        style={{ width: 17, height: 17, accentColor: ACCENT, cursor: "pointer" }} />
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <RowMenu item={i.item} meta={m} onSave={onSaveMeta}
                        reorder={{ min: productMap.get(i.item)?.reorderMin ?? null, max: productMap.get(i.item)?.reorderMax ?? null, uploadedMin: uploadedMin.get(i.item) }}
                        onSaveReorder={onSaveReorder} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Reorder list grouped by vendor — one priority-ordered, colour-coded list per
// vendor (instead of separate tier tables), matching how orders are placed.
function VendorView({ items, cart, onToggle, onClear, itemMeta, onSaveMeta, productMap, uploadedMin, onSaveReorder }: {
  items: ClassifiedItem[];
  cart: Set<string>;
  onToggle: (key: string) => void;
  onClear: (keys: string[]) => void;
  itemMeta: Map<string, ItemMeta>;
  onSaveMeta: (item: string, meta: ItemMeta) => void;
  productMap: Map<string, ProductRow>;
  uploadedMin: Map<string, number>;
  onSaveReorder: (item: string, min: number | null, max: number | null) => void;
}) {
  const byVendor = new Map<string, ClassifiedItem[]>();
  for (const i of items) { const a = byVendor.get(i.vendor) || []; a.push(i); byVendor.set(i.vendor, a); }
  const vendors = Array.from(byVendor.entries()).map(([vendor, its]) => ({
    vendor,
    items: [...its].sort((a, b) => TIER_META[a.tier].order - TIER_META[b.tier].order || a.item.localeCompare(b.item, undefined, { sensitivity: "base", numeric: true })),
    minOrder: Math.min(...its.map((i) => TIER_META[i.tier].order)),
  })).sort((a, b) => a.minOrder - b.minOrder || a.vendor.localeCompare(b.vendor));

  if (vendors.length === 0) return <div style={{ ...card, marginTop: 16, color: "#777777" }}>Nothing to reorder right now.</div>;

  return (
    <div>
      {vendors.map((v) => {
        const checkedHere = v.items.filter((i) => cart.has(cartKey(i))).map(cartKey);
        return (
          <div key={v.vendor} style={{ ...card, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{v.vendor} <span style={{ color: "#888888", fontWeight: 400, fontSize: 13 }}>· {v.items.length} to order</span></h3>
              {checkedHere.length > 0 && <button onClick={() => onClear(checkedHere)} style={{ ...btnGhost, padding: "5px 12px", fontSize: 13 }}>Clear cart ({checkedHere.length})</button>}
            </div>
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                  <th style={th}>Priority / item</th>
                  <th style={{ ...th, textAlign: "center" }}>On hand</th>
                  <th style={{ ...th, textAlign: "center" }}>On order</th>
                  <th style={{ ...th, textAlign: "center" }}>Order qty</th>
                  <th style={th}>Note</th>
                  <th style={{ ...th, textAlign: "center" }}>In cart</th>
                  <th style={{ ...th, width: 28 }}></th>
                </tr></thead>
                <tbody>
                  {v.items.map((i, idx) => {
                    const key = cartKey(i);
                    const inCart = cart.has(key);
                    const m = itemMeta.get(i.item);
                    const tagList = (m?.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
                    const color = TIER_META[i.tier].color;
                    return (
                      <tr key={idx} style={{ borderBottom: "1px solid #f0f0f0", opacity: inCart ? 0.5 : 1 }}>
                        <td style={{ ...td, borderLeft: `4px solid ${color}` }}>
                          <span style={{ background: `${color}22`, color, fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 999, marginRight: 6 }}>{TIER_META[i.tier].label}</span>
                          <span style={{ textDecoration: inCart ? "line-through" : "none" }}>{i.item}</span>
                          {tagList.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
                              {tagList.map((t) => <span key={t} style={{ background: "#e6f0fa", color: "#2b6cb0", fontSize: 11, padding: "1px 7px", borderRadius: 999 }}>{t}</span>)}
                            </div>
                          )}
                          {m?.note && <div style={{ color: "#92591a", fontSize: 12, fontStyle: "italic", marginTop: 3 }}>{m.note}</div>}
                        </td>
                        <td style={{ ...td, textAlign: "center" }}>{i.qoh}</td>
                        <td style={{ ...td, textAlign: "center" }}>{i.po}</td>
                        <td style={{ ...td, textAlign: "center", fontWeight: 600, color: i.suggestedQty ? ACCENT : "#aaaaaa" }}>{i.suggestedQty ? i.suggestedQty : "—"}</td>
                        <td style={{ ...td, color: "#555555", fontSize: 13 }}>{i.reason}</td>
                        <td style={{ ...td, textAlign: "center" }}>
                          <input type="checkbox" checked={inCart} onChange={() => onToggle(key)} aria-label={`Mark ${i.item} as added to cart`}
                            style={{ width: 17, height: 17, accentColor: ACCENT, cursor: "pointer" }} />
                        </td>
                        <td style={{ ...td, textAlign: "center" }}>
                          <RowMenu item={i.item} meta={m} onSave={onSaveMeta}
                            reorder={{ min: productMap.get(i.item)?.reorderMin ?? null, max: productMap.get(i.item)?.reorderMax ?? null, uploadedMin: uploadedMin.get(i.item) }}
                            onSaveReorder={onSaveReorder} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={{ ...statCard, background: "#f7fafc" }}>
      <div style={{ color: "#555555", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent || "#1a202c" }}>{value}</div>
      <div style={{ color: "#888888", fontSize: 12 }}>{sub}</div>
    </div>
  );
}

// Tiny per-item trend line for table cells.
function Sparkline({ history }: { history: { qoh: number }[] }) {
  if (history.length < 2) return <span style={{ color: "#bbbbbb", fontSize: 12 }}>—</span>;
  const W = 80, H = 20;
  const vals = history.map((h) => h.qoh);
  const max = Math.max(1, ...vals), min = Math.min(...vals);
  const span = Math.max(1, max - min);
  const x = (i: number) => (i * W) / (vals.length - 1);
  const y = (v: number) => H - 2 - ((v - min) / span) * (H - 4);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const down = vals[vals.length - 1] < vals[0];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={down ? "#E24B4A" : "#1d9e75"} strokeWidth={1.5} />
    </svg>
  );
}

// ---- Revenue tab ----------------------------------------------------------

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

function nDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Inline SVG revenue + profit chart with hover tooltips (no chart library).
function MoneyTrend({ data }: { data: RevPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = 210, padX = 52, padY = 24, bottom = H - padY;
  const maxV = Math.max(1, ...data.map((d) => Math.max(d.revenue, d.profit, 0)));
  const x = (i: number) => padX + (i * (W - padX * 2)) / Math.max(1, data.length - 1);
  const y = (v: number) => bottom - (Math.max(0, v) / maxV) * (bottom - padY);
  const revPts = data.map((d, i) => `${x(i)},${y(d.revenue)}`).join(" ");
  const proPts = data.map((d, i) => `${x(i)},${y(d.profit)}`).join(" ");
  const colW = (W - padX * 2) / Math.max(1, data.length - 1);
  const labelEvery = Math.ceil(data.length / 8);
  const h = hover !== null ? data[hover] : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#555555", margin: "4px 0 6px" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 14, height: 2, background: "#1d9e75", display: "inline-block" }} />Revenue</span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 14, height: 0, borderTop: "2px dashed #2b6cb0", display: "inline-block" }} />Profit</span>
      </div>
      <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Revenue and profit per snapshot over time">
          <line x1={padX} y1={bottom} x2={W - padX} y2={bottom} stroke="#e2e8f0" />
          <text x={4} y={y(maxV) + 4} fontSize={11} fill="#888888">{money(maxV)}</text>
          <text x={4} y={bottom + 4} fontSize={11} fill="#888888">$0</text>
          {h && <line x1={x(hover!)} y1={padY - 6} x2={x(hover!)} y2={bottom} stroke="#bbbbbb" strokeDasharray="3 3" />}
          <polyline points={proPts} fill="none" stroke="#2b6cb0" strokeWidth={2} strokeDasharray="5 4" />
          <polyline points={revPts} fill="none" stroke="#1d9e75" strokeWidth={2.5} />
          {data.map((d, i) => (
            <g key={d.date}>
              <circle cx={x(i)} cy={y(d.profit)} r={hover === i ? 4 : 2.5} fill="#2b6cb0" />
              <circle cx={x(i)} cy={y(d.revenue)} r={hover === i ? 4.5 : 3} fill="#1d9e75" />
              {i % labelEvery === 0 && <text x={x(i)} y={H - 4} fontSize={11} fill="#888888" textAnchor="middle">{d.date.slice(5)}</text>}
              <rect x={x(i) - colW / 2} y={0} width={colW} height={bottom} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          ))}
        </svg>
        {h && (
          <div style={{
            position: "absolute", left: `${(x(hover!) / W) * 100}%`, top: `${(y(h.revenue) / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 10px))", background: "#ffffff", border: "1px solid #cbd5e0",
            borderRadius: 8, padding: "8px 10px", pointerEvents: "none", whiteSpace: "nowrap", fontSize: 12, boxShadow: "0 4px 14px rgba(0,0,0,.18)",
          }}>
            <div style={{ color: "#1a202c", fontWeight: 600, marginBottom: 3 }}>{h.date}</div>
            <div style={{ color: "#1d9e75" }}>Revenue {money(h.revenue)}</div>
            <div style={{ color: "#2b6cb0" }}>Profit {money(h.profit)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const TIMEFRAMES: [string, string][] = [["all", "All time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];

function RevenueTab({ classified, productMap, periodSales }: { classified: ClassifiedItem[]; productMap: Map<string, ProductRow>; periodSales: Period[] }) {
  const [tf, setTf] = useState("all");
  const tfLabel = TIMEFRAMES.find(([v]) => v === tf)?.[1] || "All time";
  const days = tf === "all" ? 0 : parseInt(tf, 10);
  const cutoff = days > 0 ? nDaysAgo(days) : null;
  const periods = cutoff ? periodSales.filter((p) => p.date >= cutoff) : periodSales;

  // Chart series + sales totals for the selected timeframe.
  const series: RevPoint[] = periods.map((p) => ({
    date: p.date,
    revenue: p.sold.reduce((s, x) => s + x.revenue, 0),
    profit: p.sold.reduce((s, x) => s + x.profit, 0),
  }));
  const revenue = series.reduce((s, r) => s + r.revenue, 0);
  const grossProfit = series.reduce((s, r) => s + r.profit, 0);
  const margin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const restockCost = periods.reduce((s, p) => s + p.restockCost, 0);

  // Per-item sales aggregated across every period in the timeframe (drives both
  // Top sellers and the Compare items tool).
  const salesByItem = new Map<string, SoldItem>();
  for (const p of periods) for (const x of p.sold) {
    const k = x.item + "||" + x.vendor;
    const e = salesByItem.get(k) || { item: x.item, vendor: x.vendor, units: 0, revenue: 0, profit: 0 };
    e.units += x.units; e.revenue += x.revenue; e.profit += x.profit;
    salesByItem.set(k, e);
  }
  const topSellers = Array.from(salesByItem.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // Inventory valuation as of the selected snapshot (not timeframe-dependent).
  let invCost = 0, invRetail = 0, missing = 0;
  for (const i of classified) {
    const p = productMap.get(i.item);
    if (!p || (p.price === 0 && p.cost === 0)) missing += 1;
    invCost += i.qoh * (p?.cost || 0);
    invRetail += i.qoh * (p?.price || 0);
  }

  const hasSales = periodSales.length > 0;

  return (
    <div style={{ marginTop: 20 }}>
      <p style={{ color: "#888888", fontSize: 13, margin: "0 0 12px" }}>
        Pricing last updated: {fmtDate(pricingUpdatedAt(productMap))}
      </p>
      {missing > 0 && (
        <div style={warnBox}>
          {missing} of {classified.length} items have no cost/price set. Add them under <strong>Product pricing</strong> (top right) to make these numbers complete.
        </div>
      )}

      {!hasSales ? (
        <div style={{ ...card, marginTop: 12, color: "#555555" }}>Upload a second day&apos;s file to see sales revenue. Inventory value below works with one snapshot.</div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Sales — {tfLabel}</h3>
            <select value={tf} onChange={(e) => setTf(e.target.value)} style={{ ...input, padding: "5px 8px" }}>
              {TIMEFRAMES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 10 }}>
            <Kpi label="Revenue" value={money(revenue)} sub="units sold × price" accent="#1d9e75" />
            <Kpi label="Gross profit" value={money(grossProfit)} sub="revenue − cost of goods" />
            <Kpi label="Margin" value={`${margin.toFixed(1)}%`} sub="profit ÷ revenue" />
            <Kpi label="Restock spend" value={money(restockCost)} sub="cost of stock received" />
          </div>

          <div style={{ ...card, marginTop: 20 }}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>Revenue over time</h3>
            {series.length < 2 ? (
              <p style={{ color: "#777777", fontSize: 14, marginBottom: 0 }}>Not enough data in this range to chart — pick a wider timeframe or upload more snapshots.</p>
            ) : (
              <MoneyTrend data={series} />
            )}
          </div>

          <div style={{ ...card, marginTop: 20 }}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>Top sellers — {tfLabel} <span style={{ color: "#777777", fontWeight: 400, fontSize: 13 }}>— by revenue</span></h3>
            {topSellers.length === 0 ? (
              <p style={{ color: "#777777", fontSize: 14 }}>No sales in this range, or no prices set yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                  <th style={th}>Item</th><th style={th}>Vendor</th>
                  <th style={{ ...th, textAlign: "center" }}>Units sold</th>
                  <th style={{ ...th, textAlign: "right" }}>Revenue</th>
                </tr></thead>
                <tbody>
                  {topSellers.map((s) => (
                    <tr key={s.item + s.vendor} style={{ borderBottom: "1px solid #f0f0f0" }}>
                      <td style={td}>{s.item}</td>
                      <td style={td}>{s.vendor}</td>
                      <td style={{ ...td, textAlign: "center" }}>{s.units}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{money(s.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <p style={{ color: "#555555", fontSize: 14, margin: "20px 0 0" }}>Current inventory value:</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 8 }}>
        <Kpi label="Value at cost" value={money(invCost)} sub="what it cost you" />
        <Kpi label="Retail value" value={money(invRetail)} sub="if it all sells" />
        <Kpi label="Potential profit" value={money(invRetail - invCost)} sub="retail − cost" />
      </div>
    </div>
  );
}

// ---- Compare items --------------------------------------------------------

// Strip trailing flavor/size descriptors to find a product's base name, so
// variants (BLUE/ORANGE, 50MG/100MG, 120ct/240ct) collapse to one group.
function baseName(item: string): string {
  let s = item.replace(/\s+/g, " ").trim();
  const pats = [
    /[\s-]+\d+(\.\d+)?\s?(ct|count|mg|mcg|oz|g|kg|lb|lbs|ml|caps?|tabs?|softgels?|gummies|packets?|paks?|pkts?|servings?)\b\.?$/i,
    /[\s-]+\d+(\.\d+)?$/,
    /[\s-]+[A-Z]{2,}$/,
    /[\s-]+(blue|orange|berry|cherry|grape|lemon|lime|vanilla|chocolate|strawberry|tangerine|mint|raspberry|peach|original|unflavored|natural|citrus)\b\.?$/i,
  ];
  for (let n = 0; n < 6; n++) {
    let changed = false;
    for (const re of pats) {
      const next = s.replace(re, "").replace(/[-\s]+$/, "").trim();
      if (next && next.length >= 3 && next !== s) { s = next; changed = true; }
    }
    if (!changed) break;
  }
  return s;
}

function CompareItems({ periodSales, catalogue, itemMeta, onSaveMeta }: {
  periodSales: Period[];
  catalogue: { item: string; vendor: string }[];
  itemMeta: Map<string, ItemMeta>;
  onSaveMeta: (item: string, meta: ItemMeta) => void;
}) {
  const [tf, setTf] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeGroup, setActiveGroup] = useState<{ base: string; vendor: string } | null>(null);
  const [editMode, setEditMode] = useState(false);
  const keyOf = (c: { item: string; vendor: string }) => c.item + "||" + c.vendor;
  const tfLabel = TIMEFRAMES.find(([v]) => v === tf)?.[1] || "All time";

  // An item belongs to a group by its manual override, else its detected base name.
  const groupLabel = (item: string) => (itemMeta.get(item)?.group || "").trim() || baseName(item);
  // Persist an item into / out of a group (preserving its other flags).
  const setGroup = (item: string, vendor: string, group: string) => {
    const m = itemMeta.get(item);
    onSaveMeta(item, { status: m?.status || "", note: m?.note || "", tags: m?.tags || "", group });
    if (group) setSelected((prev) => (prev.includes(item + "||" + vendor) ? prev : [...prev, item + "||" + vendor]));
  };

  // Sales per item over the selected timeframe (only recomputes on data/timeframe change).
  const sales = useMemo(() => {
    const days = tf === "all" ? 0 : parseInt(tf, 10);
    const cutoff = days > 0 ? nDaysAgo(days) : null;
    const periods = cutoff ? periodSales.filter((p) => p.date >= cutoff) : periodSales;
    const m = new Map<string, SoldItem>();
    for (const p of periods) for (const x of p.sold) {
      const k = x.item + "||" + x.vendor;
      const e = m.get(k) || { item: x.item, vendor: x.vendor, units: 0, revenue: 0, profit: 0 };
      e.units += x.units; e.revenue += x.revenue; e.profit += x.profit;
      m.set(k, e);
    }
    return m;
  }, [periodSales, tf]);

  // Variant-group membership is computed once from the catalogue (the heavy
  // base-name parsing); unit totals for sorting come from the sales map.
  const groupMembers = useMemo(() => {
    const m = new Map<string, { base: string; vendor: string; keys: string[] }>();
    for (const c of catalogue) {
      const base = groupLabel(c.item);
      const gk = c.vendor + "::" + base.toLowerCase();
      const e = m.get(gk) || { base, vendor: c.vendor, keys: [] };
      e.keys.push(keyOf(c));
      m.set(gk, e);
    }
    return Array.from(m.values()).filter((g) => g.keys.length >= 2);
  }, [catalogue, itemMeta]);
  const groups = useMemo(() =>
    groupMembers
      .map((g) => ({ ...g, units: g.keys.reduce((s, k) => s + (sales.get(k)?.units || 0), 0) }))
      .sort((a, b) => b.units - a.units || a.base.localeCompare(b.base)),
    [groupMembers, sales]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? catalogue.filter((c) => c.item.toLowerCase().includes(q) && !selected.includes(keyOf(c)) && (!(activeGroup && editMode) || c.vendor === activeGroup.vendor)).slice(0, 8)
    : [];

  const rows = selected.map((k) => {
    const s = sales.get(k);
    const [item, vendor] = k.split("||");
    return { key: k, item, vendor, units: s?.units || 0, revenue: s?.revenue || 0, profit: s?.profit || 0 };
  }).sort((a, b) => b.units - a.units);
  const maxUnits = Math.max(1, ...rows.map((r) => r.units));
  const winner = rows.length >= 2 && rows[0].units > 0 ? rows[0] : null;
  const runnerUp = winner ? rows[1] : null;

  const add = (c: { item: string; vendor: string }) => {
    if (activeGroup && editMode) setGroup(c.item, c.vendor, activeGroup.base);
    else setSelected((prev) => (prev.length >= 8 || prev.includes(keyOf(c)) ? prev : [...prev, keyOf(c)]));
    setQuery("");
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Compare items <span style={{ color: "#777777", fontWeight: 400, fontSize: 13 }}>— how variants stack up over {tfLabel}</span></h3>
        <select value={tf} onChange={(e) => setTf(e.target.value)} style={{ ...input, padding: "5px 8px" }}>
          {TIMEFRAMES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
      <p style={{ color: "#777777", fontSize: 13, marginTop: 6 }}>Jump to a detected variant group, or search and add items by hand. Inside a group, search to permanently add a variant the system missed.</p>

      <div style={{ ...card, marginTop: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {groups.length > 0 && (
          <select
            value=""
            onChange={(e) => { const g = groups[Number(e.target.value)]; if (g) { setActiveGroup({ base: g.base, vendor: g.vendor }); setEditMode(false); setSelected(g.keys.slice(0, 10)); setQuery(""); } }}
            style={{ ...input, maxWidth: 360 }}
          >
            <option value="" disabled>Jump to a variant group… ({groups.length})</option>
            {groups.map((g, i) => <option key={i} value={i}>{g.base} · {g.vendor} ({g.keys.length})</option>)}
          </select>
        )}
        {activeGroup && (
          <button
            onClick={() => setEditMode((e) => !e)}
            style={editMode ? { ...btnPrimary, padding: "8px 14px" } : { ...btnGhost, padding: "8px 14px" }}
          >
            {editMode ? "Done editing" : "Edit group"}
          </button>
        )}
        <input
          type="text" placeholder={activeGroup && editMode ? `Add a missing variant to “${activeGroup.base}”` : "…or search items to add"} value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...input, flex: 1, minWidth: 180, maxWidth: 360 }}
        />
      </div>
      {activeGroup && (
        <div style={{ marginTop: 8, fontSize: 13, color: "#2b6cb0" }}>
          {editMode
            ? <>Editing <strong>{activeGroup.base}</strong> · {activeGroup.vendor} — search above to add a missing variant; it&apos;s saved to the group permanently.</>
            : <>Viewing group <strong>{activeGroup.base}</strong> · {activeGroup.vendor}. Tap <strong>Edit group</strong> to add a variant the system missed.</>}
          <button onClick={() => { setActiveGroup(null); setEditMode(false); setSelected([]); }} style={{ ...btnGhost, padding: "2px 10px", fontSize: 12, marginLeft: 8 }}>Clear</button>
        </div>
      )}
      {matches.length > 0 && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, marginTop: 6, maxWidth: 360, overflow: "hidden" }}>
          {matches.map((c) => (
            <div key={keyOf(c)} onClick={() => add(c)} style={{ padding: "8px 10px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f0f0f0" }}>
              {c.item} <span style={{ color: "#888888" }}>· {c.vendor}</span>
            </div>
          ))}
        </div>
      )}

      {selected.length === 0 ? (
        <p style={{ color: "#888888", fontSize: 14, marginBottom: 0 }}>No items added yet — search above to start a comparison.</p>
      ) : (
        <>
          {winner && (
            <div style={{ ...statCard, marginTop: 14, borderLeft: `3px solid #1d9e75`, borderRadius: 8 }}>
              Best seller: <strong style={{ color: "#1a202c" }}>{winner.item}</strong> — {winner.units} sold
              {runnerUp && runnerUp.units > 0 && <> vs {runnerUp.units} for {runnerUp.item}{runnerUp.units > 0 ? ` (${(winner.units / runnerUp.units).toFixed(1)}× more)` : ""}</>}
              {runnerUp && runnerUp.units === 0 && <> — the others had no sales this period</>}.
            </div>
          )}
          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                <th style={th}>Item</th>
                <th style={{ ...th, textAlign: "center" }}>Units sold</th>
                <th style={{ ...th, textAlign: "right" }}>Revenue</th>
                <th style={{ ...th, textAlign: "right" }}>Profit</th>
                <th style={{ ...th, width: 24 }}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={td}>
                      <div>{r.item} <span style={{ color: "#888888", fontSize: 12 }}>· {r.vendor}</span></div>
                      <div style={{ background: "#f0f0f0", borderRadius: 3, height: 6, marginTop: 4 }}>
                        <div style={{ width: `${(r.units / maxUnits) * 100}%`, background: ACCENT, height: 6, borderRadius: 3 }} />
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 600 }}>{r.units}</td>
                    <td style={{ ...td, textAlign: "right" }}>{money(r.revenue)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{money(r.profit)}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {activeGroup && editMode && (itemMeta.get(r.item)?.group || "").trim().toLowerCase() === activeGroup.base.toLowerCase() && (
                        <button onClick={() => { setGroup(r.item, r.vendor, ""); setSelected((prev) => prev.filter((k) => k !== r.key)); }}
                          style={{ ...btnGhost, padding: "2px 8px", fontSize: 12, marginRight: 4 }}>Remove from group</button>
                      )}
                      <button onClick={() => setSelected((prev) => prev.filter((k) => k !== r.key))}
                        aria-label={`Remove ${r.item} from comparison`}
                        style={{ background: "none", border: "none", color: "#888888", cursor: "pointer", fontSize: 16 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

// ---- Product pricing editor -----------------------------------------------

type PriceField = "cost" | "price" | "min" | "max";

function ProductPricing({ items, productMap, uploadedMin, onSave, onImport }: {
  items: { item: string; vendor: string }[];
  productMap: Map<string, ProductRow>;
  uploadedMin: Map<string, number>;
  onSave: (item: string, cost: number, price: number, reorderMin: number | null, reorderMax: number | null) => Promise<void>;
  onImport: (file: File) => Promise<number>;
}) {
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [savedItem, setSavedItem] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [importing, setImporting] = useState(false);

  async function handleImport(file: File) {
    setImporting(true); setImportMsg("");
    try {
      const n = await onImport(file);
      setImportMsg(n > 0 ? `Imported pricing for ${n} products.` : "No priced rows found in that file.");
    } catch (e: any) {
      setImportMsg("Import failed: " + e.message);
    } finally {
      setImporting(false);
    }
  }

  const filtered = items.filter((r) => r.item.toLowerCase().includes(filter.toLowerCase()));
  const shown = filtered.slice(0, 200);

  function val(item: string, field: PriceField): string {
    if (edits[item] && edits[item][field] !== undefined) return edits[item][field];
    const p = productMap.get(item);
    if (!p) return "";
    const n = field === "cost" ? p.cost : field === "price" ? p.price : field === "min" ? p.reorderMin : p.reorderMax;
    return n == null || n === 0 ? "" : String(n);
  }
  function onEdit(item: string, field: PriceField, v: string) {
    setEdits((e) => ({ ...e, [item]: { ...(e[item] || {}), [field]: v } }));
  }
  async function commit(item: string) {
    const cost = parseFloat(val(item, "cost")) || 0;
    const price = parseFloat(val(item, "price")) || 0;
    const minStr = val(item, "min").trim(), maxStr = val(item, "max").trim();
    const reorderMin = minStr === "" ? null : (parseInt(minStr, 10) || 0);
    const reorderMax = maxStr === "" ? null : (parseInt(maxStr, 10) || 0);
    await onSave(item, cost, price, reorderMin, reorderMax);
    setSavedItem(item);
    setTimeout(() => setSavedItem((s) => (s === item ? "" : s)), 1200);
  }

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Product pricing & reorder levels</h2>
      <p style={{ color: "#555555", fontSize: 14 }}>Set cost and sales price (these power the Revenue tab), and override the reorder minimum / maximum if the uploaded value is out of date. A minimum drives the &quot;order now&quot; trigger; a maximum sets the suggested &quot;order up to&quot; quantity.</p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12, paddingBottom: 14, borderBottom: "1px solid #e2e8f0" }}>
        <label style={{ ...btnPrimary, opacity: importing ? 0.6 : 1 }}>
          {importing ? "Importing…" : "Import prices from CSV"}
          <input type="file" accept=".csv" style={{ display: "none" }} disabled={importing}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ""; }} />
        </label>
        <span style={{ color: "#777777", fontSize: 13 }}>Use a report with “Avg Cost” and “Sales Price” columns.</span>
        {importMsg && <span style={{ color: importMsg.startsWith("Import failed") ? "#9b1c1c" : "#1d9e75", fontSize: 13 }}>{importMsg}</span>}
        <span style={{ color: "#888888", fontSize: 13, marginLeft: "auto" }}>Pricing last updated: {fmtDate(pricingUpdatedAt(productMap))}</span>
      </div>

      <input
        type="text" placeholder="Search products…" value={filter}
        onChange={(e) => setFilter(e.target.value)} style={{ ...input, width: "100%", maxWidth: 320, marginBottom: 12 }}
      />
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
            <th style={th}>Item</th><th style={th}>Vendor</th>
            <th style={{ ...th, textAlign: "center" }}>Cost ($)</th>
            <th style={{ ...th, textAlign: "center" }}>Price ($)</th>
            <th style={{ ...th, textAlign: "center" }}>Min</th>
            <th style={{ ...th, textAlign: "center" }}>Max</th>
            <th style={{ ...th, width: 20 }}></th>
          </tr></thead>
          <tbody>
            {shown.map((r) => {
              const upMin = uploadedMin.get(r.item);
              return (
              <tr key={r.item} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={td}>{r.item}</td>
                <td style={{ ...td, color: "#777777" }}>{r.vendor}</td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={0} step={0.01} value={val(r.item, "cost")}
                    onChange={(e) => onEdit(r.item, "cost", e.target.value)} onBlur={() => commit(r.item)}
                    style={{ ...input, width: 76 }} />
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={0} step={0.01} value={val(r.item, "price")}
                    onChange={(e) => onEdit(r.item, "price", e.target.value)} onBlur={() => commit(r.item)}
                    style={{ ...input, width: 76 }} />
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={0} step={1} value={val(r.item, "min")}
                    placeholder={upMin != null ? String(upMin) : ""}
                    onChange={(e) => onEdit(r.item, "min", e.target.value)} onBlur={() => commit(r.item)}
                    style={{ ...input, width: 60 }} />
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={0} step={1} value={val(r.item, "max")}
                    onChange={(e) => onEdit(r.item, "max", e.target.value)} onBlur={() => commit(r.item)}
                    style={{ ...input, width: 60 }} />
                </td>
                <td style={{ ...td, color: "#1d9e75" }}>{savedItem === r.item ? "✓" : ""}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > shown.length && (
        <p style={{ color: "#777777", fontSize: 13, marginBottom: 0 }}>Showing first {shown.length} of {filtered.length}. Type in the search box to narrow down.</p>
      )}
      {items.length === 0 && <p style={{ color: "#777777", fontSize: 14 }}>Upload an inventory file first — your products will appear here.</p>}
    </div>
  );
}

// ---- Confirmation modal ----------------------------------------------------

function ConfirmModal({ title, children, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, marginTop: 0, maxWidth: 460, width: "100%" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 10px", color: "#9b1c1c" }}>{title}</h2>
        <div style={{ color: "#444444", fontSize: 14, lineHeight: 1.55 }}>{children}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 22, flexWrap: "wrap" }}>
          <button onClick={onCancel} style={btnGhost}>{cancelLabel}</button>
          <button onClick={onConfirm} style={{ ...btnPrimary, background: "#e2574e", color: "#fff" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Snapshot calendar picker ---------------------------------------------

function SnapshotCalendar({ importedDates, activeDate, onPick }: { importedDates: string[]; activeDate: string; onPick: (d: string) => void }) {
  const have = useMemo(() => new Set(importedDates), [importedDates]);
  const [open, setOpen] = useState(false);
  const base = activeDate || importedDates[importedDates.length - 1] || "";
  const [ym, setYm] = useState(() => {
    if (base) { const [y, m] = base.split("-").map(Number); return { y, m }; }
    const now = new Date(); return { y: now.getFullYear(), m: now.getMonth() + 1 };
  });
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthName = new Date(ym.y, ym.m - 1, 1).toLocaleString("en-US", { month: "long" });
  const daysInMonth = new Date(ym.y, ym.m, 0).getDate();
  const firstDow = new Date(ym.y, ym.m - 1, 1).getDay();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const prevMonth = () => setYm(({ y, m }) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }));
  const nextMonth = () => setYm(({ y, m }) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }));
  const monthUploads = importedDates.filter((d) => d.startsWith(`${ym.y}-${pad(ym.m)}`)).length;

  const dayBtn: React.CSSProperties = { aspectRatio: "1", border: "none", borderRadius: 6, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" };

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10 }}>
      <label style={{ fontSize: 14, color: "#555555" }}>Snapshot:</label>
      <button onClick={() => setOpen((o) => !o)} style={{ ...input, cursor: "pointer", minWidth: 150, textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span>{activeDate || "Pick a date"}</span>
        <span style={{ color: "#888888", fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,.18)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <button onClick={prevMonth} style={{ ...btnGhost, padding: "2px 10px" }}>‹</button>
              <strong style={{ fontSize: 14 }}>{monthName} {ym.y}</strong>
              <button onClick={nextMonth} style={{ ...btnGhost, padding: "2px 10px" }}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, marginBottom: 3 }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div key={i} style={{ textAlign: "center", fontSize: 11, color: "#888888" }}>{d}</div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
              {cells.map((d, i) => {
                if (d === null) return <div key={i} />;
                const ds = `${ym.y}-${pad(ym.m)}-${pad(d)}`;
                const hasUpload = have.has(ds);
                const isActive = ds === activeDate;
                return (
                  <button
                    key={i}
                    disabled={!hasUpload}
                    onClick={() => { onPick(ds); setOpen(false); }}
                    title={hasUpload ? `View ${ds}` : "No report uploaded"}
                    style={{
                      ...dayBtn,
                      cursor: hasUpload ? "pointer" : "default",
                      background: isActive ? ACCENT : hasUpload ? "rgba(43,108,176,.12)" : "transparent",
                      color: isActive ? "#ffffff" : hasUpload ? "#1a4d8c" : "#cccccc",
                      fontWeight: hasUpload ? 600 : 400,
                    }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#888888", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "rgba(43,108,176,.5)", marginRight: 5 }} />has a report</span>
              <span>{monthUploads} this month</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function VendorSettings({ vendors, onChange }: { vendors: VendorRow[]; onChange: () => void }) {
  const [saving, setSaving] = useState("");
  async function toggle(v: VendorRow) { setSaving(v.name); await updateVendor(v.name, { excluded: !v.excluded }); await onChange(); setSaving(""); }
  async function setLead(v: VendorRow, days: number) { setSaving(v.name); await updateVendor(v.name, { lead_days: days }); await onChange(); setSaving(""); }
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Vendor settings</h2>
      <p style={{ color: "#555555", fontSize: 14 }}>Exclude vendors you don&apos;t reorder here, and set how many days each takes to deliver (drives the &quot;order now&quot; timing).</p>
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
            <th style={th}>Vendor</th><th style={{ ...th, textAlign: "center" }}>Excluded</th><th style={{ ...th, textAlign: "center" }}>Lead days</th>
          </tr></thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.name} style={{ borderBottom: "1px solid #f0f0f0", opacity: saving === v.name ? 0.5 : 1 }}>
                <td style={td}>{v.name}</td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="checkbox" checked={v.excluded} onChange={() => toggle(v)} />
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={1} value={v.lead_days} onChange={(e) => setLead(v, parseInt(e.target.value) || 14)} style={{ ...input, width: 64 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Dark interface palette.
const ACCENT = "#2b6cb0";
const dropZone: React.CSSProperties = { border: "2px dashed #cbd5e0", borderRadius: 8, padding: "48px 20px", textAlign: "center", marginTop: 24, transition: "all .15s" };
const card: React.CSSProperties = { background: "#ffffff", borderRadius: 10, padding: 24, marginTop: 24, border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,.06)" };
const statCard: React.CSSProperties = { background: "#f7fafc", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,.06)" };
const btnPrimary: React.CSSProperties = { background: ACCENT, color: "#ffffff", border: "none", borderRadius: 6, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "inline-block" };
const btnGhost: React.CSSProperties = { background: "#f7fafc", color: ACCENT, border: "1px solid #cbd5e0", borderRadius: 6, padding: "9px 16px", fontSize: 14, cursor: "pointer" };
const input: React.CSSProperties = { border: "1px solid #cbd5e0", borderRadius: 6, padding: "7px 10px", fontSize: 14, background: "#ffffff", color: "#1a202c" };
const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, color: "#555555" };
const td: React.CSSProperties = { padding: "8px 10px" };
const errBox: React.CSSProperties = { background: "#fde8e8", color: "#9b1c1c", padding: "12px 16px", borderRadius: 8, marginTop: 16, fontSize: 14, border: "1px solid #f5c6c6" };
const warnBox: React.CSSProperties = { background: "#fef6e7", color: "#92591a", padding: "12px 16px", borderRadius: 8, marginTop: 12, fontSize: 14, border: "1px solid #f0e0b0" };
