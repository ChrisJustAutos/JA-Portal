// lib/sales-figures-monday.ts
//
// Sales FIGURES for Reports → Sales Dashboard: daily, monthly and period
// totals. This is the half of the Monday "Sales Dashboard" (2079976) that
// tracks money taken over time, as opposed to the quote pipeline in
// lib/sales-dashboard-monday.ts.
//
// Built on fetchOrders / fetchDistBookings from lib/sales-recap-monday rather
// than pulling the boards again, so the definition of "a sale" stays in ONE
// place — those functions already drop the dead statuses (Deleted / Canceled /
// Cancelled) and the Distributor-Booking groups that don't count
// (Booking - Pending, Postponed, …). If that definition ever changes, it
// changes there and both this and the Weekly Sales Recap follow.
//
// "Sales" here means ORDERS/BOOKINGS TAKEN, not invoiced turnover — the same
// meaning the Sales Report uses (Chris, 2026-07-14). Turnover lives on the
// Forecast report, which reads the Forecasting board.

import { fetchOrders, fetchDistBookings, type SaleProcess } from './sales-recap-monday'

export interface DayRow { date: string; ordersValue: number; ordersCount: number; distValue: number; distCount: number; total: number }
export interface MonthRow { month: string; ordersValue: number; ordersCount: number; distValue: number; distCount: number; total: number }
export interface ProcessRow { process: SaleProcess; count: number; value: number }

export interface SalesFiguresData {
  period: { since: string; until: string; months: number }
  /** Every day in the daily window, including zero-sale days so gaps are visible. */
  daily: DayRow[]
  dailyWindowDays: number
  monthly: MonthRow[]
  byProcess: ProcessRow[]
  totals: {
    ordersCount: number; ordersValue: number
    distCount: number; distValue: number
    total: number
    /** Calendar month to date and calendar year to date, within the window. */
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

export async function fetchSalesFigures(
  token: string, opts: { months?: number; dailyWindowDays?: number; now?: Date } = {},
): Promise<SalesFiguresData> {
  const months = Math.min(24, Math.max(1, opts.months ?? 12))
  const dailyWindowDays = Math.min(180, Math.max(7, opts.dailyWindowDays ?? 60))
  const now = opts.now ?? new Date()

  const until = ymd(now)
  const sinceDate = new Date(now)
  sinceDate.setMonth(sinceDate.getMonth() - months)
  const since = ymd(sinceDate)

  const [orders, dist] = await Promise.all([
    fetchOrders(token, since, until),
    fetchDistBookings(token, since, until),
  ])

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

  // Daily series: fill every calendar day in the window, so a day with no
  // sales shows as a gap rather than silently collapsing the axis.
  const daily: DayRow[] = []
  const start = new Date(now)
  start.setDate(start.getDate() - (dailyWindowDays - 1))
  for (let i = 0; i < dailyWindowDays; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = ymd(d)
    daily.push(byDay.get(key) || { date: key, ordersValue: 0, ordersCount: 0, distValue: 0, distCount: 0, total: 0 })
  }

  const monthly = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))

  const totals = orders.reduce((a, o) => ({ c: a.c + 1, v: a.v + o.value }), { c: 0, v: 0 })
  const distTotals = dist.reduce((a, b) => ({ c: a.c + 1, v: a.v + b.value }), { c: 0, v: 0 })

  const thisMonth = until.slice(0, 7)
  const thisYear = until.slice(0, 4)
  let monthToDate = 0, yearToDate = 0
  byMonth.forEach((m) => {
    if (m.month === thisMonth) monthToDate += m.total
    if (m.month.slice(0, 4) === thisYear) yearToDate += m.total
  })

  let bestDay: { date: string; total: number } | null = null
  byDay.forEach(d => { if (!bestDay || d.total > bestDay.total) bestDay = { date: d.date, total: d.total } })
  let bestMonth: { month: string; total: number } | null = null
  for (const m of monthly) if (!bestMonth || m.total > bestMonth.total) bestMonth = { month: m.month, total: m.total }

  // Average per TRADING day — days with at least one sale. Dividing by every
  // calendar day would quietly halve the figure by counting weekends.
  let tradingDays = 0
  byDay.forEach(d => { if (d.total > 0) tradingDays++ })
  const grand = totals.v + distTotals.v

  return {
    period: { since, until, months },
    daily,
    dailyWindowDays,
    monthly,
    byProcess: Array.from(byProcess.values()).sort((a, b) => b.value - a.value),
    totals: {
      ordersCount: totals.c, ordersValue: totals.v,
      distCount: distTotals.c, distValue: distTotals.v,
      total: grand,
      monthToDate, yearToDate, bestDay, bestMonth,
      tradingDays,
      avgPerTradingDay: tradingDays > 0 ? grand / tradingDays : null,
    },
    generatedAt: new Date().toISOString(),
  }
}
