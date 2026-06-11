// lib/workshop-reports.ts
// Server-side aggregation for the Workshop Reports screen (MD-parity):
// daily sales, received payments, WIP, income summary, stock, technician
// productivity. All reports return one generic { kpis, columns, rows } shape
// so the page renders a single table component and CSV export is a plain map.
// Data volumes are single-workshop scale, so rows are fetched via supabase-js
// (paged past the 1000-row cap) and aggregated in JS — same approach as
// pages/api/workshop/invoices/index.ts.

import { SupabaseClient } from '@supabase/supabase-js'
import { brisbaneDayBounds, bookingDurationMin, ymdBrisbane, addDaysYmd, vehicleLabel, customerLabel, PAYMENT_TENDERS, PaymentTender, BOOKING_STATUS_META, BookingStatus } from './workshop'

export type WorkshopReportType = 'daily_sales' | 'received_payments' | 'bookings_won' | 'wip' | 'income_summary' | 'stock' | 'tech_productivity'

export const WORKSHOP_REPORT_TYPES: { id: WorkshopReportType; label: string; dateless?: boolean }[] = [
  { id: 'daily_sales',       label: 'Daily sales' },
  { id: 'received_payments', label: 'Received payments' },
  { id: 'bookings_won',      label: 'Bookings won' },
  { id: 'wip',               label: 'Work in progress', dateless: true },
  { id: 'income_summary',    label: 'Income summary' },
  { id: 'stock',             label: 'Stock', dateless: true },
  { id: 'tech_productivity', label: 'Technicians' },
]

export interface ReportKpi { label: string; value: string; accent?: string }
export interface ReportColumn { key: string; label: string; align?: 'left' | 'right'; money?: boolean }
// chart: optional per-row bar values the page renders as a bar graph above
// the table (label shown on hover/axis, value = bar height).
export interface ReportResult { kpis: ReportKpi[]; columns: ReportColumn[]; rows: Record<string, any>[]; chart?: { label: string; value: number }[] }

const round2 = (n: number) => Math.round(n * 100) / 100
const $ = (n: number) => `$${round2(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Page past Supabase's 1000-row-per-request cap.
async function pageAll<T = any>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const page = 1000
  const all: T[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await make(from, from + page - 1)
    if (error) throw new Error(error.message || 'query failed')
    if (!data || !data.length) break
    all.push(...data)
    if (data.length < page) break
  }
  return all
}

function rangeBounds(fromYmd: string, toYmd: string) {
  return { fromIso: brisbaneDayBounds(fromYmd).fromIso, toIso: brisbaneDayBounds(toYmd).toIso }
}

const lineEx = (l: any) => l.total_ex_gst != null ? Number(l.total_ex_gst) : (Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0)

export async function runWorkshopReport(db: SupabaseClient, type: WorkshopReportType, fromYmd: string, toYmd: string): Promise<ReportResult> {
  switch (type) {
    case 'daily_sales':       return dailySales(db, fromYmd, toYmd)
    case 'received_payments': return receivedPayments(db, fromYmd, toYmd)
    case 'bookings_won':      return bookingsWon(db, fromYmd, toYmd)
    case 'wip':               return wip(db)
    case 'income_summary':    return incomeSummary(db, fromYmd, toYmd)
    case 'stock':             return stock(db)
    case 'tech_productivity': return techProductivity(db, fromYmd, toYmd)
    default: throw new Error('unknown report type')
  }
}

// ── Bookings won — new bookings created per day (quotes won / work booked) ──
// Counts by the day the booking was CREATED (not its diary slot), so it reads
// as "how much work did we win each day". Cancelled / no-show excluded.
async function bookingsWon(db: SupabaseClient, fromYmd: string, toYmd: string): Promise<ReportResult> {
  const { fromIso, toIso } = rangeBounds(fromYmd, toYmd)
  const bookings = await pageAll((a, b) => db.from('workshop_bookings')
    .select('id, created_at, status, estimated_value, total_inc_gst')
    .gte('created_at', fromIso).lt('created_at', toIso)
    .not('status', 'in', '(cancelled,no_show)')
    .order('created_at').range(a, b))

  // Seed every day in the range so quiet days show as zero bars (cap ~1 year).
  const byDay: Record<string, { count: number; value: number }> = {}
  for (let ymd = fromYmd; ymd <= toYmd && Object.keys(byDay).length < 370; ymd = addDaysYmd(ymd, 1)) {
    byDay[ymd] = { count: 0, value: 0 }
  }
  for (const bk of bookings as any[]) {
    const ymd = ymdBrisbane(new Date(bk.created_at))
    const d = (byDay[ymd] ||= { count: 0, value: 0 })
    d.count++
    d.value += Number(bk.estimated_value) || Number(bk.total_inc_gst) || 0
  }

  const days = Object.keys(byDay).sort()
  const rows = days.map(ymd => ({
    day: new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Australia/Brisbane' }),
    bookings: byDay[ymd].count,
    est_value: round2(byDay[ymd].value),
  }))
  const totalCount = days.reduce((s, d) => s + byDay[d].count, 0)
  const totalValue = round2(days.reduce((s, d) => s + byDay[d].value, 0))
  const activeDays = Math.max(1, days.length)
  return {
    kpis: [
      { label: 'Bookings won', value: String(totalCount) },
      { label: 'Est. value', value: $(totalValue) },
      { label: 'Avg / day', value: (totalCount / activeDays).toFixed(1) },
    ],
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'bookings', label: 'Bookings', align: 'right' },
      { key: 'est_value', label: 'Est. value', align: 'right', money: true },
    ],
    rows,
    chart: days.map(ymd => ({
      label: `${new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Australia/Brisbane' })} — ${byDay[ymd].count} booking${byDay[ymd].count === 1 ? '' : 's'}`,
      value: byDay[ymd].count,
    })),
  }
}

// ── Daily sales — invoiced totals by day + takings by tender (MD style) ──
async function dailySales(db: SupabaseClient, fromYmd: string, toYmd: string): Promise<ReportResult> {
  const { fromIso, toIso } = rangeBounds(fromYmd, toYmd)
  const [bookings, invoices, payments] = await Promise.all([
    pageAll((a, b) => db.from('workshop_bookings')
      .select('id, completed_at, total_ex_gst, total_inc_gst')
      .in('status', ['invoiced', 'paid'])
      .gte('completed_at', fromIso).lt('completed_at', toIso)
      .order('completed_at').range(a, b)),
    pageAll((a, b) => db.from('workshop_invoices')
      .select('id, booking_id, subtotal, gst, total, created_at')
      .is('deleted_at', null)
      .gte('created_at', fromIso).lt('created_at', toIso)
      .order('created_at').range(a, b)),
    pageAll((a, b) => db.from('workshop_payments')
      .select('amount, tender, created_at, deleted_at')
      .gte('created_at', fromIso).lt('created_at', toIso)
      .order('created_at').range(a, b)),
  ])

  // A job invoiced via MYOB push gets a workshop_invoices row; a manual status
  // flip doesn't. Prefer the invoice row, count the booking only if no row.
  const invoicedBookingIds = new Set(invoices.map((i: any) => i.booking_id).filter(Boolean))
  type DayAgg = { count: number; ex: number; gst: number; inc: number; tenders: Record<string, number> }
  const days = new Map<string, DayAgg>()
  const day = (ymd: string): DayAgg => {
    let d = days.get(ymd)
    if (!d) { d = { count: 0, ex: 0, gst: 0, inc: 0, tenders: {} }; days.set(ymd, d) }
    return d
  }
  for (const inv of invoices as any[]) {
    const d = day(ymdBrisbane(new Date(inv.created_at)))
    d.count += 1; d.ex += Number(inv.subtotal) || 0; d.gst += Number(inv.gst) || 0; d.inc += Number(inv.total) || 0
  }
  for (const b of bookings as any[]) {
    if (invoicedBookingIds.has(b.id)) continue
    const inc = Number(b.total_inc_gst) || 0, ex = Number(b.total_ex_gst) || 0
    const d = day(ymdBrisbane(new Date(b.completed_at)))
    d.count += 1; d.ex += ex; d.gst += inc - ex; d.inc += inc
  }
  for (const p of payments as any[]) {
    if (p.deleted_at) continue
    const d = day(ymdBrisbane(new Date(p.created_at)))
    d.tenders[p.tender || 'other'] = (d.tenders[p.tender || 'other'] || 0) + (Number(p.amount) || 0)
  }

  const tendersUsed = PAYMENT_TENDERS.filter(t => Array.from(days.values()).some(d => d.tenders[t.id]))
  const rows = Array.from(days.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([ymd, d]) => ({
    day: ymd, count: d.count, ex: round2(d.ex), gst: round2(d.gst), inc: round2(d.inc),
    ...Object.fromEntries(tendersUsed.map(t => [`t_${t.id}`, round2(d.tenders[t.id] || 0)])),
  }))
  const totInc = rows.reduce((s, r) => s + r.inc, 0)
  const totCount = rows.reduce((s, r) => s + r.count, 0)
  return {
    kpis: [
      { label: 'Invoiced (inc GST)', value: $(totInc), accent: 'green' },
      { label: 'Invoices', value: String(totCount) },
      { label: 'Avg invoice', value: totCount ? $(totInc / totCount) : '—' },
      { label: 'GST collected', value: $(rows.reduce((s, r) => s + r.gst, 0)) },
    ],
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'count', label: 'Invoices', align: 'right' },
      { key: 'ex', label: 'Ex GST', align: 'right', money: true },
      { key: 'gst', label: 'GST', align: 'right', money: true },
      { key: 'inc', label: 'Inc GST', align: 'right', money: true },
      ...tendersUsed.map(t => ({ key: `t_${t.id}`, label: t.label, align: 'right' as const, money: true })),
    ],
    rows,
  }
}

// ── Received payments — day × tender ─────────────────────────────────────
async function receivedPayments(db: SupabaseClient, fromYmd: string, toYmd: string): Promise<ReportResult> {
  const { fromIso, toIso } = rangeBounds(fromYmd, toYmd)
  const payments = await pageAll((a, b) => db.from('workshop_payments')
    .select('amount, tender, created_at, deleted_at')
    .gte('created_at', fromIso).lt('created_at', toIso)
    .order('created_at').range(a, b))

  const days = new Map<string, Record<string, number>>()
  let received = 0, refunds = 0
  for (const p of payments as any[]) {
    if (p.deleted_at) continue
    const amt = Number(p.amount) || 0
    if (amt >= 0) received += amt; else refunds += -amt
    const ymd = ymdBrisbane(new Date(p.created_at))
    const d = days.get(ymd) || {}
    const tender: PaymentTender = (p.tender || 'other')
    d[tender] = (d[tender] || 0) + amt
    days.set(ymd, d)
  }
  const tendersUsed = PAYMENT_TENDERS.filter(t => Array.from(days.values()).some(d => d[t.id]))
  const rows = Array.from(days.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([ymd, d]) => {
    const total = tendersUsed.reduce((s, t) => s + (d[t.id] || 0), 0)
    return { day: ymd, ...Object.fromEntries(tendersUsed.map(t => [`t_${t.id}`, round2(d[t.id] || 0)])), total: round2(total) }
  })
  return {
    kpis: [
      { label: 'Received', value: $(received), accent: 'green' },
      { label: 'Refunds', value: refunds ? `−${$(refunds)}` : '$0.00', accent: refunds ? 'red' : undefined },
      { label: 'Net', value: $(received - refunds) },
    ],
    columns: [
      { key: 'day', label: 'Day' },
      ...tendersUsed.map(t => ({ key: `t_${t.id}`, label: t.label, align: 'right' as const, money: true })),
      { key: 'total', label: 'Total', align: 'right', money: true },
    ],
    rows,
  }
}

// ── WIP — open jobs with estimated vs actual value ───────────────────────
const WIP_STATUSES: BookingStatus[] = ['booking', 'confirmed', 'in_progress', 'awaiting_parts', 'ready', 'done']
async function wip(db: SupabaseClient): Promise<ReportResult> {
  const bookings = await pageAll((a, b) => db.from('workshop_bookings')
    .select(`id, starts_at, status, job_type, estimated_value, technician_ext,
             customer:workshop_customers(id, name, first_name, last_name),
             vehicle:workshop_vehicles(id, rego, make, model, year),
             lines:workshop_booking_lines(qty, unit_price_ex_gst, total_ex_gst)`)
    .in('status', WIP_STATUSES)
    .order('starts_at').range(a, b))

  const now = Date.now()
  const rows = (bookings as any[]).map(b => {
    const actualEx = (b.lines || []).reduce((s: number, l: any) => s + lineEx(l), 0)
    return {
      id: b.id,
      status: BOOKING_STATUS_META[b.status as BookingStatus]?.label || b.status,
      customer: customerLabel(b.customer),
      vehicle: vehicleLabel(b.vehicle),
      job_type: b.job_type || '',
      tech: b.technician_ext || '',
      est: round2(Number(b.estimated_value) || 0),
      actual: round2(actualEx * 1.1),
      age_days: Math.max(0, Math.floor((now - new Date(b.starts_at).getTime()) / 86400000)),
    }
  })
  return {
    kpis: [
      { label: 'Open jobs', value: String(rows.length) },
      { label: 'Estimated value', value: $(rows.reduce((s, r) => s + r.est, 0)) },
      { label: 'Actual on job cards (inc GST)', value: $(rows.reduce((s, r) => s + r.actual, 0)), accent: 'amber' },
    ],
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'customer', label: 'Customer' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'job_type', label: 'Job type' },
      { key: 'tech', label: 'Tech' },
      { key: 'est', label: 'Est value', align: 'right', money: true },
      { key: 'actual', label: 'Actual inc GST', align: 'right', money: true },
      { key: 'age_days', label: 'Age (days)', align: 'right' },
    ],
    rows,
  }
}

// ── Income summary — labour/parts/sublet/fee split over invoiced jobs ────
async function incomeSummary(db: SupabaseClient, fromYmd: string, toYmd: string): Promise<ReportResult> {
  const { fromIso, toIso } = rangeBounds(fromYmd, toYmd)
  const bookings = await pageAll((a, b) => db.from('workshop_bookings')
    .select('id, completed_at, lines:workshop_booking_lines(line_type, qty, unit_price_ex_gst, total_ex_gst, gst_rate)')
    .in('status', ['invoiced', 'paid'])
    .gte('completed_at', fromIso).lt('completed_at', toIso)
    .range(a, b))

  const byType = new Map<string, { ex: number; gst: number }>()
  for (const b of bookings as any[]) {
    for (const l of b.lines || []) {
      const ex = lineEx(l)
      const gst = ex * (l.gst_rate != null ? Number(l.gst_rate) : 0.10)
      const t = byType.get(l.line_type || 'fee') || { ex: 0, gst: 0 }
      t.ex += ex; t.gst += gst
      byType.set(l.line_type || 'fee', t)
    }
  }
  const totalEx = Array.from(byType.values()).reduce((s, t) => s + t.ex, 0)
  const TYPE_LABELS: Record<string, string> = { labour: 'Labour', part: 'Parts', sublet: 'Sublet', fee: 'Fees / other' }
  const rows = ['labour', 'part', 'sublet', 'fee']
    .filter(t => byType.has(t))
    .map(t => {
      const v = byType.get(t)!
      return { type: TYPE_LABELS[t] || t, ex: round2(v.ex), gst: round2(v.gst), inc: round2(v.ex + v.gst), pct: totalEx ? `${(v.ex / totalEx * 100).toFixed(1)}%` : '—' }
    })
  return {
    kpis: [
      { label: 'Income ex GST', value: $(totalEx), accent: 'green' },
      { label: 'Inc GST', value: $(rows.reduce((s, r) => s + r.inc, 0)) },
      { label: 'Invoiced jobs', value: String((bookings as any[]).length) },
      { label: 'Labour share', value: totalEx && byType.get('labour') ? `${(byType.get('labour')!.ex / totalEx * 100).toFixed(1)}%` : '—' },
    ],
    columns: [
      { key: 'type', label: 'Category' },
      { key: 'ex', label: 'Ex GST', align: 'right', money: true },
      { key: 'gst', label: 'GST', align: 'right', money: true },
      { key: 'inc', label: 'Inc GST', align: 'right', money: true },
      { key: 'pct', label: '% of income', align: 'right' },
    ],
    rows,
  }
}

// ── Stock — value on hand + low-stock list ───────────────────────────────
async function stock(db: SupabaseClient): Promise<ReportResult> {
  const items = await pageAll((a, b) => db.from('workshop_inventory')
    .select('sku, part_name, quantity, alert_qty, reorder_qty, buy_price, sell_price, supplier, location')
    .eq('deactivated', false).eq('is_non_stock', false)
    .order('sku').range(a, b))

  let onHand = 0, retail = 0, skus = 0
  const low: any[] = []
  for (const i of items as any[]) {
    const qty = Number(i.quantity) || 0
    skus += 1
    onHand += qty * (Number(i.buy_price) || 0)
    retail += qty * (Number(i.sell_price) || 0)
    if (Number(i.alert_qty) > 0 && qty <= Number(i.alert_qty)) {
      low.push({
        sku: i.sku || '', name: i.part_name || '', qty, alert: Number(i.alert_qty) || 0,
        reorder: Number(i.reorder_qty) || 0, supplier: i.supplier || '', location: i.location || '',
      })
    }
  }
  low.sort((a, b) => (a.qty - a.alert) - (b.qty - b.alert))
  return {
    kpis: [
      { label: 'Stocked SKUs', value: skus.toLocaleString() },
      { label: 'On-hand value (cost)', value: $(onHand), accent: 'green' },
      { label: 'Retail value', value: $(retail) },
      { label: 'Low stock', value: String(low.length), accent: low.length ? 'amber' : undefined },
    ],
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Part' },
      { key: 'qty', label: 'On hand', align: 'right' },
      { key: 'alert', label: 'Alert', align: 'right' },
      { key: 'reorder', label: 'Reorder', align: 'right' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'location', label: 'Location' },
    ],
    rows: low,
  }
}

// ── Technician productivity — jobs, booked hours, revenue per tech ──────
// span_techs jobs are attributed to the primary technician only (v1).
async function techProductivity(db: SupabaseClient, fromYmd: string, toYmd: string): Promise<ReportResult> {
  const { fromIso, toIso } = rangeBounds(fromYmd, toYmd)
  const [bookings, techs] = await Promise.all([
    pageAll((a, b) => db.from('workshop_bookings')
      .select('id, starts_at, ends_at, status, technician_ext, total_inc_gst')
      .gte('starts_at', fromIso).lt('starts_at', toIso)
      .not('status', 'in', '("cancelled","no_show")')
      .range(a, b)),
    db.from('workshop_technicians').select('code, name, role, daily_hours').then(r => r.data || []),
  ])

  const techByCode = new Map((techs as any[]).map(t => [t.code, t]))
  const agg = new Map<string, { jobs: number; mins: number; revenue: number }>()
  for (const b of bookings as any[]) {
    const code = b.technician_ext || '(unassigned)'
    const a = agg.get(code) || { jobs: 0, mins: 0, revenue: 0 }
    a.jobs += 1
    a.mins += bookingDurationMin(b)
    if (b.status === 'invoiced' || b.status === 'paid') a.revenue += Number(b.total_inc_gst) || 0
    agg.set(code, a)
  }
  const rows = Array.from(agg.entries()).map(([code, a]) => {
    const hrs = a.mins / 60
    return {
      tech: techByCode.get(code)?.name || code,
      role: techByCode.get(code)?.role || '',
      jobs: a.jobs,
      hours: round2(hrs),
      revenue: round2(a.revenue),
      per_hour: hrs ? round2(a.revenue / hrs) : 0,
    }
  }).sort((a, b) => b.revenue - a.revenue)
  return {
    kpis: [
      { label: 'Jobs', value: String(rows.reduce((s, r) => s + r.jobs, 0)) },
      { label: 'Booked hours', value: round2(rows.reduce((s, r) => s + r.hours, 0)).toLocaleString() },
      { label: 'Invoiced revenue', value: $(rows.reduce((s, r) => s + r.revenue, 0)), accent: 'green' },
    ],
    columns: [
      { key: 'tech', label: 'Technician' },
      { key: 'role', label: 'Role' },
      { key: 'jobs', label: 'Jobs', align: 'right' },
      { key: 'hours', label: 'Booked hrs', align: 'right' },
      { key: 'revenue', label: 'Invoiced inc GST', align: 'right', money: true },
      { key: 'per_hour', label: '$ / booked hr', align: 'right', money: true },
    ],
    rows,
  }
}
