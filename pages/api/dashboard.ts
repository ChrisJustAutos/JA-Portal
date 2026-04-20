// pages/api/dashboard.ts — Two-stage load with timeout protection
// All $ amounts returned are EX-GST (frontend applies inc-GST display multiplier).
//
// Key changes vs prior version:
//   - SELECT queries now include [TotalTax] and [IsTaxInclusive] columns
//   - We add TotalAmountExGst = TotalAmount - TotalTax to every invoice/bill row
//     (this formula is correct for both IsTaxInclusive=true AND =false invoices)
//   - topCustomers is computed in memory (not via SQL SUM) so we can apply
//     ex-GST normalisation before aggregating. Fixes 7.6% overstatement.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'
import { invoiceExGst, toNum } from '../../lib/gst'

export const config = { maxDuration: 60 }

const CACHE_TTL = 3 * 60 * 1000
const cache = new Map<string, { data: any; timestamp: number }>()

function getCached(key: string): any | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) { cache.delete(key); return null }
  return entry.data
}

function setCache(key: string, data: any) {
  cache.set(key, { data, timestamp: Date.now() })
  if (cache.size > 20) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest) }
}

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error(e.message?.substring(0,60)); return null }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms))
  ])
}

// ── Row normalisation helpers ───────────────────────────────────────────
interface RawResult { results?: Array<{ schema?: Array<{ columnName: string }>; rows?: any[][] }> }

function rowsToObjects(raw: RawResult | null): any[] {
  if (!raw) return []
  const result = raw.results?.[0]
  if (!result) return []
  const cols: string[] = (result.schema || []).map(c => c.columnName)
  const rows: any[][] = result.rows || []
  return rows.map(r => {
    const o: Record<string, any> = {}
    cols.forEach((c, i) => { o[c] = r[i] })
    return o
  })
}

// Given invoice/bill rows, add ex-GST fields.
// TotalAmountExGst = TotalAmount - TotalTax — works for both IsTaxInclusive modes.
function normaliseInvoiceRows(rows: any[]): any[] {
  return rows.map(r => {
    const total = toNum(r.TotalAmount)
    const tax = toNum(r.TotalTax)
    const balance = toNum(r.BalanceDueAmount)
    // Pro-rata the tax onto the balance due (if TotalAmount is 0 to avoid div-zero)
    const balanceTaxRatio = total > 0 ? (tax * balance) / total : 0
    return {
      ...r,
      TotalAmountExGst: invoiceExGst(total, tax),
      BalanceDueExGst: balance - balanceTaxRatio,
    }
  })
}

function computeTopCustomers(invoiceRows: any[], limit = 10) {
  const byCustomer = new Map<string, { TotalRevenue: number; InvoiceCount: number }>()
  for (const r of invoiceRows) {
    const name = r.CustomerName
    if (!name) continue
    const revEx = invoiceExGst(toNum(r.TotalAmount), toNum(r.TotalTax))
    if (revEx <= 0) continue
    const e = byCustomer.get(name) || { TotalRevenue: 0, InvoiceCount: 0 }
    e.TotalRevenue += revEx
    e.InvoiceCount += 1
    byCustomer.set(name, e)
  }
  return Array.from(byCustomer.entries())
    .map(([CustomerName, v]) => ({ CustomerName, TotalRevenue: v.TotalRevenue, InvoiceCount: v.InvoiceCount }))
    .sort((a, b) => b.TotalRevenue - a.TotalRevenue)
    .slice(0, limit)
}

// Wrap objects back into the { results:[{schema,rows}] } shape the frontend parses.
function wrap(objectRows: any[], schemaKeys: string[]) {
  return {
    results: [{
      schema: schemaKeys.map(k => ({ columnName: k })),
      rows: objectRows.map(o => schemaKeys.map(k => o[k])),
    }]
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string, string>))
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = `dash:${start}:${end}`

    if (!forceRefresh) {
      const cached = getCached(cacheKey)
      if (cached) return res.status(200).json(cached)
    }

    const allQueries = await withTimeout(Promise.all([
      // 0: JAWS recent invoices
      safe(() => cdataQuery('JAWS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[TotalTax],[IsTaxInclusive],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
      // 1: JAWS open invoices
      safe(() => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[TotalTax],[IsTaxInclusive],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 2: JAWS invoices for top-customers compute (in-memory aggregation)
      safe(() => cdataQuery('JAWS', `SELECT [CustomerName],[TotalAmount],[TotalTax],[IsTaxInclusive] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0`)),
      // 3: VPS recent invoices
      safe(() => cdataQuery('VPS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[TotalTax],[IsTaxInclusive],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
      // 4: VPS open invoices
      safe(() => cdataQuery('VPS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[TotalTax],[IsTaxInclusive],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 5: VPS invoices for top-customers compute
      safe(() => cdataQuery('VPS', `SELECT [CustomerName],[TotalAmount],[TotalTax],[IsTaxInclusive] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0`)),
      // 6: JAWS P&L (always ex-GST by MYOB convention)
      safe(() => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
      // 7: VPS P&L
      safe(() => cdataQuery('VPS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
      // 8: JAWS open bills
      safe(() => cdataQuery('JAWS', `SELECT TOP 15 [Number],[Date],[SupplierName],[TotalAmount],[TotalTax],[IsTaxInclusive],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 9: VPS open bills
      safe(() => cdataQuery('VPS', `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[TotalTax],[IsTaxInclusive],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 10: JAWS stock summary (CurrentValue is always ex-GST)
      safe(() => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
    ]), 50000)

    if (!allQueries) {
      console.error('Dashboard queries timed out at 50s')
      return res.status(504).json({ error: 'MYOB data took too long to load. Please try again.' })
    }

    const jawsRecent  = normaliseInvoiceRows(rowsToObjects(allQueries[0]))
    const jawsOpen    = normaliseInvoiceRows(rowsToObjects(allQueries[1]))
    const jawsInvAll  = rowsToObjects(allQueries[2])
    const vpsRecent   = normaliseInvoiceRows(rowsToObjects(allQueries[3]))
    const vpsOpen     = normaliseInvoiceRows(rowsToObjects(allQueries[4]))
    const vpsInvAll   = rowsToObjects(allQueries[5])
    const jawsBills   = normaliseInvoiceRows(rowsToObjects(allQueries[8]))
    const vpsBills    = normaliseInvoiceRows(rowsToObjects(allQueries[9]))

    const jawsTopCustomers = computeTopCustomers(jawsInvAll)
    const vpsTopCustomers  = computeTopCustomers(vpsInvAll)

    const invoiceKeys = ['Number','Date','CustomerName','TotalAmount','TotalTax','IsTaxInclusive','TotalAmountExGst','BalanceDueAmount','BalanceDueExGst','Status','InvoiceType']
    const openInvKeys = ['Number','Date','CustomerName','TotalAmount','TotalTax','IsTaxInclusive','TotalAmountExGst','BalanceDueAmount','BalanceDueExGst','Status']
    const billKeys    = ['Number','Date','SupplierName','TotalAmount','TotalTax','IsTaxInclusive','TotalAmountExGst','BalanceDueAmount','BalanceDueExGst','Status']
    const topKeys     = ['CustomerName','TotalRevenue','InvoiceCount']

    const result = {
      fetchedAt: new Date().toISOString(),
      period: { start, end },
      amountsAreExGst: true,
      jaws: {
        recentInvoices: wrap(jawsRecent, invoiceKeys),
        openInvoices:   wrap(jawsOpen,   openInvKeys),
        topCustomers:   wrap(jawsTopCustomers, topKeys),
        pnl: allQueries[6],
        stockItems: null,
        stockSummary: allQueries[10],
        openBills: wrap(jawsBills, billKeys),
      },
      vps: {
        recentInvoices: wrap(vpsRecent, invoiceKeys),
        openInvoices:   wrap(vpsOpen,   openInvKeys),
        topCustomers:   wrap(vpsTopCustomers, topKeys),
        pnl: allQueries[7],
        openBills: wrap(vpsBills, billKeys),
        stockSummary: null,
      },
    }

    setCache(cacheKey, result)
    return res.status(200).json(result)
  })
}
