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
import { cdataQuery } from '../../lib/cdata'

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

// ── helpers ──────────────────────────────────────────────────────────────
function rowsToObjects(result: any): Row[] {
  if (!result?.results?.[0]) return []
  const { schema, rows } = result.results[0]
  if (!schema || !rows) return []
  return rows.map((row: any[]) => {
    const o: Row = {}
    schema.forEach((c: any, i: number) => { o[c.columnName] = row[i] })
    return o
  })
}

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

      // ── 1) Pull all active inventoried items ─────────────────────────
      const itemsResult = await cdataQuery('JAWS', `
        SELECT
          Number, Name,
          QuantityOnHand, QuantityAvailable, QuantityCommitted, QuantityOnOrder,
          AverageCost, CurrentValue,
          SellingBaseSellingPrice, SellingIsTaxInclusive, SellingTaxCodeCode,
          RestockingMinimumLevelForRestockingAlert,
          RestockingDefaultOrderQuantity,
          RestockingSupplierName, RestockingSupplierDisplayID,
          BuyingLastPurchasePrice
        FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]
        WHERE IsActive = 1 AND IsInventoried = 1
        ORDER BY CurrentValue DESC
      `)
      const items = rowsToObjects(itemsResult)

      // ── 2) Pull last 12 months of sale invoices (for date lookups) ───
      // NOTE: SaleInvoices has no TaxCodeCode at header level — tax lives on lines.
      const invResult = await cdataQuery('JAWS', `
        SELECT ID, Date, Status
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE Date >= '${d365.toISOString().slice(0, 10)}'
      `)
      const invoices = rowsToObjects(invResult)
      const invIndex = new Map<string, { date: Date }>()
      for (const inv of invoices) {
        if (!inv.ID || !inv.Date) continue
        invIndex.set(String(inv.ID), { date: new Date(inv.Date) })
      }

      // ── 3) Pull all sale invoice items with a non-null ItemNumber ────
      const siiResult = await cdataQuery('JAWS', `
        SELECT SaleInvoiceId, ItemNumber, ShipQuantity, Total, TaxCodeCode
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
        WHERE ItemNumber IS NOT NULL
      `)
      const lines = rowsToObjects(siiResult)

      // ── 4) Aggregate per-item velocity from lines ────────────────────
      interface Agg {
        units30: number; units90: number; units365: number
        revenue90Ex: number
        lastSold: Date | null
        monthlyUnits: Map<string, number>
        monthlyRevEx: Map<string, number>
      }
      const perItem = new Map<string, Agg>()

      for (const line of lines) {
        const itemNum = line.ItemNumber ? String(line.ItemNumber).trim() : ''
        if (!itemNum) continue
        const inv = invIndex.get(String(line.SaleInvoiceId))
        if (!inv) continue // invoice outside 12-month window

        const qty = num(line.ShipQuantity)
        const totalInc = num(line.Total)
        const tax = String(line.TaxCodeCode || '')
        const totalEx = tax === 'GST' ? totalInc / 1.1 : totalInc

        let a = perItem.get(itemNum)
        if (!a) {
          a = {
            units30: 0, units90: 0, units365: 0,
            revenue90Ex: 0,
            lastSold: null,
            monthlyUnits: new Map(),
            monthlyRevEx: new Map(),
          }
          perItem.set(itemNum, a)
        }

        if (inv.date >= d30)  a.units30  += qty
        if (inv.date >= d90)  { a.units90 += qty; a.revenue90Ex += totalEx }
        if (inv.date >= d365) a.units365 += qty

        if (!a.lastSold || inv.date > a.lastSold) a.lastSold = inv.date

        const mk = monthKey(inv.date)
        a.monthlyUnits.set(mk, (a.monthlyUnits.get(mk) || 0) + qty)
        a.monthlyRevEx.set(mk, (a.monthlyRevEx.get(mk) || 0) + totalEx)
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

        const agg = perItem.get(number)
        const units30  = agg ? agg.units30  : 0
        const units90  = agg ? agg.units90  : 0
        const units365 = agg ? agg.units365 : 0
        const revenue90 = agg ? agg.revenue90Ex : 0
        const lastSold = agg?.lastSold || null
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
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
        const key = monthKey(d)
        let units = 0, revenue = 0
        for (const agg of perItem.values()) {
          units   += agg.monthlyUnits.get(key) || 0
          revenue += agg.monthlyRevEx.get(key) || 0
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
