// pages/api/distributors.ts — Distributor report matching Power BI Distributor Report
// JAWS only. Revenue bucketed by AccountDisplayID into Tuning/Parts/Oil, ex-GST.
// Customer Base strips (Tuning)/(Tuning 1)/(Tuning 2) suffixes to combine dual MYOB cards.
// Distributor Location classifies National vs International. Excludes sundry/non-distributors.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// ── Account buckets (from Power BI model) ──────────────────────────────────
const TUNING_ACCS = ['4-1905', '4-1910', '4-1915', '4-1920']
const PARTS_ACCS = [
  '4-1000', '4-1401', '4-1602', '4-1701', '4-1802', '4-1803', '4-1805',
  '4-1807', '4-1811', '4-1813', '4-1814', '4-1821', '4-1861',
]
const OIL_ACCS = ['4-1060']

// Non-revenue / sundry accounts that must never be counted as distributor revenue
const EXCLUDED_ACC_PREFIXES = ['1-', '2-', '6-']
const EXCLUDED_ACCS = new Set([
  '4-0001', '4-0002', '4-2001', '4-2999', '4-5000',
])

// ── Customer filter — sundry / non-distributors to exclude ─────────────────
const EXCLUDED_CUSTOMERS = new Set([
  'VPS', 'Vehicle Performance Solutions T/A Just Autos',
  'Duncan Scott', 'Kent Dalton', 'Wade Kelly', 'Mark Cooper', 'Sean Poiani',
  'Allsorts Mechanical', 'HD Automotive', 'McCormacks 4wd', 'Vito Media',
  'Michael Scalzo', 'Macpherson Witham', 'Mark Naidoo', 'Anthony Barraball',
].map(s => s.toLowerCase()))

// ── International distributor list (else = National) ───────────────────────
const INTERNATIONAL_DISTRIBUTORS = new Set([
  'kanoo motors wll', 'karyokuae', 'us cruiserz',
])

// Derive the customer base by stripping tuning-suffix variants so that
// "Penrith 4x4" and "Penrith 4x4 (Tuning)" collapse to one distributor.
function customerBase(name: string): string {
  if (!name) return ''
  return name
    .replace(/\s*\(Tuning 2\)\s*$/i, '')
    .replace(/\s*\(Tuning 1\)\s*$/i, '')
    .replace(/\s*\(Tuning\)\s*$/i, '')
    .trim()
}

function distributorLocation(base: string): 'National' | 'International' {
  return INTERNATIONAL_DISTRIBUTORS.has(base.toLowerCase()) ? 'International' : 'National'
}

function isExcludedAccount(acc: string | null): boolean {
  if (!acc) return true
  if (EXCLUDED_ACCS.has(acc)) return true
  if (EXCLUDED_ACC_PREFIXES.some(p => acc.startsWith(p))) return true
  return false
}

function bucketFor(acc: string): 'Tuning' | 'Parts' | 'Oil' | null {
  if (TUNING_ACCS.includes(acc)) return 'Tuning'
  if (PARTS_ACCS.includes(acc)) return 'Parts'
  if (OIL_ACCS.includes(acc)) return 'Oil'
  return null
}

// Ex-GST conversion — CData can't JOIN, so this runs server-side after fetch
function exGst(total: number, taxCode: string | null): number {
  return taxCode === 'GST' ? total / 1.1 : total
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch (e: any) {
    console.error('distributors query failed:', e?.message?.substring(0, 200))
    return null
  }
}

type CDataResult = {
  results?: Array<{ rows?: any[][]; schema?: Array<{ columnName: string }> }>
}

// Flatten a CData result into an array of row-objects keyed by columnName
function rowsOf(r: CDataResult | null): Record<string, any>[] {
  const set = r?.results?.[0]
  if (!set?.rows || !set?.schema) return []
  const cols = set.schema.map(c => c.columnName)
  return set.rows.map(row => {
    const o: Record<string, any> = {}
    cols.forEach((c, i) => { o[c] = row[i] })
    return o
  })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const params = new URLSearchParams(req.query as Record<string, string>)
      const { start, end } = parseDateRange(params)

      // CData can't JOIN across these tables — query separately, match client-side on SaleInvoiceId = ID
      const [invRes, lineRes] = await Promise.all([
        safe(() => cdataQuery('JAWS', `
          SELECT [ID], [Number], [Date], [CustomerName], [TotalAmount], [Status]
          FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
          WHERE [Date] >= '${start}' AND [Date] <= '${end}'
          ORDER BY [Date] DESC
        `)),
        safe(() => cdataQuery('JAWS', `
          SELECT [SaleInvoiceId], [AccountDisplayID], [TaxCodeCode], [Total], [Description]
          FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
          WHERE [Total] <> 0
        `)),
      ])

      if (!invRes || !lineRes) {
        return res.status(502).json({
          error: 'MYOB query failed',
          detail: 'One or both CData queries returned no result. Check CData MCP connection to MYOB_POWERBI_JAWS.',
        })
      }

      const invoices = rowsOf(invRes)
      const lines = rowsOf(lineRes)

      // Index invoices by ID for the join
      const invById = new Map<string, Record<string, any>>()
      invoices.forEach(i => invById.set(i.ID, i))

      // Per-distributor aggregation
      type DistAgg = {
        customerBase: string
        location: 'National' | 'International'
        tuning: number
        parts: number
        oil: number
        invoiceCount: Set<string>
        lineItems: Array<{
          date: string; invoiceNumber: string; description: string;
          amountExGst: number; bucket: string; accountCode: string
        }>
      }
      const byDist = new Map<string, DistAgg>()

      for (const line of lines) {
        const inv = invById.get(line.SaleInvoiceId)
        if (!inv) continue // line belongs to an invoice outside date range

        const rawCustomer: string = inv.CustomerName || ''
        if (EXCLUDED_CUSTOMERS.has(rawCustomer.toLowerCase())) continue

        const base = customerBase(rawCustomer)
        if (!base || EXCLUDED_CUSTOMERS.has(base.toLowerCase())) continue

        const acc: string = line.AccountDisplayID || ''
        if (isExcludedAccount(acc)) continue

        const bucket = bucketFor(acc)
        if (!bucket) continue // not a distributor revenue account

        const total = Number(line.Total) || 0
        const amountExGst = exGst(total, line.TaxCodeCode)

        if (!byDist.has(base)) {
          byDist.set(base, {
            customerBase: base,
            location: distributorLocation(base),
            tuning: 0, parts: 0, oil: 0,
            invoiceCount: new Set(),
            lineItems: [],
          })
        }
        const agg = byDist.get(base)!
        if (bucket === 'Tuning') agg.tuning += amountExGst
        else if (bucket === 'Parts') agg.parts += amountExGst
        else if (bucket === 'Oil') agg.oil += amountExGst
        agg.invoiceCount.add(inv.ID)
        agg.lineItems.push({
          date: inv.Date,
          invoiceNumber: inv.Number,
          description: line.Description || '',
          amountExGst,
          bucket,
          accountCode: acc,
        })
      }

      // Shape response
      const distributors = Array.from(byDist.values()).map(d => {
        const total = d.tuning + d.parts + d.oil
        return {
          customerBase: d.customerBase,
          location: d.location,
          tuning: Math.round(d.tuning * 100) / 100,
          parts: Math.round(d.parts * 100) / 100,
          oil: Math.round(d.oil * 100) / 100,
          total: Math.round(total * 100) / 100,
          invoiceCount: d.invoiceCount.size,
          avgJobValue: d.invoiceCount.size ? Math.round((total / d.invoiceCount.size) * 100) / 100 : 0,
          // Power BI red flag — any revenue stream is zero
          hasZeroStream: d.tuning === 0 || d.parts === 0 || d.oil === 0,
          lineItems: d.lineItems.sort((a, b) =>
            (b.date || '').localeCompare(a.date || '')),
        }
      }).sort((a, b) => b.total - a.total)

      // Monthly totals (for page 4 chart) — National only
      const monthly = new Map<string, number>()
      for (const d of distributors.filter(d => d.location === 'National')) {
        for (const li of d.lineItems) {
          const ym = (li.date || '').substring(0, 7) // YYYY-MM
          if (!ym) continue
          monthly.set(ym, (monthly.get(ym) || 0) + li.amountExGst)
        }
      }
      const monthlyNational = Array.from(monthly.entries())
        .map(([ym, amount]) => ({ ym, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => a.ym.localeCompare(b.ym))

      // Aggregated totals for KPI cards
      const totals = distributors.reduce((acc, d) => ({
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
      console.error('distributors handler error:', e)
      res.status(500).json({ error: 'Internal error', detail: e?.message })
    }
  })
}
