import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e:any) { console.error('dist query failed:', e.message?.substring(0,80)); return null }
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
    try {
      const months = last6Months()
      const sinceDate = `${months[0].year}-${String(months[0].month).padStart(2,'0')}-01`

      // Get distributor line items using MCP endpoint
      const lineItemsResult = await safe(() => cdataQuery('JAWS', `
        SELECT i.[CustomerName], i.[Date], li.[AccountName], li.[AccountDisplayID],
               li.[Description], li.[Total], li.[ItemName]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] i
        INNER JOIN [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] li ON i.[ID] = li.[SaleInvoiceId]
        WHERE i.[Date] >= '${sinceDate}'
          AND i.[TotalAmount] > 0
          AND i.[CustomerName] NOT LIKE '%Vehicle Performance%'
          AND i.[CustomerName] NOT LIKE '%Stripe%'
          AND li.[Total] > 0
        ORDER BY i.[CustomerName], i.[Date] DESC
        LIMIT 500
      `))

      const schema = lineItemsResult?.results?.[0]?.schema || []
      const rows   = lineItemsResult?.results?.[0]?.rows   || []
      const cols   = schema.map((c: any) => c.columnName)
      const lineItems = rows.map((row: any[]) => {
        const obj: any = {}
        cols.forEach((col: string, i: number) => { obj[col] = row[i] })
        return obj
      })

      // Monthly totals - run sequentially to avoid timeout
      const monthlyTotals: Record<string, number> = {}
      for (const m of months) {
        const start = `${m.year}-${String(m.month).padStart(2,'0')}-01`
        const last  = new Date(m.year, m.month, 0).getDate()
        const end   = `${m.year}-${String(m.month).padStart(2,'0')}-${last}`
        const r = await safe(() => cdataQuery('JAWS', `
          SELECT SUM([TotalAmount]) AS Total FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
          WHERE [Date] >= '${start}' AND [Date] <= '${end}'
            AND [TotalAmount] > 0
            AND [CustomerName] NOT LIKE '%Vehicle Performance%'
            AND [CustomerName] NOT LIKE '%Stripe%'
        `))
        monthlyTotals[m.label] = r?.results?.[0]?.rows?.[0]?.[0] || 0
      }

      res.status(200).json({
        fetchedAt: new Date().toISOString(),
        trendLabels: months.map(m => m.label),
        monthlyTotals,
        lineItems,
      })
    } catch (err: any) {
      console.error('Distributors error:', err)
      res.status(500).json({ error: err.message })
    }
  })
}
