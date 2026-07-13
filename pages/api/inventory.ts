// pages/api/inventory.ts
// Inventory analytics for the JAWS company file.
// Returns one payload that powers all six inventory views:
//   1. Low stock / reorder alerts
//   2. Velocity & top sellers (units, $)
//   3. Dead stock (held value, no sales in X months)
//   4. Forecasting (90-day run rate, days of cover, stockout ETA)
//   5. Margin analysis (avg cost vs sell price ex-GST)
//   6. Purchase-order pipeline (qty on order)
//
// CData cannot JOIN Items <-> SaleInvoiceItems server-side.
// We pull items + 12 months of item-level sales, join in memory by ItemNumber == Items.Number.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { fetchInventoryItems, fetchSaleInvoicesWithLines } from '../../lib/myob-reporting'
import { lineExGst } from '../../lib/gst'

// ── types ────────────────────────────────────────────────────────────────
type Row = Record<string, any>

interface InventoryItem {
  number: string
  name: string
  qtyOnHand: number
  qtyAvailable: number
  qtyCommitted: number
  qtyOnOrder: number
  avgCost: number
  stockValue: number
  sellPriceIncGst: number
  sellPriceExGst: number
  marginPct: number | null
  marginDollar: number | null
  reorderLevel: number
  reorderQty: number
  supplier: string | null
  supplierId: string | null
  lastPurchasePrice: number | null

  unitsSold30d: number
  unitsSold90d: number
  unitsSold365d: number
  revenue90d: number
  lastSoldDate: string | null
  daysSinceLastSold: number | null
  runRatePerDay: number
  daysOfCover: number | null
  stockoutDate: string | null
  stockoutStatus: 'out' | 'critical' | 'low' | 'ok' | 'dead' | 'noSales'

  isLowStock: boolean
  isOutOfStock: boolean
  isDead90d: boolean
  isDead180d: boolean
}

interface TotalsBlock {
  totalItems: number
  totalSkus: number
  stockValue: number
  qtyOnHand: number
  qtyOnOrder: number
  qtyCommitted: number
  lowStockCount: number
  outOfStockCount: number
  deadStock90dCount: number
  deadStock90dValue: number
  deadStock180dCount: number
  deadStock180dValue: number
  reorderSuggestCount: number
  reorderSuggestValue: number
}

interface MonthlyPoint { month: string; label: string; units: number; revenue: number }

// Use plain objects instead of Map<> to avoid downlevelIteration issues
interface Agg {
  units30: number; units90: number; units365: number
  revenue90Ex: number
  lastSold: Date | null
  monthlyUnits: Record<string, number>
  monthlyRevEx: Record<string, number>
}

// ── helpers ──────────────────────────────────────────────────────────────

function num(v: any): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86400000)
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[m - 1]} ${String(y).slice(2)}`
}

// ── handler ──────────────────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await requireAuth(req, res, async () => {
    try {
      const today = new Date()
      const d30  = addDays(today, -30)
      const d90  = addDays(today, -90)
      const d180 = addDays(today, -180)
      const d365 = addDays(today, -365)

      // Direct MYOB OAuth (CData decommissioned 2026-07-14).
      // 1) Active inventoried items.
      const items = await fetchInventoryItems('JAWS')

      // 2+3) Last 12 months of sale invoices WITH their lines (one pass). The
      // header carries IsTaxInclusive (to normalise line totals) + Date; the
      // flattened lines carry ItemNumber/ShipQuantity/Total/TaxCodeCode.
      const { invoices, lines: allLines } = await fetchSaleInvoicesWithLines('JAWS', {
        start: d365.toISOString().slice(0, 10),
      })

      // Invoice lookup: id -> { date, isTaxInclusive }
      const invById: Record<string, { date: Date; isTaxInclusive: boolean }> = {}
      for (const inv of invoices) {
        if (!inv.ID || !inv.Date) continue
        invById[String(inv.ID)] = { date: new Date(inv.Date), isTaxInclusive: inv.IsTaxInclusive }
      }

      const lines = allLines.filter(l => l.ItemNumber)

      // ── 4) Aggregate per-item velocity from lines ────────────────────
      const perItem: Record<string, Agg> = {}

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const itemNum = line.ItemNumber ? String(line.ItemNumber).trim() : ''
        if (!itemNum) continue
        const invMeta = invById[String(line.SaleInvoiceId)]
        if (!invMeta) continue // invoice outside 12-month window
        const invDate = invMeta.date

        const qty = num(line.ShipQuantity)
        const totalRaw = num(line.Total)
        // CORRECT ex-GST: depends on BOTH parent's IsTaxInclusive AND line's TaxCodeCode.
        // Previous bug: applied /1.1 to all GST-coded lines regardless of parent flag.
        const totalEx = lineExGst(totalRaw, invMeta.isTaxInclusive, line.TaxCodeCode)

        let a = perItem[itemNum]
        if (!a) {
          a = {
            units30: 0, units90: 0, units365: 0,
            revenue90Ex: 0,
            lastSold: null,
            monthlyUnits: {},
            monthlyRevEx: {},
          }
          perItem[itemNum] = a
        }

        if (invDate >= d30)  a.units30  += qty
        if (invDate >= d90)  { a.units90 += qty; a.revenue90Ex += totalEx }
        if (invDate >= d365) a.units365 += qty

        if (!a.lastSold || invDate > a.lastSold) a.lastSold = invDate

        const mk = monthKey(invDate)
        a.monthlyUnits[mk] = (a.monthlyUnits[mk] || 0) + qty
        a.monthlyRevEx[mk] = (a.monthlyRevEx[mk] || 0) + totalEx
      }

      // ── 5) Build enriched item records ───────────────────────────────
      const enriched: InventoryItem[] = items.map((it: Row) => {
        const number = String(it.Number || '').trim()
        const name = String(it.Name || '')
        const qtyOnHand = num(it.QuantityOnHand)
        const qtyAvailable = num(it.QuantityAvailable)
        const qtyCommitted = num(it.QuantityCommitted)
        const qtyOnOrder = num(it.QuantityOnOrder)
        const avgCost = num(it.AverageCost)
        const stockValue = num(it.CurrentValue)
        const sellInc = num(it.SellingBaseSellingPrice)
        const isIncTax = it.SellingIsTaxInclusive === true || it.SellingIsTaxInclusive === 1
        const taxCode = String(it.SellingTaxCodeCode || '')
        const sellEx = sellInc > 0
          ? (isIncTax && taxCode === 'GST' ? sellInc / 1.1 : sellInc)
          : 0
        const reorderLevel = num(it.RestockingMinimumLevelForRestockingAlert)
        const reorderQty = num(it.RestockingDefaultOrderQuantity)
        const supplierRaw = it.RestockingSupplierName ? String(it.RestockingSupplierName) : null
        const supplier = supplierRaw && supplierRaw !== '*None' ? supplierRaw : null
        const supplierIdRaw = it.RestockingSupplierDisplayID ? String(it.RestockingSupplierDisplayID) : null
        const supplierId = supplierIdRaw && supplierIdRaw !== '*None' ? supplierIdRaw : null

        const agg = perItem[number]
        const units30  = agg ? agg.units30  : 0
        const units90  = agg ? agg.units90  : 0
        const units365 = agg ? agg.units365 : 0
        const revenue90 = agg ? agg.revenue90Ex : 0
        const lastSold = agg && agg.lastSold ? agg.lastSold : null
        const daysSinceLastSold = lastSold ? daysBetween(today, lastSold) : null
        const runRatePerDay = units90 / 90
        const daysOfCover = runRatePerDay > 0 ? qtyOnHand / runRatePerDay : null
        const stockoutDate = (daysOfCover !== null && daysOfCover > 0 && qtyOnHand > 0)
          ? addDays(today, Math.round(daysOfCover)).toISOString().slice(0, 10)
          : null

        let marginPct: number | null = null
        let marginDollar: number | null = null
        if (sellEx > 0) {
          marginDollar = sellEx - avgCost
          marginPct = marginDollar / sellEx
        }

        const isOutOfStock = qtyOnHand <= 0
        const isLowStock = !isOutOfStock && reorderLevel > 0 && qtyOnHand <= reorderLevel
        const isDead90d = stockValue > 0 && units90 === 0
        const isDead180d = stockValue > 0 && (lastSold === null || lastSold < d180)

        let stockoutStatus: InventoryItem['stockoutStatus']
        if (isOutOfStock) stockoutStatus = 'out'
        else if (units90 === 0) stockoutStatus = stockValue > 0 ? 'dead' : 'noSales'
        else if (daysOfCover !== null && daysOfCover <= 14) stockoutStatus = 'critical'
        else if (daysOfCover !== null && daysOfCover <= 30) stockoutStatus = 'low'
        else stockoutStatus = 'ok'

        return {
          number, name,
          qtyOnHand, qtyAvailable, qtyCommitted, qtyOnOrder,
          avgCost, stockValue,
          sellPriceIncGst: sellInc,
          sellPriceExGst: sellEx,
          marginPct, marginDollar,
          reorderLevel, reorderQty,
          supplier, supplierId,
          lastPurchasePrice: it.BuyingLastPurchasePrice != null ? num(it.BuyingLastPurchasePrice) : null,
          unitsSold30d: units30,
          unitsSold90d: units90,
          unitsSold365d: units365,
          revenue90d: revenue90,
          lastSoldDate: lastSold ? lastSold.toISOString().slice(0, 10) : null,
          daysSinceLastSold,
          runRatePerDay,
          daysOfCover,
          stockoutDate,
          stockoutStatus,
          isLowStock, isOutOfStock, isDead90d, isDead180d,
        }
      })

      // ── 6) Totals ────────────────────────────────────────────────────
      const totals: TotalsBlock = {
        totalItems: enriched.length,
        totalSkus: enriched.length,
        stockValue: enriched.reduce((s, i) => s + i.stockValue, 0),
        qtyOnHand: enriched.reduce((s, i) => s + i.qtyOnHand, 0),
        qtyOnOrder: enriched.reduce((s, i) => s + i.qtyOnOrder, 0),
        qtyCommitted: enriched.reduce((s, i) => s + i.qtyCommitted, 0),
        lowStockCount: enriched.filter(i => i.isLowStock).length,
        outOfStockCount: enriched.filter(i => i.isOutOfStock).length,
        deadStock90dCount: enriched.filter(i => i.isDead90d).length,
        deadStock90dValue: enriched.filter(i => i.isDead90d).reduce((s, i) => s + i.stockValue, 0),
        deadStock180dCount: enriched.filter(i => i.isDead180d).length,
        deadStock180dValue: enriched.filter(i => i.isDead180d).reduce((s, i) => s + i.stockValue, 0),
        reorderSuggestCount: enriched.filter(i => i.isLowStock && i.reorderQty > 0).length,
        reorderSuggestValue: enriched
          .filter(i => i.isLowStock && i.reorderQty > 0)
          .reduce((s, i) => s + i.reorderQty * i.avgCost, 0),
      }

      // ── 7) Whole-portfolio monthly trend (last 12 months) ────────────
      const monthly: MonthlyPoint[] = []
      const perItemKeys = Object.keys(perItem)
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
        const key = monthKey(d)
        let units = 0, revenue = 0
        for (let j = 0; j < perItemKeys.length; j++) {
          const agg = perItem[perItemKeys[j]]
          units   += agg.monthlyUnits[key] || 0
          revenue += agg.monthlyRevEx[key] || 0
        }
        monthly.push({ month: key, label: monthLabel(key), units, revenue })
      }

      res.status(200).json({
        totals,
        items: enriched,
        monthly,
        meta: {
          company: 'JAWS',
          generatedAt: new Date().toISOString(),
          forecastWindowDays: 90,
          invoiceCount: invoices.length,
          lineCount: lines.length,
        },
      })
    } catch (err: any) {
      console.error('inventory api error:', err)
      res.status(500).json({ error: 'inventory_failed', message: String(err?.message || err) })
    }
  })
}
