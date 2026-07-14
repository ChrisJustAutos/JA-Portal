// lib/sales-recap-monday.ts
//
// Monday.com data layer for the Weekly Sales Recap (Reports → Sales Report).
// "Sales" here means ORDERS/BOOKINGS placed, not invoiced turnover (Chris,
// 2026-07-14).
//
//   • JA Orders      — board 1838428097 "Orders". Value ($) by Date, split by
//                      the "Job Sale Process" column (Normal / Upsell /
//                      Additional Maintenance). Cancelled/Deleted excluded.
//   • Distributor    — board 1923220718 "Distributor - Booking". Value ($) by
//                      "Date" (date4). Cancelled excluded.
//
// Pure aggregation over Monday GraphQL; no portal/DB deps so it runs in the
// weekly GH-Actions worker as well as a Vercel context.

const MONDAY_API = 'https://api.monday.com/v2'

export const ORDERS_BOARD = '1838428097'
export const DIST_BOOKING_BOARD = '1923220718'

// Orders board columns
const ORD = { date: 'date', value: 'numbers', process: 'color_mks9wfk9', status: 'status' }
// Distributor-Booking columns
const DB = { date: 'date4', value: 'numbers', status: 'status' }

// Statuses that mean "this didn't happen" — excluded from all totals.
const ORDERS_DEAD = new Set(['Deleted', 'Canceled', 'Cancelled'])
const DIST_DEAD = new Set(['Cancelled', 'Canceled'])

export type SaleProcess = 'Normal Booking' | 'Upsell' | 'Additional Maintenance' | 'Unclassified'

export interface OrderRow { date: string | null; value: number; process: SaleProcess; status: string | null }
export interface DistRow { date: string | null; value: number; status: string | null; distributor: string | null }

async function mondayQuery(token: string, query: string): Promise<any> {
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
    body: JSON.stringify({ query }),
  })
  const data = await r.json()
  if (!r.ok || data.errors) throw new Error(`Monday API: ${JSON.stringify(data.errors || data).slice(0, 300)}`)
  return data.data
}

// Pull every item's (date, value, process/status) from a board within a date
// window, paging through items_page. `since`/`until` are YYYY-MM-DD on the
// board's date column; null window = all items (used for monthly history).
async function pullBoard(
  token: string, boardId: string, cols: Record<string, string>,
  opts: { since?: string; until?: string } = {},
): Promise<any[]> {
  const out: any[] = []
  let cursor: string | null = null
  const colIds = Object.values(cols).map(c => `"${c}"`).join(',')
  for (let page = 0; page < 60; page++) {
    const cursorArg: string = cursor ? `cursor: "${cursor}"` : `query_params: { rules: [{ column_id: "${cols.date}", compare_value: ["${opts.since || '1900-01-01'}", "${opts.until || '2999-12-31'}"], operator: between }] }`
    const data = await mondayQuery(token, `query { boards(ids: [${boardId}]) { items_page(limit: 500, ${cursorArg}) {
      cursor
      items { id name column_values(ids: [${colIds}]) { id text } }
    } } }`)
    const pageData = data?.boards?.[0]?.items_page
    const items: any[] = pageData?.items || []
    out.push(...items)
    cursor = pageData?.cursor || null
    if (!cursor || !items.length) break
  }
  return out
}

const num = (s: string | null | undefined) => {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const colText = (item: any, id: string) => (item.column_values || []).find((c: any) => c.id === id)?.text?.trim() || null

export async function fetchOrders(token: string, since: string, until: string): Promise<OrderRow[]> {
  const items = await pullBoard(token, ORDERS_BOARD, ORD, { since, until })
  return items.map(it => {
    const status = colText(it, ORD.status)
    const p = colText(it, ORD.process)
    const process: SaleProcess = (p === 'Normal Booking' || p === 'Upsell' || p === 'Additional Maintenance') ? p : 'Unclassified'
    return { date: colText(it, ORD.date), value: num(colText(it, ORD.value)), process, status }
  }).filter(r => !ORDERS_DEAD.has(String(r.status || '')))
}

// ── Quote-channel leads (overnight enquiries) ───────────────────────────
// The five per-salesperson quote-channel boards (same set the nightly
// Monday→MD customer import reads; column ids identical — template copies).
export const QUOTE_CHANNEL_BOARDS: { id: string; channel: string }[] = [
  { id: '5026840169', channel: 'Graham' },
  { id: '5025942308', channel: 'Dom' },
  { id: '5025942288', channel: 'Tyronne' },
  { id: '5025942316', channel: 'Kaleb' },
  { id: '5025942292', channel: 'James' },
]
const QUOTE_COL_PHONE = 'text_mkzbenay'

export interface QuoteLeadRow { channel: string; name: string; phone: string | null; createdAt: string }

// Items created since `sinceMs` across all quote-channel boards. Uses
// created_at (no date column on these boards is reliable for lead-arrival
// time). Two pages of 100 per board covers far more than a few nights.
export async function fetchQuoteLeads(token: string, sinceMs: number): Promise<QuoteLeadRow[]> {
  const out: QuoteLeadRow[] = []
  for (const b of QUOTE_CHANNEL_BOARDS) {
    let cursor: string | null = null
    for (let page = 0; page < 2; page++) {
      const cursorArg: string = cursor ? `, cursor: "${cursor}"` : ''
      const data = await mondayQuery(token, `query { boards(ids: [${b.id}]) { items_page(limit: 100${cursorArg}) {
        cursor
        items { id name created_at column_values(ids: ["${QUOTE_COL_PHONE}"]) { id text } }
      } } }`)
      const pageData = data?.boards?.[0]?.items_page
      const items: any[] = pageData?.items || []
      for (const it of items) {
        if (!(new Date(it.created_at).getTime() >= sinceMs)) continue
        out.push({
          channel: b.channel,
          name: String(it.name || '').trim() || '(unnamed)',
          phone: (it.column_values || []).find((c: any) => c.id === QUOTE_COL_PHONE)?.text?.trim() || null,
          createdAt: it.created_at,
        })
      }
      cursor = pageData?.cursor || null
      if (!cursor || !items.length) break
      if (!items.some((it: any) => new Date(it.created_at).getTime() >= sinceMs)) break
    }
  }
  return out
}

export async function fetchDistBookings(token: string, since: string, until: string): Promise<DistRow[]> {
  const items = await pullBoard(token, DIST_BOOKING_BOARD, DB, { since, until })
  return items.map(it => ({
    date: colText(it, DB.date), value: num(colText(it, DB.value)),
    status: colText(it, DB.status), distributor: colText(it, 'status_1'),
  })).filter(r => !DIST_DEAD.has(String(r.status || '')))
}

// ── Aggregations ────────────────────────────────────────────────────────

export interface DailyRow { date: string; orders: number; ordersNormal: number; ordersUpsell: number; ordersAddMaint: number; distributor: number; total: number }

// Per-day totals across a window. `days` = ordered list of YYYY-MM-DD to emit
// (so empty trading days still show).
export function dailyBreakdown(orders: OrderRow[], dist: DistRow[], days: string[]): DailyRow[] {
  const byDay = new Map<string, DailyRow>()
  for (const d of days) byDay.set(d, { date: d, orders: 0, ordersNormal: 0, ordersUpsell: 0, ordersAddMaint: 0, distributor: 0, total: 0 })
  for (const o of orders) {
    if (!o.date) continue
    const row = byDay.get(o.date); if (!row) continue
    row.orders += o.value
    if (o.process === 'Upsell') row.ordersUpsell += o.value
    else if (o.process === 'Additional Maintenance') row.ordersAddMaint += o.value
    else row.ordersNormal += o.value
  }
  for (const d of dist) {
    if (!d.date) continue
    const row = byDay.get(d.date); if (!row) continue
    row.distributor += d.value
  }
  const rows = days.map(d => byDay.get(d)!)
  for (const row of rows) row.total = row.orders + row.distributor
  return rows
}

export interface WeekRow { label: string; start: string; end: string; orders: number; distributor: number; total: number; tradingDays: number; dailyAvg: number }

// Sum a [start,end] inclusive window.
export function windowTotals(orders: OrderRow[], dist: DistRow[], start: string, end: string) {
  const inRange = (d: string | null) => !!d && d >= start && d <= end
  const o = orders.filter(r => inRange(r.date)).reduce((s, r) => s + r.value, 0)
  const dd = dist.filter(r => inRange(r.date)).reduce((s, r) => s + r.value, 0)
  return { orders: Math.round(o * 100) / 100, distributor: Math.round(dd * 100) / 100, total: Math.round((o + dd) * 100) / 100 }
}

export interface MonthRow { month: string; orders: number; distributor: number; total: number }

// Group by calendar month (YYYY-MM) across whatever rows are supplied.
export function monthlyBreakdown(orders: OrderRow[], dist: DistRow[]): MonthRow[] {
  const by = new Map<string, { orders: number; distributor: number }>()
  const bump = (d: string | null, field: 'orders' | 'distributor', v: number) => {
    if (!d) return
    const m = d.slice(0, 7)
    const e = by.get(m) || { orders: 0, distributor: 0 }
    e[field] += v; by.set(m, e)
  }
  for (const o of orders) bump(o.date, 'orders', o.value)
  for (const d of dist) bump(d.date, 'distributor', d.value)
  return Array.from(by.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, orders: Math.round(v.orders * 100) / 100, distributor: Math.round(v.distributor * 100) / 100, total: Math.round((v.orders + v.distributor) * 100) / 100 }))
}
