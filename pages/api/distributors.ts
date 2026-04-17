// pages/api/distributors.ts — Distributor sales from MYOB via CData
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// Parse CData response into array of objects
function parseRows(result: any): Record<string, any>[] {
  if (!result?.results?.[0]) return []
  const { schema, rows } = result.results[0]
  if (!schema || !rows) return []
  return rows.map((row: any[]) => {
    const o: any = {}
    schema.forEach((c: any, i: number) => { o[c.columnName] = row[i] })
    return o
  })
}

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch (e: any) { console.error('dist:', e.message?.substring(0, 80)); return null }
}

// Cache
const CACHE_TTL = 3 * 60 * 1000
const cache = new Map<string, { data: any; timestamp: number }>()
function getCached(key: string) { const e = cache.get(key); if (!e) return null; if (Date.now() - e.timestamp > CACHE_TTL) { cache.delete(key); return null }; return e.data }
function setCache(key: string, data: any) { cache.set(key, { data, timestamp: Date.now() }); if (cache.size > 10) { const k = cache.keys().next().value; if (k) cache.delete(k) } }

// Generate month labels for FY range
function getMonthLabels(start: string, end: string): { label: string; start: string; end: string }[] {
  const months: { label: string; start: string; end: string }[] = []
  const startDate = new Date(start + 'T00:00:00')
  const endDate = new Date(end + 'T00:00:00')
  const d = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  while (d <= endDate) {
    const y = d.getFullYear()
    const m = d.getMonth()
    const mStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const mEnd = `${y}-${String(m + 1).padStart(2, '0')}-${new Date(y, m + 1, 0).getDate()}`
    const label = d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
    months.push({ label, start: mStart, end: mEnd })
    d.setMonth(d.getMonth() + 1)
  }
  return months
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string, string>))
      const forceRefresh = req.query.refresh === 'true'
      const cacheKey = `dist:${start}:${end}`

      if (!forceRefresh) {
        const cached = getCached(cacheKey)
        if (cached) return res.status(200).json(cached)
      }

      // Query 1: Get all distributor invoices with line-level detail
      // Use a simpler query without JOIN in case CData doesn't support it
      const invoiceResult = await safe(() => cdataQuery('JAWS', `
        SELECT [CustomerName], [Date], [AccountName], [AccountDisplayID], [TotalAmount], [Number]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0
        ORDER BY [Date] DESC
      `))

      // Query 2: Try to get line items (may fail if JOIN not supported)
      const lineItemResult = await safe(() => cdataQuery('JAWS', `
        SELECT [SaleInvoiceNumber], [Description], [Total], [AccountName], [AccountDisplayID], [ItemName]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
        WHERE [Total] > 0
      `))

      // Parse results
      const invoices = parseRows(invoiceResult)
      const lineItemsRaw = parseRows(lineItemResult)

      // Build line items by matching invoice data
      // If we got line items, merge invoice CustomerName/Date onto them
      // If not, use invoice-level data as line items
      let lineItems: any[] = []

      if (lineItemsRaw.length > 0) {
        // Build invoice lookup by number
        const invoiceLookup: Record<string, any> = {}
        invoices.forEach(inv => { invoiceLookup[inv.Number] = inv })

        lineItems = lineItemsRaw.map(li => {
          const inv = invoiceLookup[li.SaleInvoiceNumber] || {}
          return {
            CustomerName: inv.CustomerName || '',
            Date: inv.Date || '',
            AccountName: li.AccountName || inv.AccountName || '',
            AccountDisplayID: li.AccountDisplayID || inv.AccountDisplayID || '',
            Description: li.Description || '',
            Total: li.Total || 0,
            ItemName: li.ItemName || null,
          }
        }).filter(li => li.CustomerName) // Only keep items we could match
      }

      // Fallback: if no line items, use invoices directly
      if (lineItems.length === 0) {
        lineItems = invoices.map(inv => ({
          CustomerName: inv.CustomerName || '',
          Date: inv.Date || '',
          AccountName: inv.AccountName || '',
          AccountDisplayID: inv.AccountDisplayID || '',
          Description: inv.AccountName || '',
          Total: inv.TotalAmount || 0,
          ItemName: null,
        }))
      }

      // Generate monthly totals
      const months = getMonthLabels(start, end)
      const monthlyTotals: Record<string, number> = {}
      const trendLabels: string[] = []

      months.forEach(m => {
        trendLabels.push(m.label)
        const total = invoices
          .filter(inv => inv.Date >= m.start && inv.Date <= m.end)
          .reduce((s, inv) => s + (inv.TotalAmount || 0), 0)
        monthlyTotals[m.label] = total
      })

      const result = {
        fetchedAt: new Date().toISOString(),
        lineItems,
        trendLabels,
        monthlyTotals,
        period: { start, end },
      }

      setCache(cacheKey, result)
      res.status(200).json(result)
    } catch (err: any) {
      console.error('distributors handler error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })
}
