// lib/workshop-map/build-payload.ts
// Turns classified + geocoded MD invoice/quote rows into the per-FY JSON the
// Map & Conversion dashboard consumes (same structure the static
// JA_FY2026_Workshop_Dashboard.html embeds). Pure — no I/O; the GH Actions
// worker calls this and POSTs the result to /api/workshop/map/ingest, which
// caches it verbatim for the read API.

import {
  VEHICLE_CATS, VehicleGroup, bestChassis, dedupLargestPerCustomerMonth, dedupAveragePerCustomerMonth, fyMonths,
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
// i invoice/quote number, d issue/quote date (YYYY-MM-DD), x inferred flag
// (jobs), w won flag (quotes).
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

  // Jobs = non-noise invoices in this FY, grouped 1 point per (customer, month)
  // like before — but the point's amount is now the SUM of every invoice in
  // that month plus the customer's booking deposit(s), so a dot reflects the
  // customer's full spend (Chris 2026-08-19; previously only the largest
  // invoice survived and deposits were dropped entirely). The largest invoice
  // stays the representative row for location/vehicle/job-type display.
  // Invoices with no customer id stay individual — merging all anonymous
  // invoices in a month into one dot would fabricate a mega-customer.
  const clean = invoices.filter(r => r.fy === fy && !r.isNoise && r.month && r.monthIndex != null)
  interface JobGroup { rep: MapInvoiceRow; amount: number; jobs: number; firstDate: string }
  const groups = new Map<string, JobGroup>()
  for (const r of clean) {
    const key = r.customerId ? `${r.customerId}|${r.month}` : `anon|${r.invoiceNumber}`
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { rep: r, amount: r.totalAmount, jobs: 1, firstDate: r.issueDate || '' })
    } else {
      g.amount += r.totalAmount
      g.jobs++
      if (r.totalAmount > g.rep.totalAmount) g.rep = r
      if (r.issueDate && (!g.firstDate || r.issueDate < g.firstDate)) g.firstDate = r.issueDate
    }
  }

  // Booking deposits (noise rows, description says "deposit" — NEVER match
  // itemsText: big jobs list a Deposit job type) fold into the customer's
  // first job group on/after the deposit date. A deposit whose job hasn't
  // happened yet stays unapplied — the dashboard shows those as a separate
  // "awaiting jobs" sub-line from the read API.
  const byCust = new Map<string, JobGroup[]>()
  for (const g of Array.from(groups.values())) {
    if (!g.rep.customerId) continue
    const list = byCust.get(g.rep.customerId) || []
    list.push(g)
    byCust.set(g.rep.customerId, list)
  }
  for (const list of Array.from(byCust.values())) list.sort((a: JobGroup, b: JobGroup) => a.firstDate.localeCompare(b.firstDate))
  const isDeposit = (r: MapInvoiceRow) => r.isNoise && /deposit/i.test(r.descText || '') && r.totalAmount > 0
  for (const d of invoices) {
    if (d.fy !== fy || !isDeposit(d) || !d.customerId || !d.issueDate) continue
    const target = (byCust.get(d.customerId) || []).find(g => g.firstDate >= d.issueDate!)
    if (target) target.amount += d.totalAmount
  }

  const dedupJobs = Array.from(groups.values())
  const jobPoints = dedupJobs.filter(g => g.rep.lat != null && g.rep.lng != null).map(g => {
    const r = g.rep
    const p: any = {
      la: r.lat, ln: r.lng, pc: r.postcode || '', l: r.locality || r.suburb || '',
      m: r.monthIndex, g: r.group, c: r.customerName || '', a: r2(g.amount),
      j: (r.jobTypeText || '').slice(0, 38), i: r.invoiceNumber,
      d: r.issueDate || g.firstDate || '',
    }
    if (r.inferred) p.x = 1
    return p
  })

  // Quotes are NOT noise-filtered — dedup only.
  //
  // ONE entry per customer per month, valued at the AVERAGE of that customer's
  // quotes in the month (Chris 2026-09-01 — it used to take the largest). The
  // workshop re-quotes the same job, so counting each one would inflate both
  // the quote count and the conversion denominator; averaging keeps the count
  // honest without letting one big revision set the value. The representative
  // row is still the largest quote, so the pin, vehicle group, quote number,
  // date and won flag are exactly as before — only the amount moves.
  const fyQuotes = quotes.filter(r => r.fy === fy && r.month && r.monthIndex != null)
  const quoteGroups = dedupAveragePerCustomerMonth(
    fyQuotes.map(r => ({ customerId: r.customerId, month: r.month!, amount: r.totalAmount, row: r })),
  )
  // Override totalAmount on the representative so EVERY downstream figure —
  // the pin, total_value and the conversion chart's qval — reads the average.
  // They all derive from this one array, so they cannot disagree.
  const dedupQuotes: (MapQuoteRow & { quoteCount: number })[] = quoteGroups.map(g => ({
    ...g.row.row, totalAmount: r2(g.amount), quoteCount: g.count,
  }))

  // EVERY deduped quote becomes a point, geocoded or not (Chris 2026-09-01:
  // "Unknown should be in the All AU total and Quotes inc GST total — they are
  // still quotes, just can't be placed on the map"). Un-geocoded points carry
  // la/ln = null: the dashboard skips them when drawing markers and counting
  // locations, but they COUNT in every total. Before this they were dropped
  // from the payload entirely, so the headline understated quoted value by
  // roughly 8%.
  const quotePoints = dedupQuotes.map(r => {
    const p: any = {
      la: r.lat ?? null, ln: r.lng ?? null, pc: r.postcode || '', l: r.locality || r.suburb || '',
      m: r.monthIndex, g: r.group, c: r.customerName || '', a: r2(r.totalAmount),
      i: r.quoteNumber, d: r.quoteDate || '',
    }
    // How many quotes the average is over. Omitted when it's a single quote,
    // so the map only qualifies the number when it needs qualifying.
    if (r.quoteCount > 1) p.n = r.quoteCount
    if (r.won) p.w = 1
    if (r.inferred) p.x = 1
    return p
  })

  // Conversion: independent per-vehicle per-month counts over the deduped sets.
  const zeros = () => Array(12).fill(0) as number[]
  const qcount: Record<string, number[]> = {}, qval: Record<string, number[]> = {}, jcount: Record<string, number[]> = {}
  for (const c of VEHICLE_CATS) { qcount[c.k] = zeros(); qval[c.k] = zeros(); jcount[c.k] = zeros() }
  for (const q of dedupQuotes) { qcount[q.group][q.monthIndex!]++; qval[q.group][q.monthIndex!] += q.totalAmount }
  for (const j of dedupJobs) jcount[j.rep.group][j.rep.monthIndex!]++
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
        inferred: dedupJobs.filter(g => g.rep.inferred).length,
      },
    },
    quotes: {
      points: quotePoints,
      meta: {
        total_quotes: dedupQuotes.length,
        mapped: quotePoints.filter(p => p.la != null && p.ln != null).length,
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
