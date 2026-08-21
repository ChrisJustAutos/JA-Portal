// lib/sales-figures-monday.ts
//
// Sales FIGURES for Reports → Sales Dashboard: daily, monthly, per-salesperson
// and period totals, over any date range. This is the half of the Monday
// "Sales Dashboard" (2079976) that tracks money taken over time; the quote
// pipeline lives in lib/sales-dashboard-monday.ts.
//
// Built on fetchOrders / fetchDistBookings from lib/sales-recap-monday rather
// than pulling the boards again, so the definition of "a sale" stays in ONE
// place — those functions already drop the dead statuses (Deleted / Canceled /
// Cancelled) and the Distributor-Booking groups that don't count
// (Booking - Pending, Postponed, …). Change it there and both this and the
// Weekly Sales Recap follow.
//
// "Sales" here means ORDERS/BOOKINGS TAKEN, not invoiced turnover — the same
// meaning the Sales Report uses (Chris, 2026-07-14). Turnover lives on the
// Forecast report, which reads the Forecasting board.
//
// SALESPERSON ATTRIBUTION: the boards' people column ("Created By" on Orders,
// "Person" on Distributor - Booking) can hold SEVERAL names. A row is
// attributed to the FIRST name only, so the per-person rows still add up to
// the period total — counting a shared row against everyone named would
// inflate the total and make the table irreconcilable with the headline.
// Rows with no one set are grouped as "Unassigned" rather than dropped.

import { fetchOrders, fetchDistBookings, type SaleProcess, type OrderRow, type DistRow } from './sales-recap-monday'

export interface DayRow { date: string; ordersValue: number; ordersCount: number; distValue: number; distCount: number; total: number }
export interface MonthRow { month: string; ordersValue: number; ordersCount: number; distValue: number; distCount: number; total: number }
export interface ProcessRow { process: SaleProcess; count: number; value: number }
export interface PersonRow {
  person: string
  ordersCount: number; ordersValue: number
  distCount: number; distValue: number
  total: number
  /** Share of the period total, 0-100. */
  sharePct: number
}

export interface SalesFiguresData {
  period: { since: string; until: string; days: number; person: string | null }
  /** Every day in the daily window, including zero-sale days so gaps are visible. */
  daily: DayRow[]
  dailyWindowDays: number
  monthly: MonthRow[]
  byProcess: ProcessRow[]
  /** Always the whole range and every salesperson, regardless of any filter. */
  people: PersonRow[]
  totals: {
    ordersCount: number; ordersValue: number
    distCount: number; distValue: number
    total: number
    monthToDate: number
    yearToDate: number
    bestDay: { date: string; total: number } | null
    bestMonth: { month: string; total: number } | null
    tradingDays: number
    avgPerTradingDay: number | null
  }
  generatedAt: string
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** First name on a people column, or "Unassigned". Keeps per-person rows summing to the total. */
export function primaryOwner(owner: string | null | undefined): string {
  const first = String(owner || '').split(',')[0].trim()
  return first || 'Unassigned'
}

export interface SalesFiguresOpts {
  /** Explicit range wins; otherwise `months` back from `now`. */
  since?: string
  until?: string
  months?: number
  dailyWindowDays?: number
  /** Scopes daily/monthly/byProcess/totals to one salesperson. `people` stays whole. */
  person?: string | null
  now?: Date
}

export async function fetchSalesFigures(token: string, opts: SalesFiguresOpts = {}): Promise<SalesFiguresData> {
  const now = opts.now ?? new Date()

  let since: string
  let until: string
  if (opts.since && opts.until && YMD_RE.test(opts.since) && YMD_RE.test(opts.until)) {
    // Tolerate a range handed over backwards rather than returning nothing.
    since = opts.since <= opts.until ? opts.since : opts.until
    until = opts.since <= opts.until ? opts.until : opts.since
  } else {
    const months = Math.min(36, Math.max(1, opts.months ?? 12))
    until = ymd(now)
    const s = new Date(now)
    s.setMonth(s.getMonth() - months)
    since = ymd(s)
  }

  const rangeDays = Math.floor((Date.parse(until + 'T00:00:00Z') - Date.parse(since + 'T00:00:00Z')) / 86400000) + 1
  // The daily chart never plots more days than the range holds.
  const dailyWindowDays = Math.max(1, Math.min(opts.dailyWindowDays ?? 60, rangeDays))
  const person = opts.person?.trim() || null

  const [allOrders, allDist] = await Promise.all([
    fetchOrders(token, since, until),
    fetchDistBookings(token, since, until),
  ])

  // ── Per-person table: always the whole range, every salesperson ──────────
  const peopleMap = new Map<string, PersonRow>()
  const person_ = (name: string): PersonRow => {
    let r = peopleMap.get(name)
    if (!r) { r = { person: name, ordersCount: 0, ordersValue: 0, distCount: 0, distValue: 0, total: 0, sharePct: 0 }; peopleMap.set(name, r) }
    return r
  }
  for (const o of allOrders) {
    const r = person_(primaryOwner(o.owner))
    r.ordersCount++; r.ordersValue += o.value; r.total += o.value
  }
  for (const b of allDist) {
    const r = person_(primaryOwner(b.owner))
    r.distCount++; r.distValue += b.value; r.total += b.value
  }
  const grandAll = Array.from(peopleMap.values()).reduce((a, r) => a + r.total, 0)
  const people = Array.from(peopleMap.values())
    .map(r => ({ ...r, sharePct: grandAll > 0 ? (r.total / grandAll) * 100 : 0 }))
    .sort((a, b) => b.total - a.total)

  // ── Everything else honours the person filter ───────────────────────────
  const orders: OrderRow[] = person ? allOrders.filter(o => primaryOwner(o.owner) === person) : allOrders
  const dist: DistRow[] = person ? allDist.filter(b => primaryOwner(b.owner) === person) : allDist

  const byDay = new Map<string, DayRow>()
  const byMonth = new Map<string, MonthRow>()
  const byProcess = new Map<SaleProcess, ProcessRow>()

  const day = (d: string): DayRow => {
    let r = byDay.get(d)
    if (!r) { r = { date: d, ordersValue: 0, ordersCount: 0, distValue: 0, distCount: 0, total: 0 }; byDay.set(d, r) }
    return r
  }
  const month = (m: string): MonthRow => {
    let r = byMonth.get(m)
    if (!r) { r = { month: m, ordersValue: 0, ordersCount: 0, distValue: 0, distCount: 0, total: 0 }; byMonth.set(m, r) }
    return r
  }

  for (const o of orders) {
    if (!o.date) continue
    const d = day(o.date); d.ordersValue += o.value; d.ordersCount++; d.total += o.value
    const m = month(o.date.slice(0, 7)); m.ordersValue += o.value; m.ordersCount++; m.total += o.value
    const p = byProcess.get(o.process) || { process: o.process, count: 0, value: 0 }
    p.count++; p.value += o.value
    byProcess.set(o.process, p)
  }
  for (const b of dist) {
    if (!b.date) continue
    const d = day(b.date); d.distValue += b.value; d.distCount++; d.total += b.value
    const m = month(b.date.slice(0, 7)); m.distValue += b.value; m.distCount++; m.total += b.value
  }

  // Daily series: fill every calendar day so a day with no sales shows as a
  // gap rather than silently collapsing the axis. Ends at `until`.
  const daily: DayRow[] = []
  const end = new Date(Date.parse(until + 'T00:00:00Z'))
  for (let i = dailyWindowDays - 1; i >= 0; i--) {
    const d = new Date(end)
    d.setUTCDate(end.getUTCDate() - i)
    const key = ymd(d)
    daily.push(byDay.get(key) || { date: key, ordersValue: 0, ordersCount: 0, distValue: 0, distCount: 0, total: 0 })
  }

  const monthly = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))

  const oTot = orders.reduce((a, o) => ({ c: a.c + 1, v: a.v + o.value }), { c: 0, v: 0 })
  const dTot = dist.reduce((a, b) => ({ c: a.c + 1, v: a.v + b.value }), { c: 0, v: 0 })

  // Month/year to date are relative to TODAY, and only meaningful when the
  // range still includes the current period — otherwise they'd read as 0 and
  // look like a fault, so they're null instead.
  const today = ymd(now)
  const inRange = today >= since && today <= until
  const thisMonth = today.slice(0, 7)
  const thisYear = today.slice(0, 4)
  let monthToDate = 0, yearToDate = 0
  byMonth.forEach(m => {
    if (m.month === thisMonth) monthToDate += m.total
    if (m.month.slice(0, 4) === thisYear) yearToDate += m.total
  })

  let bestDay: { date: string; total: number } | null = null
  byDay.forEach(d => { if (!bestDay || d.total > (bestDay as { total: number }).total) bestDay = { date: d.date, total: d.total } })
  let bestMonth: { month: string; total: number } | null = null
  for (const m of monthly) if (!bestMonth || m.total > bestMonth.total) bestMonth = { month: m.month, total: m.total }

  // Average per TRADING day — days with at least one sale. Dividing by every
  // calendar day would quietly halve it by counting weekends.
  let tradingDays = 0
  byDay.forEach(d => { if (d.total > 0) tradingDays++ })
  const grand = oTot.v + dTot.v

  return {
    period: { since, until, days: rangeDays, person },
    daily,
    dailyWindowDays,
    monthly,
    byProcess: Array.from(byProcess.values()).sort((a, b) => b.value - a.value),
    people,
    totals: {
      ordersCount: oTot.c, ordersValue: oTot.v,
      distCount: dTot.c, distValue: dTot.v,
      total: grand,
      monthToDate: inRange ? monthToDate : 0,
      yearToDate: inRange ? yearToDate : 0,
      bestDay, bestMonth,
      tradingDays,
      avgPerTradingDay: tradingDays > 0 ? grand / tradingDays : null,
    },
    generatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Management view extras: sales targets and the exception totals.
//
// These mirror the six widgets on the Monday "Management Dashboard" (321206):
// three target charts (per month / per person / per day) and three headline
// exception totals (Cancelled Order, Staff Parts Owing, Postponed Orders).
// ─────────────────────────────────────────────────────────────────────────

import { getIntegrations } from './integration-config'
import { ORDERS_BOARD } from './sales-recap-monday'

/** Group ids on the Orders board that hold the exception totals. */
const ORDER_EXCEPTION_GROUPS = {
  postponed: 'new_group87270',      // "Postponed Orders"
  cancelled: 'new_group40745',      // "Cancelled Orders"
  cancelledPrevYears: 'group_mkv0r7ez', // "Cancelled Orders - Previous Years"
}

export interface SalesTargets {
  /** Whole-business target for one month. */
  perMonth: number
  /** Per-salesperson target for one month. */
  perPerson: number
  /** Whole-business target for one day. */
  perDay: number
}

/** Defaults read off the Monday dashboard's target lines (2026-08-21). All
 *  three are overridable per-portal via integration settings / env. */
const TARGET_DEFAULTS: SalesTargets = { perMonth: 1_000_000, perPerson: 300_000, perDay: 50_000 }

export async function getSalesTargets(): Promise<SalesTargets> {
  const cfg = await getIntegrations([
    'SALES_TARGET_PER_MONTH', 'SALES_TARGET_PER_PERSON', 'SALES_TARGET_PER_DAY',
  ] as const)
  const n = (raw: string, fallback: number) => {
    const v = parseFloat(String(raw).replace(/[^0-9.-]/g, ''))
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    perMonth: n(cfg.SALES_TARGET_PER_MONTH, TARGET_DEFAULTS.perMonth),
    perPerson: n(cfg.SALES_TARGET_PER_PERSON, TARGET_DEFAULTS.perPerson),
    perDay: n(cfg.SALES_TARGET_PER_DAY, TARGET_DEFAULTS.perDay),
  }
}

export interface OrderExceptions {
  cancelled: { count: number; value: number }
  postponed: { count: number; value: number }
  /** Whether the previous-years cancelled group was folded in. */
  includesPreviousYears: boolean
}

/**
 * Cancelled and Postponed order totals.
 *
 * These are GROUP totals over the whole board, with no date filter — verified
 * against the Monday widget on 2026-08-21: the 12 items in "Postponed Orders"
 * sum to $73,804.45, exactly what the widget shows. Note the group is the
 * authority, not the status column: that group contains rows whose status is
 * "Done" or "Not Done", and they still count.
 *
 * "Cancelled Orders - Previous Years" is a separate group and is EXCLUDED by
 * default, matching the widget's apparent scope. Set
 * SALES_EXCEPTIONS_INCLUDE_PREV_YEARS=1 to fold it in.
 *
 * These totals are deliberately NOT part of any sales figure — cancelled and
 * postponed work is not revenue. They are reported alongside as what was lost
 * and what is parked.
 */
export async function fetchOrderExceptions(token: string, includePrevYears = false): Promise<OrderExceptions> {
  const groups = [ORDER_EXCEPTION_GROUPS.cancelled, ORDER_EXCEPTION_GROUPS.postponed]
  if (includePrevYears) groups.push(ORDER_EXCEPTION_GROUPS.cancelledPrevYears)

  const out: OrderExceptions = {
    cancelled: { count: 0, value: 0 },
    postponed: { count: 0, value: 0 },
    includesPreviousYears: includePrevYears,
  }

  for (const gid of groups) {
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const cursorArg: string = cursor === null ? '' : `, cursor: ${JSON.stringify(cursor)}`
      const q: string = `query { boards(ids: [${ORDERS_BOARD}]) { groups(ids: ["${gid}"]) {
        items_page(limit: 500${cursorArg}) {
          cursor items { id column_values(ids: ["numbers"]) { id text } }
        }
      } } }`
      const res: Response = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
        body: JSON.stringify({ query: q }),
      })
      const j: any = await res.json()
      if (j.errors) throw new Error(`Monday: ${JSON.stringify(j.errors).slice(0, 300)}`)
      const pageData: any = j?.data?.boards?.[0]?.groups?.[0]?.items_page
      const items: any[] = pageData?.items || []
      const bucket = gid === ORDER_EXCEPTION_GROUPS.postponed ? out.postponed : out.cancelled
      for (const it of items) {
        const raw = (it.column_values || []).find((c: any) => c.id === 'numbers')?.text
        const v = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
        bucket.count++
        if (Number.isFinite(v)) bucket.value += v
      }
      cursor = (pageData?.cursor as string | null) || null
      if (!cursor || !items.length) break
    }
  }

  return out
}
