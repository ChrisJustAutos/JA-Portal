// pages/api/distributors.ts — Distributor Report data API
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { getMonthlyTrend, currentMonthRange } from '../../lib/cdata'

const CDATA_BASE = process.env.CDATA_BASE_URL || 'https://cloud.cdata.com/api/odata4'
const CDATA_USER = process.env.CDATA_USERNAME || ''
const CDATA_PAT  = process.env.CDATA_PAT || ''

function authHeader() {
  const creds = Buffer.from(`${CDATA_USER}:${CDATA_PAT}`).toString('base64')
  return { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' }
}
async function query(sql: string) {
  const res = await fetch(`${CDATA_BASE}/MYOB_POWERBI_JAWS/query`, {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ query: sql }),
    next: { revalidate: 300 } as RequestInit['next'],
  } as RequestInit)
  if (!res.ok) throw new Error(`CData error ${res.status}`)
  return res.json()
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
  requireAuth(req, res, async () => {
    try {
      const months = last6Months()

      // Line items joined to invoices — the core distributor data
      const lineItemsResult = await query(`
        SELECT i.[CustomerName], i.[Date], li.[AccountName], li.[AccountDisplayID],
               li.[Description], li.[Total], li.[ItemName]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] i
        INNER JOIN [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] li ON i.[ID] = li.[SaleInvoiceId]
        WHERE i.[Date] >= '${months[0].year}-${String(months[0].month).padStart(2,'0')}-01'
          AND i.[TotalAmount] > 0
          AND i.[CustomerName] NOT LIKE '%Vehicle Performance%'
          AND i.[CustomerName] NOT LIKE '%Stripe%'
          AND li.[Total] > 0
        ORDER BY i.[CustomerName], i.[Date] DESC
        LIMIT 500
      `)

      // Parse line items
      const schema = lineItemsResult?.results?.[0]?.schema || []
      const rows   = lineItemsResult?.results?.[0]?.rows   || []
      const cols   = schema.map((c: any) => c.columnName)
      const lineItems = rows.map((row: any[]) => {
        const obj: any = {}
        cols.forEach((col: string, i: number) => { obj[col] = row[i] })
        return obj
      })

      // Monthly trend totals (distributor revenue only — Professional/Item invoices ex VPS)
      const trendResults = await Promise.allSettled(
        months.map(m => {
          const start = `${m.year}-${String(m.month).padStart(2,'0')}-01`
          const last  = new Date(m.year, m.month, 0).getDate()
          const end   = `${m.year}-${String(m.month).padStart(2,'0')}-${last}`
          return query(`
            SELECT SUM([TotalAmount]) AS Total FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
            WHERE [Date] >= '${start}' AND [Date] <= '${end}'
              AND [TotalAmount] > 0
              AND [CustomerName] NOT LIKE '%Vehicle Performance%'
              AND [CustomerName] NOT LIKE '%Stripe%'
              AND [CustomerName] NOT LIKE '%Harrop%'
              AND [CustomerName] NOT LIKE '%US CruiserZ%'
          `)
        })
      )

      const monthlyTotals: Record<string, number> = {}
      months.forEach((m, i) => {
        const r = trendResults[i]
        monthlyTotals[m.label] = r.status === 'fulfilled' ? (r.value?.results?.[0]?.rows?.[0]?.[0] || 0) : 0
      })

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
