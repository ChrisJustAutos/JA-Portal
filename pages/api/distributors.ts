// pages/api/distributors.ts — Distributor sales from MYOB via CData
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

function parseRows(result: any): Record<string, any>[] {
  if (!result) return []
  try {
    const r = result?.results?.[0]
    if (r?.schema && r?.rows) {
      return r.rows.map((row: any[]) => {
        const o: any = {}
        r.schema.forEach((c: any, i: number) => { o[c.columnName] = row[i] })
        return o
      })
    }
    if (Array.isArray(result?.value)) return result.value
    if (Array.isArray(result)) return result
  } catch (e) { console.error('parseRows error:', e) }
  return []
}

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch (e: any) { console.error('dist:', e.message?.substring(0, 120)); return null }
}

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

      // Get all distributor invoices in date range
      const invRaw = await safe(() => cdataQuery('JAWS', `
        SELECT [ID], [CustomerName], [Date], [TotalAmount], [Number]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0
        ORDER BY [Date] DESC
      `))

      const invoices = parseRows(invRaw)

      // Try to get line items for first 50 invoices only (quick batch)
      let lineItems: any[] = []
      if (invoices.length > 0) {
        const firstBatch = invoices.slice(0, 50).map((i: any) => i.ID).filter(Boolean)
        if (firstBatch.length > 0) {
          const idList = firstBatch.map((id: string) => `'${id}'`).join(',')
          const liRaw = await safe(() => cdataQuery('JAWS', `
            SELECT [SaleInvoiceId], [Description], [Total], [AccountName], [AccountDisplayID], [ItemName]
            FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
            WHERE [SaleInvoiceId] IN (${idList}) AND [Total] > 0
          `))
          const liParsed = parseRows(liRaw)
          if (liParsed.length > 0) {
            const invById: Record<string, any> = {}
            invoices.forEach((inv: any) => { if (inv.ID) invById[inv.ID] = inv })
            liParsed.forEach((li: any) => {
              const inv = invById[li.SaleInvoiceId]
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

        // If we got line items for first batch, get remaining batches
        if (lineItems.length > 0 && invoices.length > 50) {
          for (let i = 50; i < invoices.length && i < 300; i += 50) {
            const batch = invoices.slice(i, i + 50).map((inv: any) => inv.ID).filter(Boolean)
            if (batch.length === 0) continue
            const idList = batch.map((id: string) => `'${id}'`).join(',')
            const bRaw = await safe(() => cdataQuery('JAWS', `
              SELECT [SaleInvoiceId], [Description], [Total], [AccountName], [AccountDisplayID], [ItemName]
              FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
              WHERE [SaleInvoiceId] IN (${idList}) AND [Total] > 0
            `))
            const bParsed = parseRows(bRaw)
            const invById: Record<string, any> = {}
            invoices.forEach((inv: any) => { if (inv.ID) invById[inv.ID] = inv })
            bParsed.forEach((li: any) => {
              const inv = invById[li.SaleInvoiceId]
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
      }

      // Fallback: if no line items, use invoice-level data
      if (lineItems.length === 0) {
        lineItems = invoices.map((inv: any) => ({
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
        monthlyTotals[m.label] = invoices
          .filter((inv: any) => { const d = (inv.Date || '').substring(0, 10); return d >= m.s && d <= m.e })
          .reduce((s: number, inv: any) => s + (typeof inv.TotalAmount === 'number' ? inv.TotalAmount : parseFloat(inv.TotalAmount) || 0), 0)
      })

      const result = { fetchedAt: new Date().toISOString(), lineItems, trendLabels, monthlyTotals, period: { start, end } }
      setC(ck, result)
      return res.status(200).json(result)
    } catch (err: any) {
      console.error('distributors error:', err.message)
      return res.status(500).json({ error: err.message || 'Unknown error' })
    }
  })
}
