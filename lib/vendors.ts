export const VENDOR_CANON: string[] = [
  "A Wild Soap Bar", "Amazon", "Apex", "Biogenesis", "Biotics", "Boiron",
  "Deep Steep Cleansing", "Desert Biologicals", "Designs For Health", "Diagnos-Techs",
  "Dr. Garber's", "Drucker", "Electro Medical Technologies", "Emerson Ecologics", "Essence",
  "Faire", "Fontana Candle Co.", "Fullscript", "Global Healing", "GX Sciences",
  "Homeopathy Works", "Integrative Peptides", "Irving Health & Wellness", "Kari Gran",
  "Lady May Tallow", "Little Seed Farm", "MicroBiome Labs", "Mindful Minerals",
  "Nature's Scent Co.", "Natures Sunshine", "Neuro Biologix", "Neurogan Health", "NuMedica",
  "Nutri-West", "Nutritional Frontiers", "Ortho Molecular", "Osborn, Brenda", "PatchAid",
  "Professional Formulas", "PurO3", "Queen of Thrones", "VasoLabs", "WAAYB",
  "Wild Herb Soap Co", "Xymogen EP",
];

export const DEFAULT_EXCLUDED: string[] = [
  "GX Sciences", "Diagnos-Techs", "A Wild Soap Bar", "Nature's Scent Co.",
  "Deep Steep Cleansing", "Dr. Garber's", "Electro Medical Technologies", "Essence",
  "Fontana Candle Co.", "Homeopathy Works", "Irving Health & Wellness", "Mindful Minerals",
  "PurO3", "VasoLabs", "Wild Herb Soap Co",
];

export const DEFAULT_LEAD_DAYS = 14;

export function canonicalVendor(raw: string): string | null {
  const clean = raw.replace(/\.\.\.$/, "").replace(/[,\.]+$/, "").trim();
  if (!clean) return null;
  for (const c of VENDOR_CANON) if (c.toLowerCase() === clean.toLowerCase()) return c;
  for (const c of VENDOR_CANON) if (c.toLowerCase().startsWith(clean.toLowerCase()) && clean.length >= 3) return c;
  for (const c of VENDOR_CANON) if (clean.toLowerCase().startsWith(c.toLowerCase())) return c;
  return null;
}
