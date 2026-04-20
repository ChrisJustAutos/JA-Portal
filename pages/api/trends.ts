// pages/api/trends.ts — 6-month trend data with cache
//
// GST NOTE: All amounts are from ProfitAndLossSummaryReport.AccountTotal, which
// MYOB always stores ex-GST by convention. No normalisation needed.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// ── In-memory cache ──────────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes (trends change less often)
const cache = new Map<string, { data: any; timestamp: number }>()

function getCached(key: string): any | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCache(key: string, data: any) {
  cache.set(key, { data, timestamp: Date.now() })
  if (cache.size > 10) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch { return null }
}

function last6Months() {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) })
  }
  return months
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = 'trends:last6'

    if (!forceRefresh) {
      const cached = getCached(cacheKey)
      if (cached) {
        console.log('Trends cache hit')
        return res.status(200).json(cached)
      }
    }

    console.log('Trends cache miss — fetching from MYOB')
    const months = last6Months()

    // Run 6 months x 2 entities x 2 (income + expense) = 24 queries in parallel
    const results = await Promise.all(months.flatMap(m => {
      const s = `${m.year}-${String(m.month).padStart(2,'0')}-01`
      const e = `${m.year}-${String(m.month).padStart(2,'0')}-${new Date(m.year, m.month, 0).getDate()}`
      return [
        safe(() => cdataQuery('JAWS', `SELECT SUM([AccountTotal]) AS Income FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${s}' AND [EndDate] = '${e}'`)),
        safe(() => cdataQuery('VPS',  `SELECT SUM([AccountTotal]) AS Income FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport]  WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${s}' AND [EndDate] = '${e}'`)),
        safe(() => cdataQuery('JAWS', `SELECT SUM([AccountTotal]) AS Expenses FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE ([AccountDisplayID] LIKE '5-%' OR [AccountDisplayID] LIKE '6-%') AND [StartDate] = '${s}' AND [EndDate] = '${e}'`)),
        safe(() => cdataQuery('VPS',  `SELECT SUM([AccountTotal]) AS Expenses FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport]  WHERE ([AccountDisplayID] LIKE '5-%' OR [AccountDisplayID] LIKE '6-%') AND [StartDate] = '${s}' AND [EndDate] = '${e}'`)),
      ]
    }))

    const v = (r: any) => { try { return r?.results?.[0]?.rows?.[0]?.[0] ?? 0 } catch { return 0 } }

    const result = {
      amountsAreExGst: true,
      trendLabels: months.map(m => m.label),
      jawsIncome6:  months.map((_, i) => v(results[i * 4])),
      vpsIncome6:   months.map((_, i) => v(results[i * 4 + 1])),
      jawsExpense6: months.map((_, i) => v(results[i * 4 + 2])),
      vpsExpense6:  months.map((_, i) => v(results[i * 4 + 3])),
    }

    setCache(cacheKey, result)
    res.status(200).json(result)
  })
}
