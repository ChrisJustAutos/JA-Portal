// lib/workshop-map/build-payload.ts
// Turns classified + geocoded MD invoice/quote rows into the per-FY JSON the
// Map & Conversion dashboard consumes (same structure the static
// JA_FY2026_Workshop_Dashboard.html embeds). Pure — no I/O; the GH Actions
// worker calls this and POSTs the result to /api/workshop/map/ingest, which
// caches it verbatim for the read API.

import {
  VEHICLE_CATS, VehicleGroup, bestChassis, dedupLargestPerCustomerMonth, fyMonths,
} from './vehicle-classification'

export interface MapInvoiceRow {
  invoiceNumber: string
  customerId: string | null
  customerName: string | null
  suburb: string | null
  state: string | null
  postcode: string | null
  vehicleId: string | null
  rego: string | null
  jobTypeText: string | null
  descText: string | null
  itemsText: string | null
  issueDate: string | null          // YYYY-MM-DD
  totalAmount: number
  // computed at ingest:
  group: VehicleGroup
  inferred: boolean
  isNoise: boolean
  lat: number | null
  lng: number | null
  locality: string | null
  month: string | null              // YYYY-MM
  monthIndex: number | null         // 0–11 within FY (Jul=0)
  fy: number | null
}

export interface MapQuoteRow {
  quoteNumber: string
  customerId: string | null
  customerName: string | null
  suburb: string | null
  state: string | null
  postcode: string | null
  rego: string | null
  model: string | null
  descText: string | null
  itemsText: string | null
  quoteDate: string | null
  totalAmount: number
  status: string | null
  won: boolean
  group: VehicleGroup
  inferred: boolean
  lat: number | null
  lng: number | null
  locality: string | null
  month: string | null
  monthIndex: number | null
  fy: number | null
}

// Point keys are intentionally short (payload size): la/ln lat/lng, pc postcode,
// l locality, m month index, g group, c customer, a amount, j job-type label,
// i invoice/quote number, x inferred flag (jobs), w won flag (quotes).
export interface MapPayload {
  fy: number
  months: { k: string; label: string }[]
  cats: typeof VEHICLE_CATS
  jobs: {
    points: any[]
    meta: { customers: number; mapped: number; clean_total: number; inferred: number }
  }
  quotes: {
    points: any[]
    meta: { total_quotes: number; mapped: number; total_value: number }
  }
  conv: {
    qcount: Record<string, number[]>
    qval: Record<string, number[]>
    jcount: Record<string, number[]>
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function buildFyPayload(fy: number, invoices: MapInvoiceRow[], quotes: MapQuoteRow[]): MapPayload {
  const months = fyMonths(fy)

  // Jobs = non-noise invoices in this FY, deduped 1 per (customer, month).
  const clean = invoices.filter(r => r.fy === fy && !r.isNoise && r.month && r.monthIndex != null)
  const dedupJobs = dedupLargestPerCustomerMonth(
    clean.map(r => ({ customerId: r.customerId, month: r.month!, amount: r.totalAmount, row: r })),
  ).map(d => d.row)

  const jobPoints = dedupJobs.filter(r => r.lat != null && r.lng != null).map(r => {
    const p: any = {
      la: r.lat, ln: r.lng, pc: r.postcode || '', l: r.locality || r.suburb || '',
      m: r.monthIndex, g: r.group, c: r.customerName || '', a: r2(r.totalAmount),
      j: (r.jobTypeText || '').slice(0, 38), i: r.invoiceNumber,
    }
    if (r.inferred) p.x = 1
    return p
  })

  // Quotes are NOT noise-filtered — dedup only.
  const fyQuotes = quotes.filter(r => r.fy === fy && r.month && r.monthIndex != null)
  const dedupQuotes = dedupLargestPerCustomerMonth(
    fyQuotes.map(r => ({ customerId: r.customerId, month: r.month!, amount: r.totalAmount, row: r })),
  ).map(d => d.row)

  const quotePoints = dedupQuotes.filter(r => r.lat != null && r.lng != null).map(r => {
    const p: any = {
      la: r.lat, ln: r.lng, pc: r.postcode || '', l: r.locality || r.suburb || '',
      m: r.monthIndex, g: r.group, c: r.customerName || '', a: r2(r.totalAmount),
      i: r.quoteNumber,
    }
    if (r.won) p.w = 1
    if (r.inferred) p.x = 1
    return p
  })

  // Conversion: independent per-vehicle per-month counts over the deduped sets.
  const zeros = () => Array(12).fill(0) as number[]
  const qcount: Record<string, number[]> = {}, qval: Record<string, number[]> = {}, jcount: Record<string, number[]> = {}
  for (const c of VEHICLE_CATS) { qcount[c.k] = zeros(); qval[c.k] = zeros(); jcount[c.k] = zeros() }
  for (const q of dedupQuotes) { qcount[q.group][q.monthIndex!]++; qval[q.group][q.monthIndex!] += q.totalAmount }
  for (const j of dedupJobs) jcount[j.group][j.monthIndex!]++
  for (const c of VEHICLE_CATS) qval[c.k] = qval[c.k].map(r2)

  return {
    fy,
    months,
    cats: VEHICLE_CATS,
    jobs: {
      points: jobPoints,
      meta: {
        customers: dedupJobs.length,
        mapped: jobPoints.length,
        clean_total: clean.length,
        inferred: dedupJobs.filter(r => r.inferred).length,
      },
    },
    quotes: {
      points: quotePoints,
      meta: {
        total_quotes: dedupQuotes.length,
        mapped: quotePoints.length,
        total_value: r2(dedupQuotes.reduce((s, r) => s + r.totalAmount, 0)),
      },
    },
    conv: { qcount, qval, jcount },
  }
}

/**
 * §7 acceptance check: no record where the First-Job-Type chassis code
 * disagrees with the assigned group (the historical "VDJ79 under 200" bug).
 * Returns the offending rows (empty = pass).
 */
export function chassisMismatches(rows: { jobTypeText?: string | null; group: string; ref: string }[]): { ref: string; jobChassis: string; group: string }[] {
  const bad: { ref: string; jobChassis: string; group: string }[] = []
  for (const r of rows) {
    const ch = bestChassis(r.jobTypeText)
    if (ch && ch !== r.group) bad.push({ ref: r.ref, jobChassis: ch, group: r.group })
  }
  return bad
}
