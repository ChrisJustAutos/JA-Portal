/**
 * Just Autos — Workshop Map / Conversion : core business logic
 * Reference implementation ported 1:1 from the analysis that produced
 * JA_FY2026_Workshop_Dashboard.html (see docs/ handoff). Keep this as the
 * single source of truth for vehicle classification so the live portal
 * matches the static build. Do NOT re-derive these rules.
 *
 * Pure functions only — no I/O. Feed it rows shaped like the Mechanics Desk
 * exports and it returns vehicle group, noise flag, etc. Geocoding + dedup
 * helpers included.
 */

// ----------------------------------------------------------------------------
// Vehicle groups (the buckets shown on the map / conversion)
// ----------------------------------------------------------------------------
export type VehicleGroup = "70" | "200" | "300" | "HILUX" | "PRADO" | "LCNA" | "OTH";

export const VEHICLE_CATS: { k: VehicleGroup; n: string; col: string }[] = [
  { k: "70",    n: "LC 70 Series",    col: "#FFB454" },
  { k: "200",   n: "LC 200 Series",   col: "#11ADE6" },
  { k: "300",   n: "LC 300 Series",   col: "#47FFCF" },
  { k: "HILUX", n: "Hilux",           col: "#B388FF" },
  { k: "PRADO", n: "Prado",           col: "#FF6FB5" },
  { k: "LCNA",  n: "LC (series N/A)", col: "#8aa0b8" },
  { k: "OTH",   n: "Other / unknown", col: "#6b7a8d" },
];

// ----------------------------------------------------------------------------
// Chassis-code detection
// ----------------------------------------------------------------------------
// Toyota chassis codes → series. NOTE the 70-series also covers the new 2.8
// GDJ7x (2024+) as well as the V8 VDJ7x. 250 = new Prado, 150 = old Prado.
const CHASSIS_PATTERNS: Record<string, RegExp[]> = {
  "300":   [/FJA300/, /\bLC300\b/],
  "200":   [/VDJ200/, /UZJ200/],
  "70":    [/VDJ79/, /VDJ78/, /VDJ76/, /VDJ70/, /GDJ79/, /GDJ78/, /GDJ76/, /GDJ70/],
  "PRADO": [/GDJ150/, /GRJ150/, /KDJ150/, /GDJ250/],
  "HILUX": [/GUN12[56]/, /KUN2[56]/],
};
// Tie-break order when a blob mentions more than one code with equal counts.
// 70 deliberately beats 200 (fixes the historical "VDJ79 multimap → 200" bug).
const SERIES_PRIORITY: string[] = ["70", "200", "300", "PRADO", "HILUX"];

/**
 * Returns the dominant chassis series in a piece of text by counting hits per
 * series and taking the max (priority order breaks ties). null if none.
 */
export function bestChassis(text?: string | null): string | null {
  if (!text) return null;
  const t = text.toUpperCase();
  const counts: Record<string, number> = {};
  for (const [k, pats] of Object.entries(CHASSIS_PATTERNS)) {
    const n = pats.reduce((s, p) => s + (t.match(new RegExp(p, "g"))?.length ?? 0), 0);
    if (n > 0) counts[k] = n;
  }
  const keys = Object.keys(counts);
  if (!keys.length) return null;
  const mx = Math.max(...Object.values(counts));
  for (const k of SERIES_PRIORITY) if ((counts[k] ?? 0) === mx) return k;
  return null;
}

/** Coarse type from the free-text Vehicle Model field. */
export function modelType(model?: string | null): "PRADO" | "HILUX" | "LC" | "OTHMODEL" | null {
  const s = (model ?? "").toLowerCase().trim();
  if (s.includes("prado")) return "PRADO";
  if (s.includes("hilux") || s.includes("fortuner")) return "HILUX";
  if (s.startsWith("land") || s.includes("cruiser") || s.includes("criser")) return "LC";
  if (s === "" || s === "nan") return null;
  return "OTHMODEL";
}

// ----------------------------------------------------------------------------
// Classification
// ----------------------------------------------------------------------------
export interface VehicleInputs {
  jobTypeText?: string | null;   // Invoices: "First Job Type". Quotes: usually null.
  model?: string | null;         // Vehicle Model
  descText?: string | null;      // header Description
  itemsText?: string | null;     // concatenated line-item Description+Details+Stock Name+Stock Number(+Category)
  vehicleId?: string | null;     // Invoices only
  rego?: string | null;          // Vehicle Registration Number (invoices + quote items)
}

export interface ClassifyResult { group: VehicleGroup; inferred: boolean; }

/**
 * Decision order (highest-trust signal wins):
 *   1. Chassis code in the JOB TYPE  ← authoritative (this is per-job)
 *   2. Chassis code in the MODEL field
 *   3. Model says Prado / Hilux
 *   4. vehicleId → series backfill  (a vehicle's own resolved series)
 *   5. Dominant chassis in description + line items
 *   6. rego → series backfill
 *   7. clutch / 1300Nm / 1600Nm  → 70 Series  (manual-clutch tell)
 *   8. LandCruiser but unresolved → LCNA ; unknown → OTH
 *
 * vehicleIdMap / regoMap are built once from the INVOICE data
 * (see buildIdSeriesMaps) — they only ever hold "70" | "200" | "300".
 */
export function classifyVehicle(
  v: VehicleInputs,
  vehicleIdMap: Record<string, string> = {},
  regoMap: Record<string, string> = {},
): ClassifyResult {
  const g = (x: string): VehicleGroup => x as VehicleGroup;

  const jobChassis = bestChassis(v.jobTypeText);
  if (jobChassis) return { group: g(jobChassis), inferred: false };          // 1

  const modelChassis = bestChassis(v.model);
  if (modelChassis) return { group: g(modelChassis), inferred: false };      // 2

  const mt = modelType(v.model);
  if (mt === "HILUX") return { group: "HILUX", inferred: false };            // 3
  if (mt === "PRADO") return { group: "PRADO", inferred: false };

  const vid = (v.vehicleId ?? "").trim();
  if (vid && vehicleIdMap[vid]) return { group: g(vehicleIdMap[vid]), inferred: true }; // 4

  const descChassis = bestChassis(`${v.descText ?? ""} ${v.itemsText ?? ""}`);
  if (descChassis) return { group: g(descChassis), inferred: false };        // 5

  const rg = (v.rego ?? "").toUpperCase().trim();
  if (rg && regoMap[rg]) return { group: g(regoMap[rg]), inferred: true };   // 6

  const blob = `${v.jobTypeText ?? ""} ${v.descText ?? ""} ${v.itemsText ?? ""}`.toUpperCase();
  if (mt === "LC") {
    if (/1300\s?NM|1600\s?NM|CLUTCH/.test(blob)) return { group: "70", inferred: true }; // 7
    return { group: "LCNA", inferred: false };                              // 8
  }
  return { group: "OTH", inferred: false };
}

/**
 * Build vehicleId→series and rego→series maps from the INVOICE dataset.
 * For each invoice, resolve series from job type → model → desc+items (explicit
 * codes only, "70"|"200"|"300"). Then take the MODE per vehicleId / per rego so
 * one noisy line can't flip a vehicle. Used to backfill quote-only vehicles too.
 */
export function buildIdSeriesMaps(
  invoices: { vehicleId?: string | null; rego?: string | null; jobTypeText?: string | null; model?: string | null; descText?: string | null; itemsText?: string | null }[],
): { vehicleIdMap: Record<string, string>; regoMap: Record<string, string> } {
  const byId: Record<string, Record<string, number>> = {};
  const byRego: Record<string, Record<string, number>> = {};
  for (const r of invoices) {
    let ser: string | null = bestChassis(r.jobTypeText) ?? bestChassis(r.model)
      ?? bestChassis(`${r.descText ?? ""} ${r.itemsText ?? ""}`);
    if (ser !== "70" && ser !== "200" && ser !== "300") ser = null;
    if (!ser) continue;
    const vid = (r.vehicleId ?? "").trim();
    const rg = (r.rego ?? "").toUpperCase().trim();
    if (vid) (byId[vid] ??= {})[ser] = ((byId[vid] ??= {})[ser] ?? 0) + 1;
    if (rg) (byRego[rg] ??= {})[ser] = ((byRego[rg] ??= {})[ser] ?? 0) + 1;
  }
  const mode = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
  const vehicleIdMap: Record<string, string> = {};
  const regoMap: Record<string, string> = {};
  for (const [k, m] of Object.entries(byId)) vehicleIdMap[k] = mode(m);
  for (const [k, m] of Object.entries(byRego)) regoMap[k] = mode(m);
  return { vehicleIdMap, regoMap };
}

// ----------------------------------------------------------------------------
// Noise exclusion (JOBS/invoices only — quotes are NOT noise-filtered)
// ----------------------------------------------------------------------------
/** true = drop this invoice from the "clear jobs" set. */
export function isNoiseInvoice(inv: {
  jobTypeText?: string | null; descText?: string | null; itemsText?: string | null;
  totalAmount?: number | null; customerName?: string | null;
}): boolean {
  const fjt = (inv.jobTypeText ?? "").toUpperCase();
  const desc = (inv.descText ?? "").toUpperCase();
  const itx = (inv.itemsText ?? "").toUpperCase();
  const total = inv.totalAmount ?? 0;
  const cust = (inv.customerName ?? "").toUpperCase();
  const deposit    = /DEPOSIT|BOOKING FEE/.test(fjt) || /DEPOSIT|BOOKING FEE/.test(desc) || /TUNE DEPOSIT|BOOKING FEE/.test(itx);
  const diagnostic = /DIAGNOS/.test(fjt) || /DIAGNOS/.test(desc);
  const dongle     = /REMOTE SUPPORT/.test(desc);
  const toll       = /TOLL|COURTESY CAR/.test(desc);
  const zero       = total === 0;
  const internal   = cust.startsWith("JUST AUTOS"); // internal / staff / wholesale accounts
  return deposit || diagnostic || dongle || toll || zero || internal;
}

// ----------------------------------------------------------------------------
// Quote "won" status  (kept for reference; conversion does NOT rely on this —
// bookings often aren't linked back to the quote, so status under-reports)
// ----------------------------------------------------------------------------
export const WON_STATUSES = new Set(["job created", "booking created", "invoice created", "in progress"]);
export const LOST_STATUSES = new Set(["expired", "bounced", "cancelled"]);
export const isWon = (status?: string | null) => WON_STATUSES.has((status ?? "").toLowerCase());

// ----------------------------------------------------------------------------
// Dedup: 1 per (customerId, month), keep the largest-value row.
// Apply to BOTH jobs and quotes so conversion is like-for-like.
// ----------------------------------------------------------------------------
export function dedupLargestPerCustomerMonth<T extends { customerId?: string | null; month: string; amount: number }>(
  rows: T[],
): T[] {
  const best: Record<string, T> = {};
  for (const r of rows) {
    const key = `${r.customerId ?? "?"}|${r.month}`;
    if (!best[key] || r.amount > best[key].amount) best[key] = r;
  }
  return Object.values(best);
}

// ----------------------------------------------------------------------------
// Geocoding: postcode → lat/lng, with suburb-name fallback.
// Provide lookups seeded from the AU postcode dataset (au-postcodes.json,
// generated from the Matthew Proctor open dataset).
// ----------------------------------------------------------------------------
export interface LatLng { lat: number; lng: number; locality?: string; }
export function geocode(
  postcode: string | null | undefined,
  suburb: string | null | undefined,
  postcodeMap: Record<string, LatLng>,      // key: 4-digit postcode
  suburbMap: Record<string, LatLng>,        // key: UPPER(suburb) (avg of matching localities)
): LatLng | null {
  const pc = (postcode ?? "").match(/\d{3,4}/)?.[0]?.padStart(4, "0");
  if (pc && postcodeMap[pc]) return postcodeMap[pc];
  const sk = (suburb ?? "").toUpperCase().trim();
  if (sk && suburbMap[sk]) return suburbMap[sk];
  return null;
}

// ----------------------------------------------------------------------------
// AU financial-year helpers (FY = Jul→Jun; "FY2026" = Jul 2025 – Jun 2026).
// ----------------------------------------------------------------------------
/** "YYYY-MM" month key, or null for an invalid date. */
export function monthKey(d: Date): string | null {
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** AU FY a date belongs to (Jul 2025 → 2026). */
export function fyOf(d: Date): number | null {
  if (isNaN(d.getTime())) return null;
  return d.getMonth() + 1 >= 7 ? d.getFullYear() + 1 : d.getFullYear();
}

/** 0–11 index of a date's month within its FY (Jul = 0 … Jun = 11). */
export function fyMonthIndex(d: Date): number {
  return (d.getMonth() + 12 - 6) % 12;
}

/** The 12 {k:'YYYY-MM', label:'Jul 25'} month descriptors for an FY. */
export function fyMonths(fy: number): { k: string; label: string }[] {
  const names = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  return names.map((n, i) => {
    const y = i < 6 ? fy - 1 : fy;
    const m = i < 6 ? i + 7 : i - 5;
    return { k: `${y}-${String(m).padStart(2, "0")}`, label: `${n} ${String(y).slice(2)}` };
  });
}
