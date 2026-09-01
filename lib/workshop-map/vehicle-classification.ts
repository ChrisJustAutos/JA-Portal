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
// VIN → series
// ----------------------------------------------------------------------------
// Distributor invoices carry the VIN in the MYOB PO-number field, which is how
// a distributor tune becomes a countable job on the Workshop Map. Unlike
// bestChassis() there is no chassis code to read here — the series has to come
// out of the VIN itself.
//
// The rules below were derived from, and are checked against, the real PO-number
// universe (scripts/check-vin-series.ts cross-validates every VIN against the
// independent `tune_details` text on b2b_tune_jobs). They match on the VDS
// characters rather than whole 8-char prefixes, so a new plate-year doesn't
// silently fall out.
//
//   JTMAA…            → 300     (LC300)
//   JTM[HG]V…         → 200     (LC200 wagon)
//   ␣␣␣x{V7|VL|RL|R7} → 70      (VDJ/GDJ 70-series, incl. the TW1 plate)
//   JTE..3F… / JTEAC… → PRADO   (150/Gen2-3, and 250)
//   (MR0|AHT|8AJ)x[ABE]3… → HILUX (N80)
//
// Anything else is OTH — deliberately visible rather than dropped, so an
// unrecognised model shows up as a number to chase instead of vanishing.

/** Normalise a PO/VIN string: trim, upper, and repair the O-for-zero typo in
 *  the Thai WMI (MRO → MR0), which is the one transcription error that occurs. */
export function normaliseVin(raw?: string | null): string {
  return String(raw ?? '').trim().toUpperCase().replace(/^MRO/, 'MR0')
}

/** True when the string is a structurally valid 17-character VIN. A real VIN
 *  never contains I, O or Q. This is what separates a VIN PO number from a
 *  stock order or a customer name that happens to be 17 characters long. */
export function isVin(raw?: string | null): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(normaliseVin(raw))
}

/** Series for a VIN, or null when it isn't a VIN at all. Unrecognised VINs
 *  return "OTH" — distinguishable from null, so callers can count them. */
export function seriesFromVin(raw?: string | null): VehicleGroup | null {
  const v = normaliseVin(raw)
  if (!isVin(v)) return null
  const vds = v.slice(4, 6)                       // the two chars that carry the model
  if (v.startsWith('JTMAA')) return '300'
  if (/^JTM[HG]V/.test(v)) return '200'
  if (vds === 'V7' || vds === 'VL' || vds === 'RL' || vds === 'R7') return '70'
  if (/^JTE..3F/.test(v) || v.startsWith('JTEAC')) return 'PRADO'
  if (/^(MR0|AHT|8AJ)[A-Z][ABE]3/.test(v)) return 'HILUX'
  return 'OTH'
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
/**
 * Group quotes by customer+month and AVERAGE their value (Chris 2026-09-01:
 * "Can we average the quote value out rather than the highest value").
 *
 * Still ONE entry per customer per month - the workshop re-quotes the same job
 * (revisions, changed spec, a follow-up), so counting each one inflates the
 * quote count and the conversion denominator. What changes is the VALUE: three
 * quotes at $4k / $9k / $12k now read $8,333 rather than $12k.
 *
 * The REPRESENTATIVE row is still the largest quote, so the pin location, the
 * vehicle group, the quote number, the date and the won flag are unchanged -
 * only the amount moves. `count` is returned so the map can say what the
 * average is over, rather than showing a number that matches no single quote.
 */
export function dedupAveragePerCustomerMonth<T extends { customerId?: string | null; month: string; amount: number }>(
  rows: T[],
): { row: T; amount: number; count: number }[] {
  const groups: Record<string, T[]> = {};
  for (const r of rows) {
    const key = `${r.customerId ?? "?"}|${r.month}`;
    (groups[key] ||= []).push(r);
  }
  return Object.values(groups).map((g) => {
    let rep = g[0];
    for (const r of g) if (r.amount > rep.amount) rep = r;
    const total = g.reduce((s, r) => s + r.amount, 0);
    return { row: rep, amount: total / g.length, count: g.length };
  });
}

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
/**
 * REGIONS people type instead of a suburb, mapped to a representative locality.
 *
 * "Gold Coast" is not a suburb and never will be in the postcode dataset, but a
 * customer there is a real customer in a real place - dropping them off the map
 * loses a genuine data point (Chris 2026-09-01: "Recover as many as we can and
 * place"). Each maps to the recognised centre of that region, so the pin is
 * approximately right rather than absent.
 *
 * DELIBERATELY NOT HERE: bare states ("VIC", "TASMANIA") and overseas towns. A
 * pin in the geographic middle of Victoria implies a precision the data does
 * not have, and an overseas address cannot sit on an Australian map at all.
 * Those stay unplaced - and, since 2026-09-01, still count in the totals.
 */
const REGION_ALIASES: Record<string, string> = {
  "GOLD COAST": "SOUTHPORT", "GOLDCOAST": "SOUTHPORT",
  "SUNSHINE COAST": "MAROOCHYDORE", "NOOSA": "NOOSA HEADS",
  "CENTRAL COAST": "GOSFORD", "NORTHERN BEACHES": "MANLY",
  "SUTHERLAND SHIRE": "SUTHERLAND", "WESTERN SYDNEY": "PARRAMATTA",
  "NW SYDNEY": "BLACKTOWN", "NORTH WEST MELBOURNE": "MELBOURNE",
  "CENTRAL SYDNEY": "SYDNEY", "SOUTH SYDNEY": "MASCOT",
  "BLUE MOUNTAINS": "KATOOMBA", "SOUTHERN HIGHLANDS": "BOWRAL",
  "LAKE MACQUARIE": "SPEERS POINT", "ADELAIDE HILLS": "STIRLING",
  "YARRA VALLEY": "HEALESVILLE", "MORNINGTON PENINSULA": "MORNINGTON",
  "GIPPSLAND": "TRARALGON", "SOUTH GIPPSLAND": "LEONGATHA",
  "PHILLIP ISLAND": "COWES", "YORKE PENINSULA": "MINLATON",
  "LOCKYER VALLEY": "GATTON", "NORTH BRISBANE": "CHERMSIDE",
  "CAPE YORK": "WEIPA", "PILBARA": "KARRATHA",
  "WHITSUNDAYS": "AIRLIE BEACH", "WHIT SUNDAYS": "AIRLIE BEACH",
  "COFFS": "COFFS HARBOUR", "NORTHERN NSW": "LISMORE",
};

/**
 * Values that are NOT a suburb and must never be fuzzy-matched into one.
 * States, countries and "no fixed address" answers. Without this "VICTORIA"
 * lands on Vittoria NSW and "TASMANIA" on something equally arbitrary.
 */
const NEVER_A_SUBURB = new Set([
  "NSW", "QLD", "VIC", "TAS", "WA", "SA", "NT", "ACT",
  "NEW SOUTH WALES", "QUEENSLAND", "VICTORIA", "TASMANIA",
  "WESTERN AUSTRALIA", "SOUTH AUSTRALIA", "NORTHERN TERRITORY",
  "AUSTRALIAN CAPITAL TERRITORY", "AUSTRALIA",
  "TRAVELLING", "TRAVEL FULL TIME", "FULL TIME TRAVELLING", "TRAVELLING FULL TIME",
  "UNITED STATES OF AMERICA", "USA", "NEW ZEALAND", "UNKNOWN", "N/A",
]);

/** Levenshtein, bounded - only used to rescue a misspelt suburb. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Spelling variants worth trying before giving up on an exact match. */
function suburbVariants(sk: string): string[] {
  const out = new Set<string>();
  const base = sk.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  out.add(base);
  out.add(base.replace(/^MT\s+/, "MOUNT "));
  out.add(base.replace(/^MOUNT\s+/, "MT "));
  out.add(base.replace(/^SAINT\s+/, "ST "));
  out.add(base.replace(/^ST\s+/, "SAINT "));
  out.add(base.replace(/-/g, " "));
  out.add(base.replace(/\s/g, "-"));
  out.add(base.replace(/\s/g, ""));
  return Array.from(out).filter(Boolean);
}

export function geocode(
  postcode: string | null | undefined,
  suburb: string | null | undefined,
  postcodeMap: Record<string, LatLng>,      // key: 4-digit postcode
  suburbMap: Record<string, LatLng>,        // key: UPPER(suburb) (avg of matching localities)
): LatLng | null {
  const pc = (postcode ?? "").match(/\d{3,4}/)?.[0]?.padStart(4, "0");
  if (pc && postcodeMap[pc]) return postcodeMap[pc];

  const sk = (suburb ?? "").toUpperCase().trim();
  if (!sk) return null;
  if (suburbMap[sk]) return suburbMap[sk];

  // A postcode typed into the suburb box ("2456", "PO BOX 703 BEENLEIGH QLD
  // 4207"). Try EVERY 3-4 digit run and take the first that is a real
  // postcode - "703" in that example is not, "4207" is, and taking the first
  // match blindly would geocode the PO box number.
  for (const m of sk.match(/\d{3,4}/g) || []) {
    const cand = m.padStart(4, "0");
    if (postcodeMap[cand]) return postcodeMap[cand];
  }

  // Formatting differences: MT/MOUNT, SAINT/ST, hyphen vs space vs nothing.
  for (const v of suburbVariants(sk)) if (suburbMap[v]) return suburbMap[v];

  // A region typed instead of a suburb.
  const region = REGION_ALIASES[sk] || REGION_ALIASES[sk.replace(/[.,]/g, "").replace(/\s+/g, " ").trim()];
  if (region && suburbMap[region]) return suburbMap[region];

  // A name that is a state, a country or "no fixed address" must NEVER reach
  // the fuzzy pass. Left to it, "VICTORIA" matched Vittoria NSW - a real pin,
 // confidently in the wrong place, which is worse than no pin at all.
  if (NEVER_A_SUBURB.has(sk)) return null;

  // Prefix match before fuzzy, in BOTH directions, and only when unique:
  //   "COOLUM"         -> "COOLUM BEACH"  (the dataset name is longer)
  //   "WOODGATE BEACH" -> "WOODGATE"      (the typed name is longer)
  // This has to come first: COOLUM is one edit from COOLUP in WA, so the fuzzy
  // pass would have put a Sunshine Coast customer in Western Australia.
  {
    let best: string | null = null, ties = 0;
    for (const key in suburbMap) {
      if (key.startsWith(sk + " ") || sk.startsWith(key + " ")) { best = best ?? key; ties++; }
    }
    if (best && ties === 1) return suburbMap[best];
  }

  // Last resort: a misspelling within one or two edits of exactly ONE suburb.
  // Requires 6+ characters (shorter names collide too easily) and a UNIQUE
  // winner - two candidates at the same distance means we do not know which,
  // and a wrong pin is worse than no pin.
  if (sk.length >= 6) {
    const limit = sk.length >= 8 ? 2 : 1;
    let best: string | null = null, bestD = 99, ties = 0;
    for (const key in suburbMap) {
      if (Math.abs(key.length - sk.length) > limit) continue;
      const d = editDistance(key, sk);
      if (d < bestD) { bestD = d; best = key; ties = 1; }
      else if (d === bestD) ties++;
    }
    if (best && bestD <= limit && ties === 1) return suburbMap[best];
  }

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
