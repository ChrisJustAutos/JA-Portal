// pages/api/distributors.ts — Distributor sales from MYOB via CData
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// cdataQuery returns: { results: [{ schema: [{columnName}...], rows: [[val,val]...] }] }
function parseRows(result: any): Record<string, any>[] {
  if (!result) return []
  const r = result?.results?.[0]
  if (!r?.schema || !r?.rows) return []
  return r.rows.map((row: any[]) => {
    const o: any = {}
    r.schema.forEach((c: any, i: number) => { o[c.columnName] = row[i] })
    return o
  })
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

      // Step 1: Get all distributor invoices in the date range
      const invRaw = await safe(() => cdataQuery('JAWS', `
        SELECT [ID], [CustomerName], [Date], [TotalAmount], [Number]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0
        ORDER BY [Date] DESC
      `))

      const invoices = parseRows(invRaw)
      console.log(`dist: ${invoices.length} invoices found`)

      if (invoices.length === 0) {
        // Return empty but valid response
        const empty = { fetchedAt: new Date().toISOString(), lineItems: [], trendLabels: [], monthlyTotals: {}, period: { start, end } }
        setC(ck, empty)
        return res.status(200).json(empty)
      }

      // Step 2: For each invoice, try to get its line items
      // Batch by invoice ID — but SaleInvoiceItems has no date filter,
      // so we query with SaleInvoiceId IN (...) for batches of IDs
      const invIds = invoices.map(i => i.ID).filter(Boolean)
      const invLookup: Record<string, any> = {}
      invoices.forEach(inv => { if (inv.ID) invLookup[inv.ID] = inv })

      let lineItems: any[] = []

      // Try line items in batches of 50 invoice IDs
      const batchSize = 50
      for (let i = 0; i < invIds.length && i < 200; i += batchSize) {
        const batch = invIds.slice(i, i + batchSize)
        const idList = batch.map((id: string) => `'${id}'`).join(',')
        const liRaw = await safe(() => cdataQuery('JAWS', `
          SELECT [SaleInvoiceId], [Description], [Total], [AccountName], [AccountDisplayID], [ItemName]
          FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
          WHERE [SaleInvoiceId] IN (${idList}) AND [Total] > 0
        `))
        const batchItems = parseRows(liRaw)
        if (batchItems.length > 0) {
          batchItems.forEach(li => {
            const inv = invLookup[li.SaleInvoiceId]
            if (inv) {
              lineItems.push({
                CustomerName: inv.CustomerName || '',
                Date: inv.Date || '',
                AccountName: li.AccountName || '',
                AccountDisplayID: li.AccountDisplayID || '',
                Description: li.Description || '',
                Total: typeof li.Total === 'number' ? li.Total : parseFloat(li.Total) || 0,
                ItemName: li.ItemName || null,
              })
            }
          })
        }
      }

      console.log(`dist: ${lineItems.length} matched line items`)

      // Fallback: if no line items matched, use invoice-level data
      if (lineItems.length === 0) {
        console.log('dist: using invoice-level fallback')
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

      // Monthly totals
      const months = getMonthLabels(start, end)
      const trendLabels: string[] = []
      const monthlyTotals: Record<string, number> = {}
      months.forEach(m => {
        trendLabels.push(m.label)
        const total = invoices
          .filter(inv => { const d = (inv.Date || '').substring(0, 10); return d >= m.s && d <= m.e })
          .reduce((s, inv) => s + (typeof inv.TotalAmount === 'number' ? inv.TotalAmount : parseFloat(inv.TotalAmount) || 0), 0)
        monthlyTotals[m.label] = total
      })

      const result = {
        fetchedAt: new Date().toISOString(),
        lineItems,
        trendLabels,
        monthlyTotals,
        period: { start, end },
      }

      setC(ck, result)
      res.status(200).json(result)
    } catch (err: any) {
      console.error('distributors handler error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })
}
