// pages/api/distributors.ts
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

const TUNING_ACCS = ['4-1905','4-1910','4-1915','4-1920']
const PARTS_ACCS  = ['4-1000','4-1401','4-1602','4-1701','4-1802','4-1803','4-1805','4-1807','4-1811','4-1813','4-1814','4-1821','4-1861']
const OIL_ACCS    = ['4-1060']
const ALL_REVENUE_ACCS = [...TUNING_ACCS, ...PARTS_ACCS, ...OIL_ACCS]

const EXCLUDED_CUSTOMERS = new Set([
  'vps','vehicle performance solutions t/a just autos',
  'duncan scott','kent dalton','wade kelly','mark cooper','sean poiani',
  'allsorts mechanical','hd automotive','mccormacks 4wd','vito media',
  'michael scalzo','macpherson witham','mark naidoo','anthony barraball',
])

const INTERNATIONAL = new Set(['kanoo motors wll','karyokuae','us cruiserz'])

function customerBase(name: string): string {
  if (!name) return ''
  return name.replace(/\s*\(Tuning 2\)\s*$/i,'').replace(/\s*\(Tuning 1\)\s*$/i,'').replace(/\s*\(Tuning\)\s*$/i,'').trim()
}

function bucketFor(acc: string): 'Tuning' | 'Parts' | 'Oil' | null {
  if (TUNING_ACCS.includes(acc)) return 'Tuning'
  if (PARTS_ACCS.includes(acc)) return 'Parts'
  if (OIL_ACCS.includes(acc)) return 'Oil'
  return null
}

function rowsOf(r: any): any[] {
  const rows = r?.results?.[0]?.rows
  const schema = r?.results?.[0]?.schema
  if (!rows || !schema) return []
  const cols = schema.map((c: any) => c.columnName)
  return rows.map((row: any[]) => {
    const o: any = {}
    cols.forEach((c: string, i: number) => { o[c] = row[i] })
    return o
  })
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string,string>))

      // Step 1: invoices in range
      const invRes: any = await cdataQuery('JAWS',
        `SELECT [ID],[Number],[Date],[CustomerName] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}'`
      )
      const invoices = rowsOf(invRes)

      if (!invoices.length) {
        return res.status(200).json({
          dateRange: { start, end },
          totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0 },
          distributors: [], monthlyNational: [],
        })
      }

      const invById = new Map<string, any>()
      invoices.forEach((i: any) => invById.set(i.ID, i))
      const invIds = Array.from(invById.keys())

      // Step 2: line items batched by invoice ID, pre-filtered to revenue accounts
      const accList = ALL_REVENUE_ACCS.map(a => `'${a}'`).join(',')
      const batches = chunk(invIds, 100)
      const allLines: any[] = []

      for (const batch of batches) {
        const idList = batch.map(id => `'${id}'`).join(',')
        const r: any = await cdataQuery('JAWS',
          `SELECT [SaleInvoiceId],[AccountDisplayID],[TaxCodeCode],[Total],[Description] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [SaleInvoiceId] IN (${idList}) AND [AccountDisplayID] IN (${accList})`
        )
        allLines.push(...rowsOf(r))
      }

      // Step 3: aggregate
      const byDist = new Map<string, any>()

      for (const line of allLines) {
        const inv = invById.get(line.SaleInvoiceId)
        if (!inv) continue
        const raw = (inv.CustomerName || '').toString()
        if (EXCLUDED_CUSTOMERS.has(raw.toLowerCase())) continue
        const base = customerBase(raw)
        if (!base || EXCLUDED_CUSTOMERS.has(base.toLowerCase())) continue

        const acc = line.AccountDisplayID || ''
        const bucket = bucketFor(acc)
        if (!bucket) continue

        const total = Number(line.Total) || 0
        const amt = line.TaxCodeCode === 'GST' ? total / 1.1 : total

        if (!byDist.has(base)) {
          byDist.set(base, {
            customerBase: base,
            location: INTERNATIONAL.has(base.toLowerCase()) ? 'International' : 'National',
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
          date: inv.Date, invoiceNumber: inv.Number, description: line.Description || '',
          amountExGst: amt, bucket, accountCode: acc,
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
          lineItems: d.lineItems.sort((a: any, b: any) => (b.date || '').localeCompare(a.date || '')),
        }
      }).sort((a: any, b: any) => b.total - a.total)

      const monthly = new Map<string, number>()
      for (const d of distributors.filter((d: any) => d.location === 'National')) {
        for (const li of d.lineItems) {
          const ym = (li.date || '').substring(0, 7)
          if (!ym) continue
          monthly.set(ym, (monthly.get(ym) || 0) + li.amountExGst)
        }
      }
      const monthlyNational = Array.from(monthly.entries())
        .map(([ym, amount]) => ({ ym, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => a.ym.localeCompare(b.ym))

      const totals = distributors.reduce((acc: any, d: any) => ({
        tuning: acc.tuning + d.tuning,
        parts: acc.parts + d.parts,
        oil: acc.oil + d.oil,
        total: acc.total + d.total,
        invoiceCount: acc.invoiceCount + d.invoiceCount,
      }), { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0 })

      res.status(200).json({
        dateRange: { start, end },
        totals: {
          tuning: Math.round(totals.tuning * 100) / 100,
          parts: Math.round(totals.parts * 100) / 100,
          oil: Math.round(totals.oil * 100) / 100,
          total: Math.round(totals.total * 100) / 100,
          invoiceCount: totals.invoiceCount,
          distributorCount: distributors.length,
        },
        distributors,
        monthlyNational,
      })
    } catch (e: any) {
      console.error('distributors error:', e?.message)
      res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}
