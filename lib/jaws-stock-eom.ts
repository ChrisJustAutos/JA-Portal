// lib/jaws-stock-eom.ts
// SERVER-ONLY. Month-end stock report for the JAWS company file.
//
// The /stock page (pages/api/inventory.ts) already computes the LIVE inventory
// picture — reorder alerts, velocity, dead stock, margin, on-order. This module
// is the month-end layer that page can't provide:
//
//   * the month's trading in isolation (units, revenue, COGS, margin), not a
//     rolling 30/90/365 window
//   * month-on-month movement, which needs stored history because AccountRight
//     only ever tells you today's quantity (migration 199)
//   * stock turn and days-of-inventory
//   * the exception lists worth reviewing once a month rather than daily:
//     ageing of held value, margin leakage, cost creep, unfilled demand,
//     overstock, supplier concentration, data integrity
//
// Deliberately reuses lib/myob-reporting's proven readers and lib/gst's
// lineExGst so its numbers reconcile with the /stock page rather than drifting
// into a second, subtly different truth.
//
// ⚠ TWO HONEST APPROXIMATIONS, stated on the report itself:
//   1. On-hand is read live, so it is "as at generation time", not the last
//      instant of the month. AccountRight exposes no historical quantity.
//   2. COGS is units × current AverageCost. Invoice lines don't carry the cost
//      of sale, and average cost moves, so margin is indicative — good enough to
//      rank SKUs and spot leakage, not a substitute for the P&L.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { fetchInventoryItems, fetchSaleInvoicesWithLines } from './myob-reporting'
import { lineExGst } from './gst'
import { getIntegrations } from './integration-config'
import { sendMail } from './email'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const LIST_CAP = 25          // rows kept per exception list — a review list, not a dump
const OVERSTOCK_DAYS = 365   // cover beyond a year = excess capital
const COST_CREEP_PCT = 0.10  // last purchase price this much above average cost
const TARGET_COVER_DAYS = 90 // the cover level "capital at risk" is measured against
const SLOW_COVER_DAYS = 180  // still selling, but this far ahead of demand...
const SLOW_CAPITAL_MIN = 2000 // ...and this much capital past the 90-day target

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const r2 = (n: number) => Math.round(n * 100) / 100
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

/** 'YYYY-MM' → inclusive [start, end] dates. */
export function monthWindow(month: string): { start: Date; end: Date; label: string } {
  const [y, m] = month.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59))
  const label = start.toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return { start, end, label }
}

/** The month just ended, in Brisbane terms (the cron's default target). */
export function previousMonth(now = new Date()): string {
  const bne = new Date(now.getTime() + 10 * 3600 * 1000)
  return monthKey(new Date(Date.UTC(bne.getUTCFullYear(), bne.getUTCMonth() - 1, 1)))
}

/** Shift a 'YYYY-MM' by n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  return monthKey(new Date(Date.UTC(y, m - 1 + n, 1)))
}

/** Inclusive list of 'YYYY-MM' from → to. Empty when from is after to. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let cur = from
  for (let guard = 0; guard < 600 && cur <= to; guard++) { out.push(cur); cur = addMonths(cur, 1) }
  return out
}

/** How far back the sales history may be pulled. 36 months keeps the MYOB
 *  read inside the 300s function budget on a cold cache. */
export const MAX_HISTORY_MONTHS = 36
export const DEFAULT_HISTORY_MONTHS = 12

/** Resolve the requested history window against the reported month. The window
 *  always ENDS at or before the reported month — a month-end report must not
 *  average in sales it could not have known about. */
export function resolveHistoryWindow(
  month: string, from?: string | null, to?: string | null,
): { from: string; to: string; months: string[] } {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
  let hTo = to && MONTH_RE.test(to) ? to : month
  if (hTo > month) hTo = month
  let hFrom = from && MONTH_RE.test(from) ? from : addMonths(hTo, -(DEFAULT_HISTORY_MONTHS - 1))
  if (hFrom > hTo) hFrom = hTo
  // Cap the span, keeping the end fixed — the recent months are the ones that
  // matter, and an unbounded range would time the MYOB read out.
  if (monthsBetween(hFrom, hTo).length > MAX_HISTORY_MONTHS) hFrom = addMonths(hTo, -(MAX_HISTORY_MONTHS - 1))
  return { from: hFrom, to: hTo, months: monthsBetween(hFrom, hTo) }
}

/** Growth across a monthly series: the back half against the front half. On an
 *  odd number of months the middle one is dropped so both halves are the same
 *  length. Null under 4 months — two-month halves are noise, not a trend. */
export function halfOverHalfGrowth(series: Array<{ units: number; revEx: number }>): number | null {
  if (series.length < 4) return null
  const half = Math.floor(series.length / 2)
  const sum = (rows: typeof series, k: 'units' | 'revEx') => rows.reduce((s, r) => s + r[k], 0)
  const first = series.slice(0, half)
  const second = series.slice(series.length - half)
  const fRev = sum(first, 'revEx'), sRev = sum(second, 'revEx')
  if (fRev > 0) return (sRev - fRev) / fRev
  const fU = sum(first, 'units'), sU = sum(second, 'units')
  return fU > 0 ? (sU - fU) / fU : null
}

export interface EomItem {
  sku: string; name: string; supplier: string | null
  onHand: number; available: number; committed: number; onOrder: number
  avgCost: number; stockValue: number
  sellEx: number; marginPct: number | null; marginDollar: number | null
  lastPurchasePrice: number | null
  reorderLevel: number; reorderQty: number
  monthUnits: number; monthRevenueEx: number; monthCogs: number; monthMargin: number
  prevMonthUnits: number
  units90: number; units365: number
  lastSold: string | null; daysSinceLastSold: number | null
  /** Units invoiced AFTER the reported month ended. A slow mover with sales
   *  here isn't dead — it just hadn't sold in the window being reported. */
  unitsSinceMonthEnd: number
  runRatePerDay: number; daysOfCover: number | null
  /** Value held beyond TARGET_COVER_DAYS of demand — the capital this SKU is
   *  tying up over and above what its own sales rate justifies. Equals the
   *  whole stock value when nothing has sold in 90 days (run rate 0). This is
   *  what ranks the slow-mover list: $60k at 200 days of cover matters more
   *  than $300 that has never moved. */
  capitalAtRisk: number

  // ── over the chosen sales-history window (report.history) ──
  /** Units invoiced across the whole window. */
  historyUnits: number
  historyRevenueEx: number
  /** Window totals ÷ months in the window — the "average sale" figures. */
  avgUnitsPerMonth: number
  avgRevenuePerMonth: number
  /** On-hand ÷ average units per month: months of stock at the average rate.
   *  Steadier than daysOfCover, which is driven by the last 90 days alone. */
  monthsCoverAtAvg: number | null
  /** Back half of the window against the front half — this SKU growing or
   *  fading. Null when the window is under 4 months or there is no baseline. */
  growthPct: number | null
}

/** A slow mover carries WHY it is on the list — dead, or simply carrying far
 *  more stock than its sales rate justifies. */
export type EomSlowMover = EomItem & { slowReason: string }

export interface EomReport {
  month: string; monthLabel: string
  generatedAt: string
  headline: {
    skus: number; stockValue: number; qtyOnHand: number; qtyOnOrder: number; qtyCommitted: number
    monthUnits: number; monthRevenueEx: number; monthCogs: number; monthMargin: number; monthMarginPct: number | null
    turnsAnnualised: number | null; daysInventory: number | null
    lowStockCount: number; outOfStockCount: number
    dead90Count: number; dead90Value: number
    dead180Count: number; dead180Value: number
    /** Held stock that has NEVER been invoiced — excluded from every "not
     *  moving" list below (almost always a kit component). Reported so the
     *  capital is visible, never silently dropped. */
    neverSoldCount: number; neverSoldValue: number
    /** Held value the ageing/slow-mover analysis actually covers = stock
     *  value minus the never-sold exclusion. */
    analysedValue: number
    slowCount: number; slowCapital: number
    overstockCount: number; overstockValue: number
    reorderCount: number; reorderCost: number
    /** SKUs on the Stock Order sheet the reorder list is drawn from. */
    reorderSheetSize: number
    /** Below their alert level but NOT on the sheet — kit parts, one-offs. */
    reorderExcludedCount: number
    activeSkusThisMonth: number
  }
  /** The sales-history window every average/growth figure is measured over,
   *  plus the month-by-month series behind it. */
  history: {
    from: string; to: string; months: number
    unitsTotal: number; revenueExTotal: number
    avgUnitsPerMonth: number; avgRevenuePerMonth: number
    /** Back half vs front half of the window, on revenue. */
    growthPct: number | null
    firstHalfLabel: string | null; firstHalfRevenueEx: number | null
    secondHalfLabel: string | null; secondHalfRevenueEx: number | null
    series: Array<{ month: string; units: number; revenueEx: number }>
  }
  ageing: Array<{ bucket: string; skus: number; value: number }>
  topByUnits: EomItem[]
  topByRevenue: EomItem[]
  topByMargin: EomItem[]
  slowMovers: EomSlowMover[]
  reorder: Array<EomItem & { suggestQty: number; suggestCost: number; reason: string }>
  belowCost: EomItem[]
  costCreep: EomItem[]
  unfilledDemand: EomItem[]
  overstock: EomItem[]
  suppliers: Array<{ supplier: string; skus: number; stockValue: number; monthRevenueEx: number; reorderCost: number }>
  integrity: Array<{ sku: string; name: string; issue: string; detail: string }>
  stocktake: { count: number; latest: string | null; matched: number; unmatched: number } | null
  trend: Array<{ month: string; stockValue: number; monthRevenueEx: number; monthMarginPct: number | null; deadValue: number; turns: number | null }>
  notes: string[]
}

export async function buildEomReport(
  month: string,
  opts: { historyFrom?: string | null; historyTo?: string | null } = {},
): Promise<EomReport> {
  const { start, end, label } = monthWindow(month)
  const prev = monthWindow(previousMonthOf(month))
  const now = new Date()

  // The sales-history window drives every average, the months-of-cover figure
  // and the growth read (Chris, 2026-08-25). Defaults to the 12 months ending
  // with the reported month; the report states which window it used.
  const histWin = resolveHistoryWindow(month, opts.historyFrom, opts.historyTo)

  // The Stock Order sheet (b2b_reorder_items, migration 114) is the curated list
  // of SKUs Just Autos actually buys. MYOB's item list is much wider and includes
  // kit components that are never sold separately — they sit below their alert
  // level permanently and would swamp the reorder list with things nobody can
  // order (Chris, 2026-08-24). b2b_product_bundles can't be used for this: it
  // holds a single row, so it identifies nothing.
  const { data: sheetRows } = await sb().from('b2b_reorder_items').select('sku')
  const sheet = new Set((sheetRows || []).map(r => String(r.sku || '').trim().toUpperCase()).filter(Boolean))

  // 13 months back from the START of the reported month gives the month itself,
  // the month before it, and a full 12 months for run rates and turns — read
  // ALWAYS, so stock turn stays comparable whatever history window is chosen.
  // A longer window simply starts the read earlier.
  const defaultStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 12, 1))
  const historyStart = monthWindow(histWin.from).start
  const fetchStart = historyStart < defaultStart ? historyStart : defaultStart

  const [items, sales] = await Promise.all([
    fetchInventoryItems('JAWS'),
    fetchSaleInvoicesWithLines('JAWS', { start: fetchStart.toISOString().slice(0, 10) }),
  ])

  const invById = new Map<string, { date: Date; isTaxInclusive: boolean }>()
  for (const inv of sales.invoices) {
    if (!inv.ID || !inv.Date) continue
    invById.set(String(inv.ID), { date: new Date(inv.Date), isTaxInclusive: inv.IsTaxInclusive === true })
  }

  interface Agg {
    monthUnits: number; monthRevenueEx: number
    prevUnits: number
    units90: number; units365: number; revenue365Ex: number
    lastSold: Date | null          // bounded to <= month end, see below
    unitsAfter: number             // invoiced after the month end
    monthly: Record<string, { units: number; revEx: number }>
  }
  const per = new Map<string, Agg>()
  const d90 = new Date(end.getTime() - 90 * 86400000)
  const d365 = new Date(end.getTime() - 365 * 86400000)

  for (const line of sales.lines) {
    const sku = line.ItemNumber ? String(line.ItemNumber).trim() : ''
    if (!sku) continue
    const meta = invById.get(String(line.SaleInvoiceId))
    if (!meta) continue
    const qty = num(line.ShipQuantity)
    const ex = lineExGst(num(line.Total), meta.isTaxInclusive, line.TaxCodeCode)
    let a = per.get(sku)
    if (!a) { a = { monthUnits: 0, monthRevenueEx: 0, prevUnits: 0, units90: 0, units365: 0, revenue365Ex: 0, lastSold: null, unitsAfter: 0, monthly: {} }; per.set(sku, a) }
    const d = meta.date
    if (d >= start && d <= end) { a.monthUnits += qty; a.monthRevenueEx += ex }
    if (d >= prev.start && d <= prev.end) a.prevUnits += qty
    if (d >= d90 && d <= end) a.units90 += qty
    if (d >= d365 && d <= end) { a.units365 += qty; a.revenue365Ex += ex }
    // ⚠ Bound to the reported month. The fetch runs to TODAY, so without this an
    // item sold after month end gave a lastSold beyond `end` and a NEGATIVE
    // "days since last sold" (Chris spotted -11 on a July report, 2026-08-24).
    // A month-end snapshot must only know what it could have known then.
    if (d <= end && (!a.lastSold || d > a.lastSold)) a.lastSold = d
    if (d > end) a.unitsAfter += qty
    const mk = monthKey(d)
    const m = a.monthly[mk] || { units: 0, revEx: 0 }
    m.units += qty; m.revEx += ex
    a.monthly[mk] = m
  }

  const enriched: EomItem[] = items.map((it: any) => {
    const sku = String(it.Number || '').trim()
    const onHand = num(it.QuantityOnHand)
    const avgCost = num(it.AverageCost)
    const sellInc = num(it.SellingBaseSellingPrice)
    const incTax = it.SellingIsTaxInclusive === true
    const sellEx = sellInc > 0 ? (incTax && String(it.SellingTaxCodeCode || '') === 'GST' ? sellInc / 1.1 : sellInc) : 0
    const a = per.get(sku)
    const monthUnits = a ? a.monthUnits : 0
    const monthRevenueEx = a ? a.monthRevenueEx : 0
    const monthCogs = monthUnits * avgCost
    const units90 = a ? a.units90 : 0
    const lastSold = a?.lastSold || null
    const runRatePerDay = units90 / 90

    // Sales history over the chosen window, straight off the per-month tallies
    // already built above. A month with no sale contributes a zero, so the
    // averages are per month of the WINDOW, not per month that happened to sell.
    const series = histWin.months.map(mk => a?.monthly[mk] || { units: 0, revEx: 0 })
    const historyUnits = series.reduce((t, m) => t + m.units, 0)
    const historyRevenueEx = series.reduce((t, m) => t + m.revEx, 0)
    const avgUnitsPerMonth = historyUnits / histWin.months.length
    const avgRevenuePerMonth = historyRevenueEx / histWin.months.length
    const supplierRaw = it.RestockingSupplierName ? String(it.RestockingSupplierName) : null
    return {
      sku, name: String(it.Name || ''),
      supplier: supplierRaw && supplierRaw !== '*None' ? supplierRaw : null,
      onHand, available: num(it.QuantityAvailable), committed: num(it.QuantityCommitted), onOrder: num(it.QuantityOnOrder),
      avgCost, stockValue: num(it.CurrentValue),
      sellEx, marginPct: sellEx > 0 ? (sellEx - avgCost) / sellEx : null,
      marginDollar: sellEx > 0 ? sellEx - avgCost : null,
      lastPurchasePrice: it.BuyingLastPurchasePrice != null ? num(it.BuyingLastPurchasePrice) : null,
      reorderLevel: num(it.RestockingMinimumLevelForRestockingAlert),
      reorderQty: num(it.RestockingDefaultOrderQuantity),
      monthUnits, monthRevenueEx, monthCogs, monthMargin: monthRevenueEx - monthCogs,
      prevMonthUnits: a ? a.prevUnits : 0,
      units90, units365: a ? a.units365 : 0,
      lastSold: lastSold ? lastSold.toISOString().slice(0, 10) : null,
      daysSinceLastSold: lastSold ? Math.max(0, Math.round((end.getTime() - lastSold.getTime()) / 86400000)) : null,
      unitsSinceMonthEnd: a ? a.unitsAfter : 0,
      runRatePerDay,
      daysOfCover: runRatePerDay > 0 ? onHand / runRatePerDay : null,
      // Capped at MYOB's own CurrentValue: onHand x avgCost can drift from it.
      capitalAtRisk: r2(Math.min(num(it.CurrentValue), Math.max(0, onHand - runRatePerDay * TARGET_COVER_DAYS) * avgCost)),
      historyUnits: r2(historyUnits), historyRevenueEx: r2(historyRevenueEx),
      avgUnitsPerMonth: r2(avgUnitsPerMonth), avgRevenuePerMonth: r2(avgRevenuePerMonth),
      monthsCoverAtAvg: avgUnitsPerMonth > 0 ? r2(onHand / avgUnitsPerMonth) : null,
      growthPct: halfOverHalfGrowth(series),
    }
  })

  const held = enriched.filter(i => i.stockValue > 0)
  const stockValue = enriched.reduce((s, i) => s + i.stockValue, 0)
  const monthRevenueEx = enriched.reduce((s, i) => s + i.monthRevenueEx, 0)
  const monthCogs = enriched.reduce((s, i) => s + i.monthCogs, 0)
  const cogs12m = enriched.reduce((s, i) => s + i.units365 * i.avgCost, 0)
  const turns = stockValue > 0 ? cogs12m / stockValue : null

  // Never-sold stock is EXCLUDED from every "not moving" list (Chris,
  // 2026-08-25). On this item list a SKU that has never been invoiced is
  // almost always a kit component that is never sold on its own, so listing it
  // as dead capital is noise — it dominated the dead-stock figure ($47.6k of
  // July's $114.7k) and no action follows from it. The count and value stay in
  // the headline so the capital is visible, not silently dropped.
  const neverSold = held.filter(i => i.lastSold === null)
  const soldEver = held.filter(i => i.lastSold !== null)
  const analysedValue = soldEver.reduce((s, i) => s + i.stockValue, 0)

  const dead90 = soldEver.filter(i => i.units90 === 0)
  const dead180 = soldEver.filter(i => i.daysSinceLastSold !== null && i.daysSinceLastSold > 180)
  const overstock = soldEver.filter(i => i.daysOfCover !== null && i.daysOfCover > OVERSTOCK_DAYS)

  // Slow movers are about CAPITAL, not just silence (Chris, 2026-08-25). Two
  // ways onto the list: nothing sold in the 90 days to month end, OR it is
  // still selling but carries more than SLOW_COVER_DAYS of cover with at least
  // SLOW_CAPITAL_MIN tied up beyond a 90-day target. Ranked by capital at risk,
  // so the money sits at the top rather than the longest-idle SKU.
  const slowMovers: EomSlowMover[] = soldEver
    .filter(i => i.units90 === 0 ||
      (i.daysOfCover !== null && i.daysOfCover > SLOW_COVER_DAYS && i.capitalAtRisk >= SLOW_CAPITAL_MIN))
    .map(i => ({
      ...i,
      slowReason: i.units90 === 0
        ? `no sale in the 90 days to month end`
        : `${Math.round(i.daysOfCover!)} days of cover — ${money(i.capitalAtRisk)} past a 90-day hold`,
    }))
    .sort((a, b) => b.capitalAtRisk - a.capitalAtRisk)

  // Reorder: below the alert level, or cover under 60 days on something that
  // actually moves. Quantity respects MOQ where MYOB has one.
  // An empty sheet would silently produce an empty reorder list, which reads as
  // "nothing to buy" — the worst possible failure. Fall back to every item and
  // say so in the notes instead.
  const useSheet = sheet.size > 0
  const orderable = useSheet ? enriched.filter(i => sheet.has(i.sku.trim().toUpperCase())) : enriched

  const candidate = (i: EomItem) =>
    (i.reorderLevel > 0 && i.onHand <= i.reorderLevel) || (i.daysOfCover !== null && i.daysOfCover < 60 && i.units90 > 0)
  const reorderExcludedCount = useSheet
    ? enriched.filter(i => !sheet.has(i.sku.trim().toUpperCase()) && candidate(i)).length
    : 0

  const reorder = orderable
    .map(i => {
      const belowLevel = i.reorderLevel > 0 && i.onHand <= i.reorderLevel
      const thinCover = i.daysOfCover !== null && i.daysOfCover < 60 && i.units90 > 0
      if (!belowLevel && !thinCover) return null
      const target = Math.max(i.reorderLevel, Math.ceil(i.runRatePerDay * 90))
      const gap = Math.max(0, target - i.onHand - i.onOrder)
      const suggestQty = Math.max(gap, i.reorderQty > 0 && gap > 0 ? i.reorderQty : 0)
      if (suggestQty <= 0) return null
      return {
        ...i, suggestQty, suggestCost: r2(suggestQty * (i.lastPurchasePrice || i.avgCost)),
        reason: belowLevel && thinCover ? 'below alert level + thin cover' : belowLevel ? 'below alert level' : 'under 60 days cover',
      }
    })
    .filter(Boolean) as EomReport['reorder']

  const belowCost = enriched.filter(i => i.monthUnits > 0 && i.sellEx > 0 && i.avgCost > 0 && i.sellEx < i.avgCost)
  const costCreep = enriched.filter(i =>
    i.lastPurchasePrice != null && i.lastPurchasePrice > 0 && i.avgCost > 0 &&
    i.lastPurchasePrice > i.avgCost * (1 + COST_CREEP_PCT) && i.sellEx > 0)
  const unfilledDemand = enriched.filter(i => i.monthUnits > 0 && (i.available <= 0 || i.committed > i.onHand))

  const ageBuckets: Array<[string, (i: EomItem) => boolean]> = [
    ['Sold in last 30 days', i => i.daysSinceLastSold !== null && i.daysSinceLastSold <= 30],
    ['30–90 days', i => i.daysSinceLastSold !== null && i.daysSinceLastSold > 30 && i.daysSinceLastSold <= 90],
    ['90–180 days', i => i.daysSinceLastSold !== null && i.daysSinceLastSold > 90 && i.daysSinceLastSold <= 180],
    ['180–365 days', i => i.daysSinceLastSold !== null && i.daysSinceLastSold > 180 && i.daysSinceLastSold <= 365],
    ['Over a year', i => i.daysSinceLastSold !== null && i.daysSinceLastSold > 365],
  ]
  const ageing = ageBuckets.map(([bucket, test]) => {
    const rows = soldEver.filter(test)
    return { bucket, skus: rows.length, value: r2(rows.reduce((s, i) => s + i.stockValue, 0)) }
  })

  const bySupplier = new Map<string, { supplier: string; skus: number; stockValue: number; monthRevenueEx: number; reorderCost: number }>()
  for (const i of enriched) {
    const k = i.supplier || '(no supplier set)'
    const row = bySupplier.get(k) || { supplier: k, skus: 0, stockValue: 0, monthRevenueEx: 0, reorderCost: 0 }
    row.skus++; row.stockValue += i.stockValue; row.monthRevenueEx += i.monthRevenueEx
    bySupplier.set(k, row)
  }
  for (const r of reorder) {
    const row = bySupplier.get(r.supplier || '(no supplier set)')
    if (row) row.reorderCost += r.suggestCost
  }

  const integrity: EomReport['integrity'] = []
  for (const i of enriched) {
    if (i.onHand < 0) integrity.push({ sku: i.sku, name: i.name, issue: 'Negative on-hand', detail: `${i.onHand} units` })
    else if (i.onHand > 0 && i.avgCost <= 0) integrity.push({ sku: i.sku, name: i.name, issue: 'Stock with no cost', detail: `${i.onHand} units at $0 average cost` })
    if (i.onHand > 0 && i.sellEx <= 0) integrity.push({ sku: i.sku, name: i.name, issue: 'No selling price', detail: `${i.onHand} units held` })
    if (i.marginPct !== null && i.marginPct < 0 && i.onHand > 0) integrity.push({ sku: i.sku, name: i.name, issue: 'Sell price below cost', detail: `sell $${r2(i.sellEx)} ex vs cost $${r2(i.avgCost)}` })
  }

  // Stocktakes completed inside the month (report-only, migration 141)
  let stocktake: EomReport['stocktake'] = null
  try {
    const { data } = await sb().from('jaws_stocktake_uploads')
      .select('completed_at, matched_count, unmatched_count')
      .gte('completed_at', start.toISOString()).lte('completed_at', end.toISOString())
    if (data && data.length) {
      stocktake = {
        count: data.length,
        latest: data.map(d => d.completed_at).sort().slice(-1)[0]?.slice(0, 10) || null,
        matched: data.reduce((s, d) => s + (d.matched_count || 0), 0),
        unmatched: data.reduce((s, d) => s + (d.unmatched_count || 0), 0),
      }
    }
  } catch { /* report-only extra; never fail the run for it */ }

  const { data: hist } = await sb().from('jaws_stock_snapshots')
    .select('month, stock_value, month_revenue_ex, month_margin_pct, dead_90_value, turns_annualised')
    .order('month', { ascending: true }).limit(24)
  const trend = (hist || []).filter(h => h.month <= month).map(h => ({
    month: h.month, stockValue: Number(h.stock_value) || 0, monthRevenueEx: Number(h.month_revenue_ex) || 0,
    monthMarginPct: h.month_margin_pct == null ? null : Number(h.month_margin_pct),
    deadValue: Number(h.dead_90_value) || 0,
    turns: h.turns_annualised == null ? null : Number(h.turns_annualised),
  }))

  // Whole-business sales by month across the window — the growth/decline read.
  const historySeries = histWin.months.map(mk => {
    let units = 0, revenueEx = 0
    Array.from(per.values()).forEach(a => {
      const m = a.monthly[mk]
      if (m) { units += m.units; revenueEx += m.revEx }
    })
    return { month: mk, units: r2(units), revenueEx: r2(revenueEx) }
  })
  const historyUnitsTotal = historySeries.reduce((t, m) => t + m.units, 0)
  const historyRevenueTotal = historySeries.reduce((t, m) => t + m.revenueEx, 0)
  const halfSize = Math.floor(historySeries.length / 2)
  const firstHalf = historySeries.slice(0, halfSize)
  const secondHalf = historySeries.slice(historySeries.length - halfSize)
  const halfLabel = (rows: typeof historySeries) => rows.length ? `${rows[0].month} – ${rows[rows.length - 1].month}` : null
  const history: EomReport['history'] = {
    from: histWin.from, to: histWin.to, months: histWin.months.length,
    unitsTotal: r2(historyUnitsTotal), revenueExTotal: r2(historyRevenueTotal),
    avgUnitsPerMonth: r2(historyUnitsTotal / histWin.months.length),
    avgRevenuePerMonth: r2(historyRevenueTotal / histWin.months.length),
    growthPct: halfOverHalfGrowth(historySeries.map(m => ({ units: m.units, revEx: m.revenueEx }))),
    firstHalfLabel: halfSize ? halfLabel(firstHalf) : null,
    firstHalfRevenueEx: halfSize ? r2(firstHalf.reduce((t, m) => t + m.revenueEx, 0)) : null,
    secondHalfLabel: halfSize ? halfLabel(secondHalf) : null,
    secondHalfRevenueEx: halfSize ? r2(secondHalf.reduce((t, m) => t + m.revenueEx, 0)) : null,
    series: historySeries,
  }

  const byMonthUnits = (a: EomItem, b: EomItem) => b.monthUnits - a.monthUnits
  const cut = (rows: EomItem[]) => rows.slice(0, LIST_CAP)

  return {
    month, monthLabel: label, generatedAt: now.toISOString(),
    headline: {
      skus: enriched.length,
      stockValue: r2(stockValue),
      qtyOnHand: r2(enriched.reduce((s, i) => s + i.onHand, 0)),
      qtyOnOrder: r2(enriched.reduce((s, i) => s + i.onOrder, 0)),
      qtyCommitted: r2(enriched.reduce((s, i) => s + i.committed, 0)),
      monthUnits: r2(enriched.reduce((s, i) => s + i.monthUnits, 0)),
      monthRevenueEx: r2(monthRevenueEx),
      monthCogs: r2(monthCogs),
      monthMargin: r2(monthRevenueEx - monthCogs),
      monthMarginPct: monthRevenueEx > 0 ? r2((monthRevenueEx - monthCogs) / monthRevenueEx) : null,
      turnsAnnualised: turns == null ? null : r2(turns),
      daysInventory: turns && turns > 0 ? Math.round(365 / turns) : null,
      lowStockCount: enriched.filter(i => i.onHand > 0 && i.reorderLevel > 0 && i.onHand <= i.reorderLevel).length,
      outOfStockCount: enriched.filter(i => i.onHand <= 0).length,
      dead90Count: dead90.length, dead90Value: r2(dead90.reduce((s, i) => s + i.stockValue, 0)),
      dead180Count: dead180.length, dead180Value: r2(dead180.reduce((s, i) => s + i.stockValue, 0)),
      neverSoldCount: neverSold.length, neverSoldValue: r2(neverSold.reduce((s, i) => s + i.stockValue, 0)),
      analysedValue: r2(analysedValue),
      slowCount: slowMovers.length, slowCapital: r2(slowMovers.reduce((s, i) => s + i.capitalAtRisk, 0)),
      overstockCount: overstock.length, overstockValue: r2(overstock.reduce((s, i) => s + i.stockValue, 0)),
      reorderCount: reorder.length, reorderCost: r2(reorder.reduce((s, i) => s + i.suggestCost, 0)),
      reorderSheetSize: sheet.size, reorderExcludedCount,
      activeSkusThisMonth: enriched.filter(i => i.monthUnits > 0).length,
    },
    history,
    ageing,
    topByUnits: cut([...enriched].filter(i => i.monthUnits > 0).sort(byMonthUnits)),
    topByRevenue: cut([...enriched].filter(i => i.monthRevenueEx > 0).sort((a, b) => b.monthRevenueEx - a.monthRevenueEx)),
    topByMargin: cut([...enriched].filter(i => i.monthMargin > 0).sort((a, b) => b.monthMargin - a.monthMargin)),
    slowMovers: slowMovers.slice(0, LIST_CAP),
    reorder: reorder.sort((a, b) => b.suggestCost - a.suggestCost).slice(0, LIST_CAP * 2),
    belowCost: cut([...belowCost].sort((a, b) => (a.sellEx - a.avgCost) - (b.sellEx - b.avgCost))),
    costCreep: cut([...costCreep].sort((a, b) => (b.lastPurchasePrice! - b.avgCost) - (a.lastPurchasePrice! - a.avgCost))),
    unfilledDemand: cut([...unfilledDemand].sort(byMonthUnits)),
    overstock: cut([...overstock].sort((a, b) => b.stockValue - a.stockValue)),
    suppliers: Array.from(bySupplier.values())
      .map(s => ({ ...s, stockValue: r2(s.stockValue), monthRevenueEx: r2(s.monthRevenueEx), reorderCost: r2(s.reorderCost) }))
      .sort((a, b) => b.stockValue - a.stockValue).slice(0, LIST_CAP),
    integrity: integrity.slice(0, LIST_CAP * 2),
    stocktake,
    trend,
    notes: [
      `On-hand quantities read from MYOB at ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC — "as at now", not the last instant of ${label}. AccountRight exposes no historical quantity.`,
      'COGS and margin use units × current average cost. Invoice lines carry no cost of sale, so these figures rank SKUs reliably but are not the P&L.',
      `Stock turn = trailing 12-month COGS ÷ current stock value. Overstock = more than ${OVERSTOCK_DAYS} days of cover at the 90-day run rate.`,
      `Stock that has NEVER sold is excluded from the ageing, dead-stock and slow-mover figures — on this item list it is almost always a kit component that is never sold separately.${neverSold.length ? ` ${neverSold.length} SKU(s) holding ${money(r2(neverSold.reduce((s, i) => s + i.stockValue, 0)))} were excluded on that basis.` : ''} The ageing shares are of the ${money(r2(analysedValue))} analysed, not the whole holding.`,
      `Slow movers are ranked by capital at risk — the value held beyond ${TARGET_COVER_DAYS} days of that SKU's own demand. A SKU joins the list when nothing sold in the 90 days to month end, or when it still sells but holds over ${SLOW_COVER_DAYS} days of cover with at least ${money(SLOW_CAPITAL_MIN)} past that target. Overstock (>${OVERSTOCK_DAYS} days) is the extreme end of the same list, shown separately.`,
      'Every sales figure is as at the end of the reported month — sales made after it are excluded, so a re-run of an old month gives the same answer. "Sold since" shows what has moved since, so a slow mover that has started selling again is obvious.',
      'Revenue is ex-GST, normalised per invoice using the parent tax-inclusive flag and the line tax code (lib/gst).',
      `Averages, months-of-cover and growth are measured over ${history.months} month(s), ${history.from} to ${history.to}${history.months === DEFAULT_HISTORY_MONTHS && history.to === month ? ' (the default window)' : ' (chosen on the report)'}. A month with no sale counts as a zero, so an average is per month of the window, not per month that happened to sell. Growth compares the back half of the window with the front half; on an odd number of months the middle one is dropped so both halves are equal.`,
      'Months of cover uses the window average; "cover (days)" elsewhere uses the last 90 days only, so a seasonal SKU can look very different under the two — that difference is the point.',
      useSheet
        ? `Reorder suggestions cover only the ${sheet.size} SKUs on the Stock Order sheet — MYOB's item list also holds kit components that are never sold separately.${reorderExcludedCount ? ` ${reorderExcludedCount} item(s) off the sheet were below their alert level and excluded; add a SKU to the Stock Order sheet if it should be ordered.` : ''}`
        : 'The Stock Order sheet is empty, so reorder suggestions cover EVERY MYOB item — expect kit components in the list until the sheet is populated.',
    ],
  }
}

function previousMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return monthKey(new Date(Date.UTC(y, m - 2, 1)))
}

export async function saveSnapshot(rep: EomReport, userId?: string | null): Promise<void> {
  const h = rep.headline
  const { error } = await sb().from('jaws_stock_snapshots').upsert({
    month: rep.month, generated_at: rep.generatedAt, generated_by: userId || null,
    skus: h.skus, stock_value: h.stockValue, qty_on_hand: h.qtyOnHand, qty_on_order: h.qtyOnOrder, qty_committed: h.qtyCommitted,
    month_units: h.monthUnits, month_revenue_ex: h.monthRevenueEx, month_cogs: h.monthCogs,
    month_margin: h.monthMargin, month_margin_pct: h.monthMarginPct,
    turns_annualised: h.turnsAnnualised, days_inventory: h.daysInventory,
    low_stock_count: h.lowStockCount, out_of_stock_count: h.outOfStockCount,
    dead_90_count: h.dead90Count, dead_90_value: h.dead90Value,
    dead_180_count: h.dead180Count, dead_180_value: h.dead180Value,
    never_sold_count: h.neverSoldCount, never_sold_value: h.neverSoldValue,
    slow_count: h.slowCount, slow_capital: h.slowCapital,
    history_from: rep.history.from, history_to: rep.history.to,
    history_months: rep.history.months,
    avg_monthly_revenue_ex: rep.history.avgRevenuePerMonth,
    sales_growth_pct: rep.history.growthPct,
    overstock_count: h.overstockCount, overstock_value: h.overstockValue,
    reorder_count: h.reorderCount, reorder_cost: h.reorderCost,
    payload: rep,
  }, { onConflict: 'month' })
  if (error) throw new Error(`jaws_stock_snapshots write failed: ${error.message}`)
}

export async function loadSnapshot(month: string): Promise<EomReport | null> {
  const { data } = await sb().from('jaws_stock_snapshots').select('payload').eq('month', month).maybeSingle()
  return (data?.payload as EomReport) || null
}

export async function listSnapshotMonths(): Promise<Array<{ month: string; generated_at: string }>> {
  const { data } = await sb().from('jaws_stock_snapshots').select('month, generated_at').order('month', { ascending: false }).limit(36)
  return data || []
}

// ── the month-end email ──────────────────────────────────────────────────

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-AU')
const pct = (n: number | null) => n == null ? '—' : `${(n * 100).toFixed(1)}%`

function delta(now: number, before: number | undefined | null): string {
  if (before == null || before === 0) return ''
  const d = now - before
  const p = (d / Math.abs(before)) * 100
  const up = d >= 0
  const colour = up ? '#0a7c42' : '#b3261e'
  return `<span style="color:${colour};font-size:12px"> ${up ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%</span>`
}

export function renderEomEmail(rep: EomReport, portalUrl: string): { subject: string; html: string } {
  const h = rep.headline
  const prev = rep.trend.filter(t => t.month < rep.month).slice(-1)[0]
  const row = (label: string, value: string, extra = '') =>
    `<tr><td style="padding:5px 14px 5px 0;color:#555">${esc(label)}</td><td style="padding:5px 0;font-weight:600">${value}${extra}</td></tr>`

  const listTable = (title: string, rows: string[][], head: string[]) => {
    if (!rows.length) return `<h3 style="font-size:14px;margin:18px 0 6px">${esc(title)}</h3><p style="margin:0;color:#666;font-size:13px">Nothing to report.</p>`
    return `<h3 style="font-size:14px;margin:18px 0 6px">${esc(title)}</h3>
      <table style="border-collapse:collapse;font-size:12.5px;width:100%">
        <tr>${head.map(c => `<th align="left" style="border-bottom:1px solid #ddd;padding:4px 8px 4px 0;color:#666;font-weight:600">${esc(c)}</th>`).join('')}</tr>
        ${rows.map(r => `<tr>${r.map((c, i) => `<td style="padding:4px 8px 4px 0;border-bottom:1px solid #f1f1f1${i ? ';text-align:right' : ''}">${c}</td>`).join('')}</tr>`).join('')}
      </table>`
  }

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:760px;margin:0 auto">
    <div style="border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:14px">
      <div style="font-size:18px;font-weight:700">Just Autos — JAWS Stock, ${esc(rep.monthLabel)}</div>
      <div style="font-size:12px;color:#666;margin-top:3px">Month-end report · stock on hand as at ${esc(rep.generatedAt.slice(0, 10))}${rep.history ? ` · sales history ${esc(rep.history.from)} – ${esc(rep.history.to)}` : ''}</div>
    </div>

    <table style="border-collapse:collapse;margin-bottom:6px">
      ${row('Stock on hand', money(h.stockValue), delta(h.stockValue, prev?.stockValue))}
      ${row('Sales this month (ex GST)', money(h.monthRevenueEx), delta(h.monthRevenueEx, prev?.monthRevenueEx))}
      ${row('Gross margin', `${money(h.monthMargin)} (${pct(h.monthMarginPct)})`, prev?.monthMarginPct != null && h.monthMarginPct != null ? delta(h.monthMarginPct, prev.monthMarginPct) : '')}
      ${row('Stock turn (12m)', h.turnsAnnualised == null ? '—' : `${h.turnsAnnualised.toFixed(2)}× · ${h.daysInventory} days of inventory`)}
      ${row('SKUs sold this month', `${h.activeSkusThisMonth} of ${h.skus}`)}
      ${rep.history ? row('Average sales / month', `${money(rep.history.avgRevenuePerMonth)} over ${rep.history.months} months (${rep.history.from} – ${rep.history.to})`) : ''}
      ${rep.history && rep.history.growthPct != null ? row('Growth over that window', `${rep.history.growthPct >= 0 ? '+' : ''}${(rep.history.growthPct * 100).toFixed(1)}% — ${rep.history.secondHalfLabel} vs ${rep.history.firstHalfLabel}`) : ''}
      ${row('Dead stock (no sale 90d)', `${money(h.dead90Value)} across ${h.dead90Count} SKUs`, delta(h.dead90Value, prev?.deadValue))}
      ${row('Slow movers — capital at risk', `${money(h.slowCapital)} across ${h.slowCount} SKUs`)}
      ${row('Overstock (>1yr cover)', `${money(h.overstockValue)} across ${h.overstockCount} SKUs`)}
      ${row('Never sold (excluded)', `${money(h.neverSoldValue)} across ${h.neverSoldCount} SKUs — treated as kit parts`)}
      ${row('Out of stock / low', `${h.outOfStockCount} out · ${h.lowStockCount} low`)}
      ${row('Reorder suggested', `${h.reorderCount} SKUs · ${money(h.reorderCost)} to buy`)}
    </table>

    ${listTable('Top movers this month (units)', rep.topByUnits.slice(0, 10).map(i =>
      [esc(i.sku) + ' <span style="color:#888">' + esc(i.name.slice(0, 32)) + '</span>', String(r2(i.onHand)), String(r2(i.monthUnits)), String(r2(i.avgUnitsPerMonth)), money(i.monthRevenueEx), pct(i.marginPct)]),
      ['SKU', 'On hand', 'Units', 'Avg/mo', 'Revenue ex', 'Margin'])}

    ${listTable('Biggest margin earners this month', rep.topByMargin.slice(0, 10).map(i =>
      [esc(i.sku) + ' <span style="color:#888">' + esc(i.name.slice(0, 38)) + '</span>', money(i.monthMargin), pct(i.marginPct)]),
      ['SKU', 'Margin $', 'Margin %'])}

    ${listTable('Slow movers — where the capital is stuck', rep.slowMovers.slice(0, 10).map(i =>
      [esc(i.sku) + ' <span style="color:#888">' + esc(i.name.slice(0, 30)) + '</span>', money(i.capitalAtRisk), money(i.stockValue), String(r2(i.onHand)), i.monthsCoverAtAvg == null ? '—' : i.monthsCoverAtAvg.toFixed(1), esc(i.slowReason)]),
      ['SKU', 'Capital at risk', 'Value held', 'On hand', 'Months cover', 'Why'])}

    ${listTable(`Reorder suggestions — Stock Order sheet only (${h.reorderSheetSize} SKUs)`, rep.reorder.slice(0, 12).map(i =>
      [esc(i.sku) + ' <span style="color:#888">' + esc(i.name.slice(0, 34)) + '</span>', String(r2(i.suggestQty)), money(i.suggestCost), esc(i.reason)]),
      ['SKU', 'Qty', 'Est. cost', 'Why'])}

    ${rep.unfilledDemand.length ? listTable('Sold while out of stock — demand you could not fill', rep.unfilledDemand.slice(0, 8).map(i =>
      [esc(i.sku) + ' <span style="color:#888">' + esc(i.name.slice(0, 38)) + '</span>', String(r2(i.monthUnits)), String(r2(i.available))]),
      ['SKU', 'Units sold', 'Available']) : ''}

    ${rep.costCreep.length ? listTable('Cost creep — buy price up, sell price unchanged', rep.costCreep.slice(0, 8).map(i =>
      [esc(i.sku) + ' <span style="color:#888">' + esc(i.name.slice(0, 34)) + '</span>', money(i.avgCost), money(i.lastPurchasePrice || 0), pct(i.marginPct)]),
      ['SKU', 'Avg cost', 'Last paid', 'Margin now']) : ''}

    <p style="margin:20px 0 6px"><a href="${esc(portalUrl)}/reports/jaws-stock-eom?month=${esc(rep.month)}" style="color:#4f8ef7;font-weight:600">Open the full report in the portal →</a></p>
    <div style="border-top:1px solid #eee;margin-top:16px;padding-top:10px;color:#888;font-size:11.5px">
      ${rep.notes.map(n => `<div style="margin-bottom:4px">${esc(n)}</div>`).join('')}
      Just Autos Mechanical · generated automatically by the Just Autos portal.
    </div>
  </div>`

  return { subject: `JAWS stock — ${rep.monthLabel}: ${money(h.stockValue)} on hand, ${money(h.monthMargin)} margin`, html }
}

export async function emailEomReport(rep: EomReport): Promise<string[]> {
  const cfg = await getIntegrations(['JAWS_EOM_EMAIL_TO', 'PORTAL_BASE_URL'])
  const to = (cfg.JAWS_EOM_EMAIL_TO || 'chris@justautosmechanical.com.au,morgan@justautosmechanical.com.au')
    .split(/[,;]+/).map(s => s.trim()).filter(Boolean)
  const portalUrl = cfg.PORTAL_BASE_URL || 'https://justautos.app'
  const mail = renderEomEmail(rep, portalUrl)
  await sendMail(to[0], { to, subject: mail.subject, html: mail.html })
  return to
}
