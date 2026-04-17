// pages/api/distributors.ts — Distributor sales from MYOB via CData
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// Parse CData response — handles both MCP format and REST API format
function parseRows(result: any): Record<string, any>[] {
  if (!result) return []
  // Format A: { results: [{ schema: [...], rows: [...] }] }
  if (result?.results?.[0]?.schema && result?.results?.[0]?.rows) {
    const { schema, rows } = result.results[0]
    return rows.map((row: any[]) => {
      const o: any = {}
      schema.forEach((c: any, i: number) => { o[c.columnName || c.ColumnName || c.name] = row[i] })
      return o
    })
  }
  // Format B: { value: [...] } (OData style)
  if (Array.isArray(result?.value)) return result.value
  // Format C: already an array
  if (Array.isArray(result)) return result
  // Format D: { rows: [...], schema: [...] } (flat)
  if (result?.schema && result?.rows) {
    return result.rows.map((row: any[]) => {
      const o: any = {}
      result.schema.forEach((c: any, i: number) => { o[c.columnName || c.ColumnName || c.name] = row[i] })
      return o
    })
  }
  return []
}

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch (e: any) { console.error('dist:', e.message?.substring(0, 120)); return null }
}

// Cache
const CACHE_TTL = 3 * 60 * 1000
const cache = new Map<string, { data: any; ts: number }>()
function getC(k: string) { const e = cache.get(k); if (!e) return null; if (Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null }; return e.data }
function setC(k: string, d: any) { cache.set(k, { data: d, ts: Date.now() }); if (cache.size > 10) { const k2 = cache.keys().next().value; if (k2) cache.delete(k2) } }

function getMonthLabels(start: string, end: string) {
  const months: { label: string; s: string; e: string }[] = []
  const d = new Date(start + 'T00:00:00')
  const endD = new Date(end + 'T00:00:00')
  while (d <= endD) {
    const y = d.getFullYear(), m = d.getMonth()
    months.push({
      label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
      s: `${y}-${String(m + 1).padStart(2, '0')}-01`,
      e: `${y}-${String(m + 1).padStart(2, '0')}-${new Date(y, m + 1, 0).getDate()}`
    })
    d.setMonth(d.getMonth() + 1)
  }
  return months
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string, string>))
      const forceRefresh = req.query.refresh === 'true'
      const ck = `dist:${start}:${end}`
      if (!forceRefresh) { const c = getC(ck); if (c) return res.status(200).json(c) }

      // Query 1: Get invoices in date range (CustomerName, Date, TotalAmount, Number, ID)
      const invRaw = await safe(() => cdataQuery('JAWS', `
        SELECT [ID], [CustomerName], [Date], [TotalAmount], [Number]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0
        ORDER BY [Date] DESC
      `))

      // Query 2: Get ALL line items (no date filter — will match by SaleInvoiceId)
      const liRaw = await safe(() => cdataQuery('JAWS', `
        SELECT [SaleInvoiceId], [Description], [Total], [AccountName], [AccountDisplayID], [ItemName]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
        WHERE [Total] > 0
      `))

      const invoices = parseRows(invRaw)
      const allLineItems = parseRows(liRaw)

      console.log(`dist: ${invoices.length} invoices, ${allLineItems.length} line items`)

      // Build invoice lookup by ID
      const invById: Record<string, any> = {}
      invoices.forEach(inv => {
        if (inv.ID) invById[inv.ID] = inv
      })

      // Match line items to invoices
      let lineItems: any[] = []
      if (allLineItems.length > 0 && invoices.length > 0) {
        lineItems = allLineItems
          .filter(li => li.SaleInvoiceId && invById[li.SaleInvoiceId])
          .map(li => {
            const inv = invById[li.SaleInvoiceId]
            return {
              CustomerName: inv.CustomerName || '',
              Date: inv.Date || '',
              AccountName: li.AccountName || '',
              AccountDisplayID: li.AccountDisplayID || '',
              Description: li.Description || '',
              Total: typeof li.Total === 'number' ? li.Total : parseFloat(li.Total) || 0,
              ItemName: li.ItemName || null,
            }
          })
      }

      // Fallback: if no matched line items, use invoice-level data
      if (lineItems.length === 0 && invoices.length > 0) {
        console.log('dist: falling back to invoice-level data')
        lineItems = invoices.map(inv => ({
          CustomerName: inv.CustomerName || '',
          Date: inv.Date || '',
          AccountName: '',
          AccountDisplayID: '',
          Description: inv.CustomerName || '',
          Total: typeof inv.TotalAmount === 'number' ? inv.TotalAmount : parseFloat(inv.TotalAmount) || 0,
          ItemName: null,
        }))
      }

      // Monthly totals from invoices
      const months = getMonthLabels(start, end)
      const trendLabels: string[] = []
      const monthlyTotals: Record<string, number> = {}
      months.forEach(m => {
        trendLabels.push(m.label)
        const total = invoices
          .filter(inv => {
            const d = (inv.Date || '').substring(0, 10)
            return d >= m.s && d <= m.e
          })
          .reduce((s, inv) => s + (typeof inv.TotalAmount === 'number' ? inv.TotalAmount : parseFloat(inv.TotalAmount) || 0), 0)
        monthlyTotals[m.label] = total
      })

      const result = {
        fetchedAt: new Date().toISOString(),
        lineItems,
        trendLabels,
        monthlyTotals,
        period: { start, end },
        debug: { invoiceCount: invoices.length, lineItemCount: allLineItems.length, matchedCount: lineItems.length }
      }

      setC(ck, result)
      res.status(200).json(result)
    } catch (err: any) {
      console.error('distributors handler error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })
}
