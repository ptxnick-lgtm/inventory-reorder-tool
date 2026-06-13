import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { ClassifiedItem, TIER_META, Tier } from "./classify";

const TIER_ORDER: Tier[] = ["order_now", "order_soon", "chronic_low", "already_ordered"];

export function exportSortedPdf(items: ClassifiedItem[], snapshotDate: string) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  doc.setFontSize(16);
  doc.text("Reorder List", 40, 40);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Inventory snapshot: ${snapshotDate}`, 40, 58);
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, 40, 72);

  let startY = 92;

  for (const tier of TIER_ORDER) {
    const group = items
      .filter((i) => i.tier === tier)
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.item.localeCompare(b.item));
    if (group.length === 0) continue;

    const meta = TIER_META[tier];
    const rgb = hexToRgb(meta.color);

    doc.setFontSize(12);
    doc.setTextColor(rgb[0], rgb[1], rgb[2]);
    doc.text(`${meta.label} (${group.length})`, 40, startY);
    startY += 8;

    autoTable(doc, {
      startY: startY + 4,
      head: [["Vendor", "Item", "On hand", "On order", "Note"]],
      body: group.map((i) => [
        i.vendor,
        i.item,
        String(i.qoh),
        String(i.po),
        i.reason,
      ]),
      styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: rgb, textColor: 255, fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 90 },
        1: { cellWidth: 150 },
        2: { cellWidth: 45, halign: "center" },
        3: { cellWidth: 45, halign: "center" },
        4: { cellWidth: 180 },
      },
      margin: { left: 40, right: 40 },
    });

    startY = (doc as any).lastAutoTable.finalY + 24;
    if (startY > 700) {
      doc.addPage();
      startY = 40;
    }
  }

  doc.save(`reorder-list-${snapshotDate}.pdf`);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
