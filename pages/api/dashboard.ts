// pages/api/dashboard.ts — Two-stage load with timeout protection
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// ── In-memory cache ──────────────────────────────────────────
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

// Race a promise against a timeout
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms))
  ])
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string, string>))
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = `dash:${start}:${end}`

    if (!forceRefresh) {
      const cached = getCached(cacheKey)
      if (cached) {
        console.log(`Cache hit: ${cacheKey}`)
        return res.status(200).json(cached)
      }
    }

    console.log(`Cache miss: ${cacheKey} — fetching from MYOB`)

    // Run ALL queries in parallel with a 50s safety timeout
    const allQueries = await withTimeout(Promise.all([
      // 0: JAWS recent invoices
      safe(() => cdataQuery('JAWS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
      // 1: JAWS open invoices
      safe(() => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 2: JAWS top customers
      safe(() => cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
      // 3: VPS recent invoices
      safe(() => cdataQuery('VPS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
      // 4: VPS open invoices
      safe(() => cdataQuery('VPS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 5: VPS top customers
      safe(() => cdataQuery('VPS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
      // 6: JAWS P&L
      safe(() => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
      // 7: VPS P&L
      safe(() => cdataQuery('VPS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
      // 8: JAWS open bills
      safe(() => cdataQuery('JAWS', `SELECT TOP 15 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 9: VPS open bills
      safe(() => cdataQuery('VPS', `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      // 10: JAWS stock summary
      safe(() => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
    ]), 50000) // 50s timeout — leaves 10s buffer before Vercel kills at 60s

    if (!allQueries) {
      console.error('Dashboard queries timed out at 50s')
      return res.status(504).json({ error: 'MYOB data took too long to load. Please try again.' })
    }

    const result = {
      fetchedAt: new Date().toISOString(),
      period: { start, end },
      jaws: {
        recentInvoices: allQueries[0],
        openInvoices: allQueries[1],
        topCustomers: allQueries[2],
        pnl: allQueries[6],
        stockItems: null,
        stockSummary: allQueries[10],
        openBills: allQueries[8],
      },
      vps: {
        recentInvoices: allQueries[3],
        openInvoices: allQueries[4],
        topCustomers: allQueries[5],
        pnl: allQueries[7],
        openBills: allQueries[9],
        stockSummary: null,
      },
    }

    setCache(cacheKey, result)
    res.status(200).json(result)
  })
}
