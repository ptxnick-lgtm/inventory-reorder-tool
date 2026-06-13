export interface SnapshotRow {
  snapshot_date: string;
  item: string;
  vendor: string;
  qoh: number;
  po: number;
}

export type Tier = "order_now" | "order_soon" | "chronic_low" | "already_ordered" | "ok";

export interface ClassifiedItem {
  item: string;
  vendor: string;
  qoh: number;
  po: number;
  tier: Tier;
  weeksOfStock: number | null;
  consumptionPerWeek: number | null;
  suggestedQty: number | null;
  reason: string;
  history: { date: string; qoh: number; po: number }[];
}

export interface ClassifyOptions {
  excludedVendors: string[];
  leadDaysByVendor: Record<string, number>;
  defaultLeadDays: number;
}

const MS_PER_DAY = 86400000;

function weeksBetween(a: string, b: string): number {
  const d = (new Date(b).getTime() - new Date(a).getTime()) / MS_PER_DAY / 7;
  return d <= 0 ? 0 : d;
}

// Consumption = sum of decreases in qoh across consecutive snapshots, ignoring increases (restocks).
// Returns units consumed per week, or null if not enough history.
function consumptionPerWeek(hist: { date: string; qoh: number }[]): number | null {
  if (hist.length < 2) return null;
  let consumed = 0;
  let weeks = 0;
  for (let i = 1; i < hist.length; i++) {
    const dq = hist[i - 1].qoh - hist[i].qoh; // positive = consumed
    const w = weeksBetween(hist[i - 1].date, hist[i].date);
    if (w > 0) {
      weeks += w;
      if (dq > 0) consumed += dq;
    }
  }
  if (weeks <= 0) return null;
  return consumed / weeks;
}

export function classify(
  snapshots: SnapshotRow[],
  latestDate: string,
  opts: ClassifyOptions
): ClassifiedItem[] {
  if (!latestDate) return [];
  // Drop any rows missing the fields we group and sort on, so a single bad row
  // can never throw mid-classification.
  const valid = snapshots.filter((s) => s && s.snapshot_date && s.item && s.vendor);

  // Group all snapshots by item+vendor key
  const byKey = new Map<string, SnapshotRow[]>();
  for (const s of valid) {
    const k = s.item + "||" + s.vendor;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s);
  }

  const out: ClassifiedItem[] = [];

  for (const [, allRecs] of byKey) {
    allRecs.sort((a, b) => (a.snapshot_date || "").localeCompare(b.snapshot_date || ""));
    // Only consider snapshots up to and including the selected date ("as of" that date).
    const recs = allRecs.filter((r) => r.snapshot_date <= latestDate);
    if (recs.length === 0) continue;
    const latest = recs[recs.length - 1];
    // The item must actually appear in the selected snapshot to be classified.
    if (latest.snapshot_date !== latestDate) continue;
    if (opts.excludedVendors.includes(latest.vendor)) continue;

    const hist = recs.map((r) => ({ date: r.snapshot_date, qoh: r.qoh, po: r.po }));
    const cpw = consumptionPerWeek(hist);
    const leadDays = opts.leadDaysByVendor[latest.vendor] ?? opts.defaultLeadDays;
    const leadWeeks = leadDays / 7;
    const buffer = leadWeeks + 1; // order when stock would run out within lead time + 1 week safety

    let weeksOfStock: number | null = null;
    if (cpw && cpw > 0) weeksOfStock = latest.qoh / cpw;

    // Suggested order quantity: enough to cover the vendor's lead time plus a ~2-week
    // safety/review buffer, minus what's already on hand and on order. Only meaningful
    // when we have a real consumption rate.
    let suggestedQty: number | null = null;
    if (cpw && cpw > 0) {
      suggestedQty = Math.max(0, Math.ceil(cpw * (leadWeeks + 2) - latest.qoh - latest.po));
    }

    let tier: Tier = "ok";
    let reason = "";

    const priorRecs = recs.slice(0, -1);
    const wasZeroNoPObefore = priorRecs.length > 0 && priorRecs.every((r) => r.qoh === 0 && r.po === 0);

    if (latest.po > 0) {
      tier = "already_ordered";
      reason = `On purchase order (${latest.po} incoming).`;
    } else if (latest.qoh === 0) {
      if (wasZeroNoPObefore) {
        tier = "chronic_low";
        reason = "Out of stock across multiple snapshots with no order placed — likely low demand.";
      } else {
        tier = "order_now";
        reason = "Out of stock with nothing on order.";
      }
    } else if (weeksOfStock !== null && weeksOfStock <= buffer) {
      tier = "order_now";
      reason = `Only ~${weeksOfStock.toFixed(1)} weeks of stock left; vendor lead time is ~${leadWeeks.toFixed(1)} weeks. Order now to avoid a gap.`;
    } else if (weeksOfStock !== null && weeksOfStock <= buffer + 2) {
      tier = "order_soon";
      reason = `~${weeksOfStock.toFixed(1)} weeks of stock left; will need ordering before next check.`;
    } else {
      tier = "ok";
      reason = weeksOfStock !== null ? `~${weeksOfStock.toFixed(1)} weeks of stock.` : "Adequate stock.";
    }

    out.push({
      item: latest.item,
      vendor: latest.vendor,
      qoh: latest.qoh,
      po: latest.po,
      tier,
      weeksOfStock,
      consumptionPerWeek: cpw,
      suggestedQty,
      reason,
      history: hist,
    });
  }

  return out;
}

export interface SnapshotStat {
  date: string;
  outOfStock: number;
  itemCount: number;
}

// Out-of-stock count for each snapshot date, so the UI can chart the trend over
// time. Excluded vendors are left out to match the rest of the dashboard.
export function snapshotTrend(snapshots: SnapshotRow[], excludedVendors: string[] = []): SnapshotStat[] {
  const excl = new Set(excludedVendors);
  const byDate = new Map<string, { out: number; total: number }>();
  for (const s of snapshots) {
    if (!s || !s.snapshot_date || !s.item || !s.vendor) continue;
    if (excl.has(s.vendor)) continue;
    const e = byDate.get(s.snapshot_date) || { out: 0, total: 0 };
    e.total += 1;
    if (s.qoh === 0) e.out += 1;
    byDate.set(s.snapshot_date, e);
  }
  return Array.from(byDate.entries())
    .map(([date, v]) => ({ date, outOfStock: v.out, itemCount: v.total }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const TIER_META: Record<Tier, { label: string; color: string; order: number }> = {
  order_now: { label: "Order now", color: "#E24B4A", order: 0 },
  order_soon: { label: "Order soon", color: "#EF9F27", order: 1 },
  chronic_low: { label: "Low priority", color: "#EAC54F", order: 2 },
  already_ordered: { label: "Already ordered", color: "#1D9E75", order: 3 },
  ok: { label: "OK", color: "#888780", order: 4 },
};
