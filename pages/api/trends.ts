// pages/api/trends.ts — 6-month trend data loaded separately after core dashboard
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export const config = { maxDuration: 60 }

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
    const months = last6Months()
    // Run 6 months x 2 entities = 12 queries in parallel
    const results = await Promise.all(months.flatMap(m => {
      const s = `${m.year}-${String(m.month).padStart(2,'0')}-01`
      const e = `${m.year}-${String(m.month).padStart(2,'0')}-${new Date(m.year, m.month, 0).getDate()}`
      return [
        safe(() => cdataQuery('JAWS', `SELECT SUM([AccountTotal]) AS Income FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${s}' AND [EndDate] = '${e}'`)),
        safe(() => cdataQuery('VPS',  `SELECT SUM([AccountTotal]) AS Income FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport]  WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${s}' AND [EndDate] = '${e}'`)),
      ]
    }))

    const v = (r: any) => { try { return r?.results?.[0]?.rows?.[0]?.[0] ?? 0 } catch { return 0 } }

    res.status(200).json({
      trendLabels: months.map(m => m.label),
      jawsIncome6: months.map((_, i) => v(results[i * 2])),
      vpsIncome6:  months.map((_, i) => v(results[i * 2 + 1])),
      // Expense trends - use known values (updated monthly)
      jawsExpense6: [380000, 400000, 510000, 460000, 580000, 186111],
      vpsExpense6:  [780000, 520000, 620000, 680000, 760000,  99262],
    })
  })
}
