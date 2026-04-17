// pages/api/distributors.ts
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string,string>))

      const TUNING = ['4-1905','4-1910','4-1915','4-1920']
      const PARTS  = ['4-1000','4-1401','4-1602','4-1701','4-1802','4-1803','4-1805','4-1807','4-1811','4-1813','4-1814','4-1821','4-1861']
      const OIL    = ['4-1060']

      const EXCLUDED = new Set([
        'vps','vehicle performance solutions t/a just autos',
        'duncan scott','kent dalton','wade kelly','mark cooper','sean poiani',
        'allsorts mechanical','hd automotive','mccormacks 4wd','vito media',
        'michael scalzo','macpherson witham','mark naidoo','anthony barraball',
      ])
      const INTL = new Set(['kanoo motors wll','karyokuae','us cruiserz'])

      // Query 1: invoices in date range
      const invRes: any = await cdataQuery('JAWS',
        "SELECT [ID],[Number],[Date],[CustomerName] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '" + start + "' AND [Date] <= '" + end + "'"
      )
      const invCols: string[] = invRes?.results?.[0]?.schema?.map((c: any) => c.columnName) || []
      const invRows: any[][] = invRes?.results?.[0]?.rows || []
      const invById = new Map<string, any>()
      for (const r of invRows) {
        const o: any = {}
        invCols.forEach((c, i) => { o[c] = r[i] })
        invById.set(o.ID, o)
      }

      if (invById.size === 0) {
        return res.status(200).json({
          dateRange: { start, end },
          totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0 },
          distributors: [], monthlyNational: [],
        })
      }

      // Query 2: ALL line items for revenue accounts in ONE shot (no batching).
      // SaleInvoiceItems has no Date column — we filter by AccountDisplayID server-side
      // and discard lines whose SaleInvoiceId isn't in our date-filtered invoice map.
      const accList = [...TUNING, ...PARTS, ...OIL].map(a => "'" + a + "'").join(',')
      const lineRes: any = await cdataQuery('JAWS',
        "SELECT [SaleInvoiceId],[AccountDisplayID],[TaxCodeCode],[Total],[Description] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [AccountDisplayID] IN (" + accList + ")"
      )
      const lCols: string[] = lineRes?.results?.[0]?.schema?.map((c: any) => c.columnName) || []
      const lRows: any[][] = lineRes?.results?.[0]?.rows || []

      // Aggregate
      const byDist = new Map<string, any>()
      for (const r of lRows) {
        const line: any = {}
        lCols.forEach((c, i) => { line[c] = r[i] })

        const inv = invById.get(line.SaleInvoiceId)
        if (!inv) continue // line belongs to an invoice outside the date range — skip

        const raw: string = String(inv.CustomerName || '')
        if (EXCLUDED.has(raw.toLowerCase())) continue
        const base = raw.replace(/\s*\(Tuning 2\)\s*$/i,'').replace(/\s*\(Tuning 1\)\s*$/i,'').replace(/\s*\(Tuning\)\s*$/i,'').trim()
        if (!base || EXCLUDED.has(base.toLowerCase())) continue

        const acc: string = line.AccountDisplayID || ''
        let bucket = ''
        if (TUNING.indexOf(acc) >= 0) bucket = 'Tuning'
        else if (PARTS.indexOf(acc) >= 0) bucket = 'Parts'
        else if (OIL.indexOf(acc) >= 0) bucket = 'Oil'
        else continue

        const total = Number(line.Total) || 0
        const amt = line.TaxCodeCode === 'GST' ? total / 1.1 : total

        if (!byDist.has(base)) {
          byDist.set(base, {
            customerBase: base,
            location: INTL.has(base.toLowerCase()) ? 'International' : 'National',
            tuning: 0, parts: 0, oil: 0,
            invoiceIds: new Set<string>(),
            lineItems: [] as any[],
          })
        }
        const agg = byDist.get(base)
        if (bucket === 'Tuning') agg.tuning += amt
        else if (bucket === 'Parts') agg.parts += amt
        else agg.oil += amt
        agg.invoiceIds.add(inv.ID)
        agg.lineItems.push({
          date: inv.Date,
          invoiceNumber: inv.Number,
          description: line.Description || '',
          amountExGst: amt,
          bucket: bucket,
          accountCode: acc,
        })
      }

      const distributors = Array.from(byDist.values()).map((d: any) => {
        const total = d.tuning + d.parts + d.oil
        return {
          customerBase: d.customerBase,
          location: d.location,
          tuning: Math.round(d.tuning * 100) / 100,
          parts: Math.round(d.parts * 100) / 100,
          oil: Math.round(d.oil * 100) / 100,
          total: Math.round(total * 100) / 100,
          invoiceCount: d.invoiceIds.size,
          avgJobValue: d.invoiceIds.size ? Math.round((total / d.invoiceIds.size) * 100) / 100 : 0,
          hasZeroStream: d.tuning === 0 || d.parts === 0 || d.oil === 0,
          lineItems: d.lineItems.sort(function(a: any, b: any) { return (b.date || '').localeCompare(a.date || '') }),
        }
      }).sort(function(a: any, b: any) { return b.total - a.total })

      const monthly = new Map<string, number>()
      for (const d of distributors) {
        if (d.location !== 'National') continue
        for (const li of d.lineItems) {
          const ym: string = (li.date || '').substring(0, 7)
          if (!ym) continue
          monthly.set(ym, (monthly.get(ym) || 0) + li.amountExGst)
        }
      }
      const monthlyNational = Array.from(monthly.entries())
        .map(function(e) { return { ym: e[0], amount: Math.round(e[1] * 100) / 100 } })
        .sort(function(a, b) { return a.ym.localeCompare(b.ym) })

      let tT = 0, tP = 0, tO = 0, tTot = 0, tIC = 0
      for (const d of distributors) { tT += d.tuning; tP += d.parts; tO += d.oil; tTot += d.total; tIC += d.invoiceCount }

      return res.status(200).json({
        dateRange: { start, end },
        totals: {
          tuning: Math.round(tT * 100) / 100,
          parts: Math.round(tP * 100) / 100,
          oil: Math.round(tO * 100) / 100,
          total: Math.round(tTot * 100) / 100,
          invoiceCount: tIC,
          distributorCount: distributors.length,
        },
        distributors: distributors,
        monthlyNational: monthlyNational,
      })
    } catch (e: any) {
      console.error('distributors error:', e && e.message, e && e.stack)
      return res.status(500).json({
        error: 'Internal error',
        message: (e && e.message) || String(e),
      })
    }
  })
}
