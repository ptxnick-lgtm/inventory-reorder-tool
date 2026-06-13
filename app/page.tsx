"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { parseCSVText, parseXLSX, ParseResult } from "@/lib/parser";
import { classify, snapshotTrend, ClassifiedItem, SnapshotStat, TIER_META, Tier, SnapshotRow } from "@/lib/classify";
import {
  fetchVendors, fetchAllSnapshots, insertSnapshot, fetchImportedDates,
  updateVendor, addVendor, VendorRow,
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
  const [dragOver, setDragOver] = useState(false);

  const loadDb = useCallback(async () => {
    try {
      const [v, d] = await Promise.all([fetchVendors(), fetchImportedDates()]);
      setVendors(v);
      setImportedDates(d);
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
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Inventory Reorder Tool</h1>
        <button onClick={() => setShowSettings(!showSettings)} style={btnGhost}>
          {showSettings ? "Close settings" : "Vendor settings"}
        </button>
      </div>
      <p style={{ color: "#666", marginTop: 6 }}>
        Export your inventory from QuickBooks as CSV or Excel, drop it below, and get a sorted reorder list.
      </p>

      {error && <div style={errBox}>{error}</div>}

      {showSettings && <VendorSettings vendors={vendors} onChange={loadDb} />}

      {/* Upload zone */}
      {(stage === "idle" || stage === "parsing") && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{ ...dropZone, borderColor: dragOver ? "#2b6cb0" : "#cbd5e0", background: dragOver ? "#ebf4ff" : "#fff" }}
        >
          {stage === "parsing" ? (
            <p>Reading {fileName}…</p>
          ) : (
            <>
              <p style={{ fontSize: 16, margin: 0 }}>Drag a CSV or Excel file here</p>
              <p style={{ color: "#888", margin: "8px 0 16px" }}>or</p>
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
            {parseResult.detectedDate && <span style={{ color: "#888", fontSize: 13 }}>(auto-detected from file)</span>}
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
          activeDate={activeDate}
          importedDates={importedDates}
          onPickDate={async (d) => { setActiveDate(d); await runClassify(d, vendors); }}
          tierCounts={tierCounts}
          onExport={() => exportSortedPdf(classified, activeDate)}
          onNewUpload={() => { setStage("idle"); setParseResult(null); }}
        />
      )}

      {!classified && stage === "idle" && !error && (
        <p style={{ color: "#888", marginTop: 24 }}>No inventory uploaded yet. Drop your first file above to begin.</p>
      )}
    </main>
  );
}

interface DashboardProps {
  classified: ClassifiedItem[];
  trend: SnapshotStat[];
  activeDate: string;
  importedDates: string[];
  onPickDate: (d: string) => void | Promise<void>;
  tierCounts: (t: Tier) => number;
  onExport: () => void;
  onNewUpload: () => void;
}

function Dashboard({ classified, trend, activeDate, importedDates, onPickDate, tierCounts, onExport, onNewUpload }: DashboardProps) {
  const tiers: Tier[] = ["order_now", "order_soon", "chronic_low", "already_ordered"];
  const [openTier, setOpenTier] = useState<Tier | null>("order_now");
  const [view, setView] = useState<"list" | "insights">("list");
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ fontSize: 14, color: "#666" }}>Snapshot:</label>
          <select value={activeDate} onChange={(e) => onPickDate(e.target.value)} style={input}>
            {importedDates.slice().reverse().map((d: string) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onExport} style={btnPrimary}>Download PDF</button>
          <button onClick={onNewUpload} style={btnGhost}>Upload new file</button>
        </div>
      </div>

      {/* View tabs */}
      <div style={{ display: "flex", gap: 4, marginTop: 20, borderBottom: "1px solid #e2e8f0" }}>
        {([["list", "Reorder list"], ["insights", "Insights"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              background: "none", border: "none", cursor: "pointer", fontSize: 15,
              padding: "10px 16px", marginBottom: -1,
              color: view === key ? "#2b6cb0" : "#666",
              fontWeight: view === key ? 600 : 400,
              borderBottom: view === key ? "2px solid #2b6cb0" : "2px solid transparent",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "list" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginTop: 20 }}>
            {tiers.map((t) => (
              <div key={t} onClick={() => setOpenTier(t)} style={{ ...statCard, borderTop: `4px solid ${TIER_META[t].color}`, cursor: "pointer", opacity: openTier === t ? 1 : 0.85 }}>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{tierCounts(t)}</div>
                <div style={{ color: "#555", fontSize: 14 }}>{TIER_META[t].label}</div>
              </div>
            ))}
          </div>
          {openTier && <TierTable items={classified.filter((i: ClassifiedItem) => i.tier === openTier)} tier={openTier} />}
        </>
      ) : (
        <Insights classified={classified} trend={trend} />
      )}
    </div>
  );
}

function TierTable({ items, tier }: { items: ClassifiedItem[]; tier: Tier }) {
  const sorted = [...items].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.item.localeCompare(b.item));
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={{ marginTop: 0, color: TIER_META[tier].color }}>{TIER_META[tier].label} — {items.length} items</h3>
      {sorted.length === 0 ? <p style={{ color: "#888" }}>Nothing in this category.</p> : (
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
                  <td style={{ ...td, textAlign: "center", fontWeight: 600, color: i.suggestedQty ? "#2b6cb0" : "#bbb" }}>{i.suggestedQty ? i.suggestedQty : "—"}</td>
                  <td style={{ ...td, color: "#666", fontSize: 13 }}>{i.reason}</td>
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
          <p style={{ color: "#888", fontSize: 14 }}>Upload at least two snapshots to see how stockouts are trending.</p>
        ) : (
          <TrendLine data={trend} />
        )}
      </div>

      {/* Top movers */}
      <div style={{ ...card, marginTop: 20 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Top movers <span style={{ color: "#888", fontWeight: 400, fontSize: 13 }}>— fastest sellers, keep these stocked</span></h3>
        {topMovers.length === 0 ? (
          <p style={{ color: "#888", fontSize: 14 }}>Not enough history yet to measure how fast items sell. Upload another snapshot or two.</p>
        ) : (
          <div>
            {topMovers.map((i) => (
              <div key={i.item + i.vendor} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                  <span>{i.item} <span style={{ color: "#999" }}>· {i.vendor}</span></span>
                  <span style={{ color: "#555" }}>{(i.consumptionPerWeek || 0).toFixed(1)} / wk{i.weeksOfStock !== null ? ` · ${i.weeksOfStock.toFixed(1)} wks left` : ""}</span>
                </div>
                <div style={{ background: "#edf2f7", borderRadius: 4, height: 8 }}>
                  <div style={{ width: `${Math.max(3, ((i.consumptionPerWeek || 0) / maxMover) * 100)}%`, background: "#2b6cb0", height: 8, borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reorder by vendor */}
      <div style={{ ...card, marginTop: 20 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Reorder by vendor <span style={{ color: "#888", fontWeight: 400, fontSize: 13 }}>— batch into one PO each</span></h3>
        {vendorReorder.length === 0 ? (
          <p style={{ color: "#888", fontSize: 14 }}>Nothing needs reordering right now.</p>
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
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Dead stock <span style={{ color: "#888", fontWeight: 400, fontSize: 13 }}>— in stock but not selling, consider not reordering</span></h3>
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
          {deadStock.length > 12 && <p style={{ color: "#888", fontSize: 13, margin: "10px 0 0" }}>+ {deadStock.length - 12} more.</p>}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={{ ...statCard, background: "#f7fafc" }}>
      <div style={{ color: "#666", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent || "#1a202c" }}>{value}</div>
      <div style={{ color: "#999", fontSize: 12 }}>{sub}</div>
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
      <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="#e2e8f0" />
      <text x={4} y={y(max) + 4} fontSize={11} fill="#999">{max}</text>
      <text x={4} y={H - padY + 4} fontSize={11} fill="#999">0</text>
      <polyline points={pts} fill="none" stroke="#E24B4A" strokeWidth={2.5} />
      {data.map((d, i) => (
        <g key={d.date}>
          <circle cx={x(i)} cy={y(d.outOfStock)} r={3.5} fill="#E24B4A" />
          <text x={x(i)} y={H - 4} fontSize={11} fill="#888" textAnchor="middle">{d.date.slice(5)}</text>
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
  if (history.length < 2) return <span style={{ color: "#ccc", fontSize: 12 }}>—</span>;
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
      <polyline points={pts} fill="none" stroke={down ? "#E24B4A" : "#1D9E75"} strokeWidth={1.5} />
    </svg>
  );
}

function VendorSettings({ vendors, onChange }: { vendors: VendorRow[]; onChange: () => void }) {
  const [saving, setSaving] = useState("");
  async function toggle(v: VendorRow) { setSaving(v.name); await updateVendor(v.name, { excluded: !v.excluded }); await onChange(); setSaving(""); }
  async function setLead(v: VendorRow, days: number) { setSaving(v.name); await updateVendor(v.name, { lead_days: days }); await onChange(); setSaving(""); }
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Vendor settings</h2>
      <p style={{ color: "#666", fontSize: 14 }}>Exclude vendors you don&apos;t reorder here, and set how many days each takes to deliver (drives the &quot;order now&quot; timing).</p>
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

const dropZone: React.CSSProperties = { border: "2px dashed #cbd5e0", borderRadius: 12, padding: "48px 20px", textAlign: "center", marginTop: 24, transition: "all .15s" };
const card: React.CSSProperties = { background: "#fff", borderRadius: 12, padding: 24, marginTop: 24, boxShadow: "0 1px 3px rgba(0,0,0,.06)" };
const statCard: React.CSSProperties = { background: "#fff", borderRadius: 10, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,.06)" };
const btnPrimary: React.CSSProperties = { background: "#2b6cb0", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 14, cursor: "pointer", display: "inline-block" };
const btnGhost: React.CSSProperties = { background: "#fff", color: "#2b6cb0", border: "1px solid #cbd5e0", borderRadius: 8, padding: "9px 16px", fontSize: 14, cursor: "pointer" };
const input: React.CSSProperties = { border: "1px solid #cbd5e0", borderRadius: 6, padding: "7px 10px", fontSize: 14 };
const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, color: "#444" };
const td: React.CSSProperties = { padding: "8px 10px" };
const errBox: React.CSSProperties = { background: "#fde8e8", color: "#9b1c1c", padding: "12px 16px", borderRadius: 8, marginTop: 16, fontSize: 14 };
const warnBox: React.CSSProperties = { background: "#fef6e7", color: "#92591a", padding: "12px 16px", borderRadius: 8, marginTop: 12, fontSize: 14 };
