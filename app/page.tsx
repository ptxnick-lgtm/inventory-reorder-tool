"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { parseCSVText, parseXLSX, ParseResult } from "@/lib/parser";
import { classify, snapshotTrend, inventoryChanges, ClassifiedItem, SnapshotStat, InventoryChange, TIER_META, Tier, SnapshotRow } from "@/lib/classify";
import {
  fetchVendors, fetchAllSnapshots, insertSnapshot, fetchImportedDates,
  updateVendor, addVendor, fetchProducts, upsertProduct, deleteSnapshot, VendorRow, ProductRow,
} from "@/lib/supabase";
import { exportSortedPdf } from "@/lib/exportPdf";

type Stage = "idle" | "parsing" | "review" | "saving" | "done";

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
  const [dragOver, setDragOver] = useState(false);

  const loadDb = useCallback(async () => {
    try {
      const [v, d] = await Promise.all([fetchVendors(), fetchImportedDates()]);
      setVendors(v);
      setImportedDates(d);
      // Products are optional (the table may not exist yet) — never block on them.
      try { setProducts(await fetchProducts()); } catch { /* pricing not set up yet */ }
      if (d.length) { setActiveDate(d[d.length - 1]); await runClassify(d[d.length - 1], v); }
    } catch (e: any) {
      setError("Could not connect to the database. Check that Supabase is set up (see SETUP.md). Details: " + e.message);
    }
  }, []);

  useEffect(() => { loadDb(); }, [loadDb]);

  async function runClassify(date: string, vendorList: VendorRow[]) {
    const snaps = (await fetchAllSnapshots()) as SnapshotRow[];
    const excluded = vendorList.filter((v) => v.excluded).map((v) => v.name);
    const leadMap: Record<string, number> = {};
    vendorList.forEach((v) => (leadMap[v.name] = v.lead_days));
    const result = classify(snaps, date, { excludedVendors: excluded, leadDaysByVendor: leadMap, defaultLeadDays: 14 });
    setAllSnapshots(snaps);
    setClassified(result);
  }

  const excludedNames = useMemo(() => vendors.filter((v) => v.excluded).map((v) => v.name), [vendors]);
  const trend = useMemo(() => snapshotTrend(allSnapshots, excludedNames), [allSnapshots, excludedNames]);
  const prevDate = useMemo(() => {
    const i = importedDates.indexOf(activeDate);
    return i > 0 ? importedDates[i - 1] : null;
  }, [importedDates, activeDate]);
  const changes = useMemo(
    () => inventoryChanges(allSnapshots, activeDate, prevDate, excludedNames),
    [allSnapshots, activeDate, prevDate, excludedNames]
  );
  const productMap = useMemo(() => {
    const m = new Map<string, ProductRow>();
    products.forEach((p) => m.set(p.item, p));
    return m;
  }, [products]);
  // Revenue earned between each pair of consecutive snapshots (units sold × price).
  const revenueSeries = useMemo(() => {
    const out: { date: string; revenue: number }[] = [];
    for (let i = 1; i < importedDates.length; i++) {
      const ch = inventoryChanges(allSnapshots, importedDates[i], importedDates[i - 1], excludedNames);
      let rev = 0;
      for (const c of ch) if (c.delta < 0) rev += -c.delta * (productMap.get(c.item)?.price || 0);
      out.push({ date: importedDates[i], revenue: rev });
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

  async function saveProduct(item: string, cost: number, price: number) {
    await upsertProduct(item, cost, price);
    setProducts((prev) => {
      const next = prev.filter((p) => p.item !== item);
      next.push({ item, cost, price });
      return next;
    });
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
      setSnapshotDate(result.detectedDate || "");
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

  return (
    <PasswordGate>
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0, color: "#e6e8eb" }}>
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
      <p style={{ color: "#aab2bd", marginTop: 10 }}>
        Export your inventory from QuickBooks as CSV or Excel, drop it below, and get a sorted reorder list.
      </p>

      {error && <div style={errBox}>{error}</div>}

      {showSettings && <VendorSettings vendors={vendors} onChange={loadDb} />}
      {showPricing && <ProductPricing items={catalogueItems} productMap={productMap} onSave={saveProduct} />}

      {/* Upload zone */}
      {(stage === "idle" || stage === "parsing") && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{ ...dropZone, borderColor: dragOver ? ACCENT : "#3a414c", background: dragOver ? "#2a3340" : "#1e232b" }}
        >
          {stage === "parsing" ? (
            <p>Reading {fileName}…</p>
          ) : (
            <>
              <p style={{ fontSize: 16, margin: 0 }}>Drag a CSV or Excel file here</p>
              <p style={{ color: "#9aa3ad", margin: "8px 0 16px" }}>or</p>
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
            {parseResult.detectedDate && <span style={{ color: "#9aa3ad", fontSize: 13 }}>(auto-detected from file)</span>}
          </div>
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
          trend={trend}
          changes={changes}
          productMap={productMap}
          revenueSeries={revenueSeries}
          activeDate={activeDate}
          prevDate={prevDate}
          importedDates={importedDates}
          onPickDate={async (d) => { setActiveDate(d); await runClassify(d, vendors); }}
          tierCounts={tierCounts}
          onExport={() => exportSortedPdf(classified, activeDate)}
          onNewUpload={() => { setStage("idle"); setParseResult(null); }}
          onDeleteSnapshot={handleDeleteSnapshot}
        />
      )}

      {!classified && stage === "idle" && !error && (
        <p style={{ color: "#9aa3ad", marginTop: 24 }}>No inventory uploaded yet. Drop your first file above to begin.</p>
      )}

      <footer style={{ textAlign: "center", marginTop: 56, paddingTop: 16, borderTop: "1px solid #2a2f37" }}>
        <span aria-hidden="true" style={{ color: "#5b6470", fontSize: 11, fontStyle: "italic", letterSpacing: 1 }}>
          ♥ love u mommy ♥
        </span>
      </footer>
    </main>
    </PasswordGate>
  );
}

// Simple shared-password gate. Note: this is a convenience lock for the UI — the
// real data protection is Supabase row-level security on the database side.
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
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px", color: "#e6e8eb" }}>Inventory Reorder Tool</h1>
        <p style={{ color: "#aab2bd", fontSize: 14, marginTop: 0 }}>Enter the password to continue.</p>
        <input
          type="password" autoFocus value={pw}
          onChange={(e) => { setPw(e.target.value); setErr(false); }}
          placeholder="Password"
          style={{ ...input, width: "100%", textAlign: "center", fontSize: 16, padding: "10px 12px", boxSizing: "border-box" }}
        />
        {err && <p style={{ color: "#f0a3a3", fontSize: 13, margin: "10px 0 0" }}>Incorrect password.</p>}
        <button type="submit" style={{ ...btnPrimary, width: "100%", marginTop: 14 }}>Unlock</button>
      </form>
    </div>
  );
}

interface DashboardProps {
  classified: ClassifiedItem[];
  trend: SnapshotStat[];
  changes: InventoryChange[];
  productMap: Map<string, ProductRow>;
  revenueSeries: { date: string; revenue: number }[];
  activeDate: string;
  prevDate: string | null;
  importedDates: string[];
  onPickDate: (d: string) => void | Promise<void>;
  tierCounts: (t: Tier) => number;
  onExport: () => void;
  onNewUpload: () => void;
  onDeleteSnapshot: (date: string) => void | Promise<void>;
}

type View = "list" | "changes" | "insights" | "revenue";

function Dashboard({ classified, trend, changes, productMap, revenueSeries, activeDate, prevDate, importedDates, onPickDate, tierCounts, onExport, onNewUpload, onDeleteSnapshot }: DashboardProps) {
  const tiers: Tier[] = ["order_now", "order_soon", "chronic_low", "already_ordered"];
  const [openTier, setOpenTier] = useState<Tier | null>("order_now");
  const [view, setView] = useState<View>("list");
  const [confirmDelete, setConfirmDelete] = useState(false);
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
              style={{ ...btnGhost, color: "#f0a3a3", borderColor: "#5a2a2a" }}
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
            You&apos;re about to permanently remove the inventory uploaded for <strong style={{ color: "#e6e8eb" }}>{activeDate}</strong>.
          </p>
          <p style={{ margin: 0 }}>
            This is worth a careful look first: the <strong>Insights</strong>, <strong>Daily changes</strong>, and <strong>Revenue</strong> tabs all work by comparing days against each other — so removing this day can shift the trends, sales, and reorder numbers shown elsewhere. If you re-upload the same file later, the figures come back.
          </p>
        </ConfirmModal>
      )}

      {/* View tabs */}
      <div style={{ display: "flex", gap: 4, marginTop: 20, borderBottom: "1px solid #333a44", flexWrap: "wrap" }}>
        {([["list", "Reorder list"], ["changes", "Daily changes"], ["insights", "Insights"], ["revenue", "Revenue"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              background: "none", border: "none", cursor: "pointer", fontSize: 15,
              padding: "10px 16px", marginBottom: -1,
              color: view === key ? ACCENT : "#aab2bd",
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
                <div style={{ color: "#aab2bd", fontSize: 14 }}>{TIER_META[t].label}</div>
              </div>
            ))}
          </div>
          {openTier && <TierTable items={classified.filter((i: ClassifiedItem) => i.tier === openTier)} tier={openTier} />}
        </>
      )}
      {view === "changes" && <ChangesTab changes={changes} activeDate={activeDate} prevDate={prevDate} />}
      {view === "insights" && <Insights classified={classified} trend={trend} />}
      {view === "revenue" && <RevenueTab classified={classified} changes={changes} productMap={productMap} revenueSeries={revenueSeries} prevDate={prevDate} />}
    </div>
  );
}

function TierTable({ items, tier }: { items: ClassifiedItem[]; tier: Tier }) {
  const sorted = [...items].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.item.localeCompare(b.item));
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={{ marginTop: 0, color: TIER_META[tier].color }}>{TIER_META[tier].label} — {items.length} items</h3>
      {sorted.length === 0 ? <p style={{ color: "#9aa3ad" }}>Nothing in this category.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
                <th style={th}>Vendor</th><th style={th}>Item</th>
                <th style={{ ...th, textAlign: "center" }}>On hand</th>
                <th style={{ ...th, textAlign: "center" }}>On order</th>
                <th style={{ ...th, textAlign: "center" }}>Trend</th>
                <th style={{ ...th, textAlign: "center" }}>Order qty</th>
                <th style={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((i, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={td}>{i.vendor}</td>
                  <td style={td}>{i.item}</td>
                  <td style={{ ...td, textAlign: "center" }}>{i.qoh}</td>
                  <td style={{ ...td, textAlign: "center" }}>{i.po}</td>
                  <td style={{ ...td, textAlign: "center" }}><Sparkline history={i.history} /></td>
                  <td style={{ ...td, textAlign: "center", fontWeight: 600, color: i.suggestedQty ? ACCENT : "#6b7480" }}>{i.suggestedQty ? i.suggestedQty : "—"}</td>
                  <td style={{ ...td, color: "#aab2bd", fontSize: 13 }}>{i.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Insights tab ---------------------------------------------------------

function Insights({ classified, trend }: { classified: ClassifiedItem[]; trend: SnapshotStat[] }) {
  const total = classified.length;
  const outOfStock = classified.filter((i) => i.qoh === 0).length;
  const newStockouts = classified.filter(
    (i) => i.qoh === 0 && i.history.length >= 2 && i.history[i.history.length - 2].qoh > 0
  ).length;
  const weeklyVelocity = Math.round(classified.reduce((s, i) => s + (i.consumptionPerWeek || 0), 0));
  const deadStock = classified
    .filter((i) => i.qoh > 0 && i.consumptionPerWeek === 0)
    .sort((a, b) => b.qoh - a.qoh);
  const topMovers = classified
    .filter((i) => (i.consumptionPerWeek || 0) > 0)
    .sort((a, b) => (b.consumptionPerWeek || 0) - (a.consumptionPerWeek || 0))
    .slice(0, 7);

  // Group everything that needs ordering by vendor, so POs can be batched.
  const byVendor = new Map<string, { count: number; units: number }>();
  for (const i of classified) {
    if (i.tier !== "order_now" && i.tier !== "order_soon") continue;
    const e = byVendor.get(i.vendor) || { count: 0, units: 0 };
    e.count += 1;
    e.units += i.suggestedQty || 0;
    byVendor.set(i.vendor, e);
  }
  const vendorReorder = Array.from(byVendor.entries())
    .map(([vendor, v]) => ({ vendor, ...v }))
    .sort((a, b) => b.count - a.count);

  const maxMover = topMovers.length ? topMovers[0].consumptionPerWeek || 1 : 1;
  const pct = total > 0 ? ((outOfStock / total) * 100).toFixed(1) : "0";

  return (
    <div style={{ marginTop: 20 }}>
      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <Kpi label="Out of stock" value={String(outOfStock)} sub={`${pct}% of catalogue`} />
        <Kpi label="New stockouts" value={String(newStockouts)} sub="since previous snapshot" accent={newStockouts > 0 ? "#E24B4A" : undefined} />
        <Kpi label="Weekly velocity" value={weeklyVelocity.toLocaleString()} sub="units consumed / week" />
        <Kpi label="Dead stock" value={String(deadStock.length)} sub="in stock, no movement" />
      </div>

      {/* Stockout trend */}
      <div style={{ ...card, marginTop: 20 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Out-of-stock trend</h3>
        {trend.length < 2 ? (
          <p style={{ color: "#9aa3ad", fontSize: 14 }}>Upload at least two snapshots to see how stockouts are trending.</p>
        ) : (
          <TrendLine data={trend} />
        )}
      </div>

      {/* Top movers */}
      <div style={{ ...card, marginTop: 20 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Top movers <span style={{ color: "#9aa3ad", fontWeight: 400, fontSize: 13 }}>— fastest sellers, keep these stocked</span></h3>
        {topMovers.length === 0 ? (
          <p style={{ color: "#9aa3ad", fontSize: 14 }}>Not enough history yet to measure how fast items sell. Upload another snapshot or two.</p>
        ) : (
          <div>
            {topMovers.map((i) => (
              <div key={i.item + i.vendor} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                  <span>{i.item} <span style={{ color: "#8b94a0" }}>· {i.vendor}</span></span>
                  <span style={{ color: "#aab2bd" }}>{(i.consumptionPerWeek || 0).toFixed(1)} / wk{i.weeksOfStock !== null ? ` · ${i.weeksOfStock.toFixed(1)} wks left` : ""}</span>
                </div>
                <div style={{ background: "#2a2f37", borderRadius: 4, height: 8 }}>
                  <div style={{ width: `${Math.max(3, ((i.consumptionPerWeek || 0) / maxMover) * 100)}%`, background: ACCENT, height: 8, borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reorder by vendor */}
      <div style={{ ...card, marginTop: 20 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Reorder by vendor <span style={{ color: "#9aa3ad", fontWeight: 400, fontSize: 13 }}>— batch into one PO each</span></h3>
        {vendorReorder.length === 0 ? (
          <p style={{ color: "#9aa3ad", fontSize: 14 }}>Nothing needs reordering right now.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
              <th style={th}>Vendor</th>
              <th style={{ ...th, textAlign: "center" }}>Items to order</th>
              <th style={{ ...th, textAlign: "center" }}>Suggested units</th>
            </tr></thead>
            <tbody>
              {vendorReorder.map((v) => (
                <tr key={v.vendor} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={td}>{v.vendor}</td>
                  <td style={{ ...td, textAlign: "center" }}>{v.count}</td>
                  <td style={{ ...td, textAlign: "center" }}>{v.units > 0 ? `~${v.units}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Dead stock */}
      {deadStock.length > 0 && (
        <div style={{ ...card, marginTop: 20 }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Dead stock <span style={{ color: "#9aa3ad", fontWeight: 400, fontSize: 13 }}>— in stock but not selling, consider not reordering</span></h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
              <th style={th}>Vendor</th><th style={th}>Item</th>
              <th style={{ ...th, textAlign: "center" }}>On hand</th>
            </tr></thead>
            <tbody>
              {deadStock.slice(0, 12).map((i) => (
                <tr key={i.item + i.vendor} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={td}>{i.vendor}</td>
                  <td style={td}>{i.item}</td>
                  <td style={{ ...td, textAlign: "center" }}>{i.qoh}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {deadStock.length > 12 && <p style={{ color: "#9aa3ad", fontSize: 13, margin: "10px 0 0" }}>+ {deadStock.length - 12} more.</p>}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={{ ...statCard, background: "#232932" }}>
      <div style={{ color: "#aab2bd", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent || "#e6e8eb" }}>{value}</div>
      <div style={{ color: "#7d8794", fontSize: 12 }}>{sub}</div>
    </div>
  );
}

// Lightweight inline SVG line chart — no chart library needed.
function TrendLine({ data }: { data: SnapshotStat[] }) {
  const W = 600, H = 180, padX = 36, padY = 20;
  const max = Math.max(1, ...data.map((d) => d.outOfStock));
  const x = (i: number) => padX + (i * (W - padX * 2)) / Math.max(1, data.length - 1);
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const pts = data.map((d, i) => `${x(i)},${y(d.outOfStock)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Out-of-stock count over time">
      <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="#333a44" />
      <text x={4} y={y(max) + 4} fontSize={11} fill="#8b94a0">{max}</text>
      <text x={4} y={H - padY + 4} fontSize={11} fill="#8b94a0">0</text>
      <polyline points={pts} fill="none" stroke="#E24B4A" strokeWidth={2.5} />
      {data.map((d, i) => (
        <g key={d.date}>
          <circle cx={x(i)} cy={y(d.outOfStock)} r={3.5} fill="#E24B4A" />
          <text x={x(i)} y={H - 4} fontSize={11} fill="#9aa3ad" textAnchor="middle">{d.date.slice(5)}</text>
        </g>
      ))}
      <text x={x(data.length - 1)} y={y(data[data.length - 1].outOfStock) - 8} fontSize={12} fill="#E24B4A" textAnchor="end" fontWeight={600}>
        {data[data.length - 1].outOfStock}
      </text>
    </svg>
  );
}

// Tiny per-item trend line for table cells.
function Sparkline({ history }: { history: { qoh: number }[] }) {
  if (history.length < 2) return <span style={{ color: "#5b6470", fontSize: 12 }}>—</span>;
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
      <polyline points={pts} fill="none" stroke={down ? "#E24B4A" : "#34d399"} strokeWidth={1.5} />
    </svg>
  );
}

// ---- Daily changes tab ----------------------------------------------------

function ChangesTab({ changes, activeDate, prevDate }: { changes: InventoryChange[]; activeDate: string; prevDate: string | null }) {
  if (!prevDate) {
    return <div style={{ ...card, marginTop: 20, color: "#aab2bd" }}>This is your earliest snapshot. Upload another day&apos;s file to see what sold and what arrived.</div>;
  }
  const sold = changes.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta);
  const received = changes.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta);
  const unitsSold = sold.reduce((s, c) => s - c.delta, 0);
  const unitsReceived = received.reduce((s, c) => s + c.delta, 0);

  return (
    <div style={{ marginTop: 20 }}>
      <p style={{ color: "#aab2bd", fontSize: 14, marginTop: 0 }}>
        Change from <strong>{prevDate}</strong> to <strong>{activeDate}</strong>. Drops are sales; rises are stock arriving.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <Kpi label="Units sold" value={unitsSold.toLocaleString()} sub={`${sold.length} products`} accent="#E24B4A" />
        <Kpi label="Units received" value={unitsReceived.toLocaleString()} sub={`${received.length} products`} accent="#34d399" />
        <Kpi label="Net change" value={(unitsReceived - unitsSold).toLocaleString()} sub="received − sold" />
      </div>

      <ChangeTable title="Sold — inventory down" color="#E24B4A" rows={sold} />
      <ChangeTable title="Received — inventory up" color="#34d399" rows={received} />
    </div>
  );
}

function ChangeTable({ title, color, rows }: { title: string; color: string; rows: InventoryChange[] }) {
  return (
    <div style={{ ...card, marginTop: 20 }}>
      <h3 style={{ marginTop: 0, color, fontSize: 16 }}>{title} — {rows.length} items</h3>
      {rows.length === 0 ? <p style={{ color: "#9aa3ad", fontSize: 14 }}>Nothing here for this day.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
              <th style={th}>Vendor</th><th style={th}>Item</th>
              <th style={{ ...th, textAlign: "center" }}>Was</th>
              <th style={{ ...th, textAlign: "center" }}>Now</th>
              <th style={{ ...th, textAlign: "center" }}>Change</th>
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.item + c.vendor} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={td}>{c.vendor}</td>
                  <td style={td}>{c.item}</td>
                  <td style={{ ...td, textAlign: "center", color: "#8b94a0" }}>{c.prevQoh}</td>
                  <td style={{ ...td, textAlign: "center" }}>{c.qoh}</td>
                  <td style={{ ...td, textAlign: "center", fontWeight: 600, color }}>{c.delta > 0 ? `+${c.delta}` : c.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Revenue tab ----------------------------------------------------------

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

// Inline SVG revenue-over-time line chart (no chart library).
function MoneyTrend({ data }: { data: { date: string; revenue: number }[] }) {
  const W = 600, H = 190, padX = 48, padY = 20;
  const max = Math.max(1, ...data.map((d) => d.revenue));
  const x = (i: number) => padX + (i * (W - padX * 2)) / Math.max(1, data.length - 1);
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const pts = data.map((d, i) => `${x(i)},${y(d.revenue)}`).join(" ");
  const last = data[data.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Revenue per snapshot over time">
      <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="#333a44" />
      <text x={4} y={y(max) + 4} fontSize={11} fill="#7d8794">{money(max)}</text>
      <text x={4} y={H - padY + 4} fontSize={11} fill="#7d8794">$0</text>
      <polyline points={pts} fill="none" stroke="#34d399" strokeWidth={2.5} />
      {data.map((d, i) => (
        <g key={d.date}>
          <circle cx={x(i)} cy={y(d.revenue)} r={3.5} fill="#34d399" />
          <text x={x(i)} y={H - 4} fontSize={11} fill="#7d8794" textAnchor="middle">{d.date.slice(5)}</text>
        </g>
      ))}
      <text x={x(data.length - 1)} y={y(last.revenue) - 8} fontSize={12} fill="#34d399" textAnchor="end" fontWeight={600}>{money(last.revenue)}</text>
    </svg>
  );
}

function RevenueTab({ classified, changes, productMap, revenueSeries, prevDate }: { classified: ClassifiedItem[]; changes: InventoryChange[]; productMap: Map<string, ProductRow>; revenueSeries: { date: string; revenue: number }[]; prevDate: string | null }) {
  const totalRevenue = revenueSeries.reduce((s, r) => s + r.revenue, 0);
  let revenue = 0, cogs = 0, restockCost = 0;
  const sellers: { item: string; vendor: string; units: number; revenue: number }[] = [];
  for (const c of changes) {
    const p = productMap.get(c.item);
    const price = p?.price || 0, cost = p?.cost || 0;
    if (c.delta < 0) {
      const units = -c.delta;
      revenue += units * price;
      cogs += units * cost;
      sellers.push({ item: c.item, vendor: c.vendor, units, revenue: units * price });
    } else if (c.delta > 0) {
      restockCost += c.delta * cost;
    }
  }
  const grossProfit = revenue - cogs;
  const margin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  // Inventory valuation as of the selected snapshot.
  let invCost = 0, invRetail = 0, missing = 0;
  for (const i of classified) {
    const p = productMap.get(i.item);
    if (!p || (p.price === 0 && p.cost === 0)) missing += 1;
    invCost += i.qoh * (p?.cost || 0);
    invRetail += i.qoh * (p?.price || 0);
  }
  const topSellers = sellers.sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  return (
    <div style={{ marginTop: 20 }}>
      {missing > 0 && (
        <div style={warnBox}>
          {missing} of {classified.length} items have no cost/price set. Add them under <strong>Product pricing</strong> (top right) to make these numbers complete.
        </div>
      )}

      {prevDate ? (
        <>
          <p style={{ color: "#aab2bd", fontSize: 14, margin: "12px 0 0" }}>Sales since the previous snapshot ({prevDate}):</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 8 }}>
            <Kpi label="Revenue" value={money(revenue)} sub="units sold × price" accent="#34d399" />
            <Kpi label="Gross profit" value={money(grossProfit)} sub="revenue − cost of goods" />
            <Kpi label="Margin" value={`${margin.toFixed(1)}%`} sub="profit ÷ revenue" />
            <Kpi label="Restock spend" value={money(restockCost)} sub="cost of stock received" />
          </div>
        </>
      ) : (
        <div style={{ ...card, marginTop: 12, color: "#aab2bd" }}>Upload a second day&apos;s file to see sales revenue. Inventory value below works with one snapshot.</div>
      )}

      {revenueSeries.length >= 1 && (
        <div style={{ ...card, marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ marginTop: 0, marginBottom: 0, fontSize: 16 }}>Revenue over time</h3>
            <span style={{ color: "#aab2bd", fontSize: 13 }}>All snapshots total: <strong style={{ color: "#34d399" }}>{money(totalRevenue)}</strong></span>
          </div>
          {revenueSeries.length < 2 ? (
            <p style={{ color: "#9aa3ad", fontSize: 14, marginBottom: 0 }}>One day of sales so far. Upload more snapshots to chart the trend.</p>
          ) : (
            <div style={{ marginTop: 12 }}><MoneyTrend data={revenueSeries} /></div>
          )}
        </div>
      )}

      <p style={{ color: "#aab2bd", fontSize: 14, margin: "20px 0 0" }}>Current inventory value:</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 8 }}>
        <Kpi label="Value at cost" value={money(invCost)} sub="what it cost you" />
        <Kpi label="Retail value" value={money(invRetail)} sub="if it all sells" />
        <Kpi label="Potential profit" value={money(invRetail - invCost)} sub="retail − cost" />
      </div>

      {prevDate && (
        <div style={{ ...card, marginTop: 20 }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Top sellers this period <span style={{ color: "#9aa3ad", fontWeight: 400, fontSize: 13 }}>— by revenue</span></h3>
          {topSellers.length === 0 ? (
            <p style={{ color: "#9aa3ad", fontSize: 14 }}>No sales recorded, or no prices set yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
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
      )}
    </div>
  );
}

// ---- Product pricing editor -----------------------------------------------

function ProductPricing({ items, productMap, onSave }: {
  items: { item: string; vendor: string }[];
  productMap: Map<string, ProductRow>;
  onSave: (item: string, cost: number, price: number) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<string, { cost: string; price: string }>>({});
  const [savedItem, setSavedItem] = useState("");

  const filtered = items.filter((r) => r.item.toLowerCase().includes(filter.toLowerCase()));
  const shown = filtered.slice(0, 200);

  function val(item: string, field: "cost" | "price"): string {
    if (edits[item] && edits[item][field] !== undefined) return edits[item][field];
    const p = productMap.get(item);
    const n = p ? p[field] : undefined;
    return n === undefined || n === 0 ? "" : String(n);
  }
  function onEdit(item: string, field: "cost" | "price", v: string) {
    setEdits((e) => ({ ...e, [item]: { cost: e[item]?.cost ?? "", price: e[item]?.price ?? "", [field]: v } }));
  }
  async function commit(item: string) {
    const cost = parseFloat(val(item, "cost")) || 0;
    const price = parseFloat(val(item, "price")) || 0;
    await onSave(item, cost, price);
    setSavedItem(item);
    setTimeout(() => setSavedItem((s) => (s === item ? "" : s)), 1200);
  }

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Product pricing</h2>
      <p style={{ color: "#aab2bd", fontSize: 14 }}>Enter what each product costs you and what you sell it for. These save automatically and power the Revenue tab. Search to find items quickly.</p>
      <input
        type="text" placeholder="Search products…" value={filter}
        onChange={(e) => setFilter(e.target.value)} style={{ ...input, width: "100%", maxWidth: 320, marginBottom: 12 }}
      />
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
            <th style={th}>Item</th><th style={th}>Vendor</th>
            <th style={{ ...th, textAlign: "center" }}>Cost ($)</th>
            <th style={{ ...th, textAlign: "center" }}>Price ($)</th>
            <th style={{ ...th, width: 20 }}></th>
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.item} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={td}>{r.item}</td>
                <td style={{ ...td, color: "#9aa3ad" }}>{r.vendor}</td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={0} step={0.01} value={val(r.item, "cost")}
                    onChange={(e) => onEdit(r.item, "cost", e.target.value)} onBlur={() => commit(r.item)}
                    style={{ ...input, width: 80 }} />
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="number" min={0} step={0.01} value={val(r.item, "price")}
                    onChange={(e) => onEdit(r.item, "price", e.target.value)} onBlur={() => commit(r.item)}
                    style={{ ...input, width: 80 }} />
                </td>
                <td style={{ ...td, color: "#34d399" }}>{savedItem === r.item ? "✓" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > shown.length && (
        <p style={{ color: "#9aa3ad", fontSize: 13, marginBottom: 0 }}>Showing first {shown.length} of {filtered.length}. Type in the search box to narrow down.</p>
      )}
      {items.length === 0 && <p style={{ color: "#9aa3ad", fontSize: 14 }}>Upload an inventory file first — your products will appear here.</p>}
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
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 10px", color: "#f0a3a3" }}>{title}</h2>
        <div style={{ color: "#c7cdd5", fontSize: 14, lineHeight: 1.55 }}>{children}</div>
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
      <label style={{ fontSize: 14, color: "#aab2bd" }}>Snapshot:</label>
      <button onClick={() => setOpen((o) => !o)} style={{ ...input, cursor: "pointer", minWidth: 150, textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span>{activeDate || "Pick a date"}</span>
        <span style={{ color: "#7d8794", fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41, background: "#1e232b", border: "1px solid #333a44", borderRadius: 10, padding: 12, width: 280, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <button onClick={prevMonth} style={{ ...btnGhost, padding: "2px 10px" }}>‹</button>
              <strong style={{ fontSize: 14 }}>{monthName} {ym.y}</strong>
              <button onClick={nextMonth} style={{ ...btnGhost, padding: "2px 10px" }}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, marginBottom: 3 }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div key={i} style={{ textAlign: "center", fontSize: 11, color: "#7d8794" }}>{d}</div>
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
                      background: isActive ? ACCENT : hasUpload ? "rgba(91,155,255,.18)" : "transparent",
                      color: isActive ? "#0b1220" : hasUpload ? "#cfe0ff" : "#4b535e",
                      fontWeight: hasUpload ? 600 : 400,
                    }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#7d8794", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "rgba(91,155,255,.5)", marginRight: 5 }} />has a report</span>
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
      <p style={{ color: "#aab2bd", fontSize: 14 }}>Exclude vendors you don&apos;t reorder here, and set how many days each takes to deliver (drives the &quot;order now&quot; timing).</p>
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr style={{ textAlign: "left", borderBottom: "2px solid #eee" }}>
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
const ACCENT = "#5b9bff";
const dropZone: React.CSSProperties = { border: "2px dashed #3a414c", borderRadius: 8, padding: "48px 20px", textAlign: "center", marginTop: 24, transition: "all .15s" };
const card: React.CSSProperties = { background: "#1e232b", borderRadius: 10, padding: 24, marginTop: 24, border: "1px solid #333a44", boxShadow: "0 1px 3px rgba(0,0,0,.3)" };
const statCard: React.CSSProperties = { background: "#232932", borderRadius: 10, padding: 16, border: "1px solid #333a44", boxShadow: "0 1px 3px rgba(0,0,0,.3)" };
const btnPrimary: React.CSSProperties = { background: ACCENT, color: "#0b1220", border: "none", borderRadius: 6, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "inline-block" };
const btnGhost: React.CSSProperties = { background: "#232932", color: ACCENT, border: "1px solid #3a414c", borderRadius: 6, padding: "9px 16px", fontSize: 14, cursor: "pointer" };
const input: React.CSSProperties = { border: "1px solid #3a414c", borderRadius: 6, padding: "7px 10px", fontSize: 14, background: "#14181e", color: "#e6e8eb" };
const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, color: "#aab2bd" };
const td: React.CSSProperties = { padding: "8px 10px" };
const errBox: React.CSSProperties = { background: "#3a1d1d", color: "#f0a3a3", padding: "12px 16px", borderRadius: 8, marginTop: 16, fontSize: 14, border: "1px solid #5a2a2a" };
const warnBox: React.CSSProperties = { background: "#2e2a1a", color: "#e6c97a", padding: "12px 16px", borderRadius: 8, marginTop: 12, fontSize: 14, border: "1px solid #4a4226" };
