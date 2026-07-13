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
import { parseDateRange, endDateExclusive } from '../../lib/cdata'
import { fetchSaleInvoices, fetchPurchaseBills, fetchInventoryItems } from '../../lib/myob-reporting'
import { invoiceExGst, toNum } from '../../lib/gst'

export const config = { maxDuration: 300 }

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

    // Direct MYOB OAuth (CData decommissioned 2026-07-14). P&L is dropped —
    // AccountRight has no P&L endpoint; those panels now render empty.
    const endEx = endDateExclusive(end)
    const byBalanceDesc = (a: any, b: any) => (b.BalanceDueAmount || 0) - (a.BalanceDueAmount || 0)
    const allQueries: any[] | null = await withTimeout(Promise.all([
      safe(() => fetchSaleInvoices('JAWS', { top: 20 })),                                 // 0 JAWS recent
      safe(() => fetchSaleInvoices('JAWS', { status: 'Open' })),                          // 1 JAWS open
      safe(() => fetchSaleInvoices('JAWS', { start, endExclusive: endEx })),              // 2 JAWS range
      safe(() => fetchSaleInvoices('VPS', { top: 20 })),                                  // 3 VPS recent
      safe(() => fetchSaleInvoices('VPS', { status: 'Open' })),                           // 4 VPS open
      safe(() => fetchSaleInvoices('VPS', { start, endExclusive: endEx })),               // 5 VPS range
      safe(() => fetchPurchaseBills('JAWS', { openOnly: true, top: 15 })),                // 6 JAWS bills
      safe(() => fetchPurchaseBills('VPS', { openOnly: true, top: 10 })),                 // 7 VPS bills
      safe(() => fetchInventoryItems('JAWS')),                                            // 8 JAWS stock
    ]), 250000)

    if (!allQueries) {
      console.error('Dashboard queries timed out')
      return res.status(504).json({ error: 'MYOB data took too long to load. Please try again.' })
    }

    const jawsRecent  = normaliseInvoiceRows(allQueries[0] || [])
    const jawsOpen    = normaliseInvoiceRows((allQueries[1] || []).slice().sort(byBalanceDesc))
    const jawsInvAll  = (allQueries[2] || []).filter((i: any) => (i.TotalAmount || 0) > 0)
    const vpsRecent   = normaliseInvoiceRows(allQueries[3] || [])
    const vpsOpen     = normaliseInvoiceRows((allQueries[4] || []).slice().sort(byBalanceDesc))
    const vpsInvAll   = (allQueries[5] || []).filter((i: any) => (i.TotalAmount || 0) > 0)
    const jawsBills   = normaliseInvoiceRows((allQueries[6] || []).slice().sort(byBalanceDesc))
    const vpsBills    = normaliseInvoiceRows((allQueries[7] || []).slice().sort(byBalanceDesc))

    // Stock summary in the shape the frontend reads (.results[0].rows[0]).
    const stockItems: any[] = allQueries[8] || []
    const stockValue = Math.round(stockItems.reduce((s, it) => s + (Number(it.CurrentValue) || 0), 0) * 100) / 100
    const jawsStockSummary = { results: [{ schema: [{ columnName: 'TotalStockValue' }, { columnName: 'ItemCount' }], rows: [[stockValue, stockItems.length]] }] }

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
        pnl: null,
        stockItems: null,
        stockSummary: jawsStockSummary,
        openBills: wrap(jawsBills, billKeys),
      },
      vps: {
        recentInvoices: wrap(vpsRecent, invoiceKeys),
        openInvoices:   wrap(vpsOpen,   openInvKeys),
        topCustomers:   wrap(vpsTopCustomers, topKeys),
        pnl: null,
        openBills: wrap(vpsBills, billKeys),
        stockSummary: null,
      },
    }

    setCache(cacheKey, result)
    return res.status(200).json(result)
  })
}
