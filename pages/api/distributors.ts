// pages/api/distributors.ts — Distributor report matching Power BI Distributor Report
// JAWS only. Revenue bucketed by AccountDisplayID into Tuning/Parts/Oil, ex-GST.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export const config = { maxDuration: 60 }

// ── Account buckets (from Power BI model) ──────────────────────────────────
const TUNING_ACCS = ['4-1905', '4-1910', '4-1915', '4-1920']
const PARTS_ACCS = [
  '4-1000', '4-1401', '4-1602', '4-1701', '4-1802', '4-1803', '4-1805',
  '4-1807', '4-1811', '4-1813', '4-1814', '4-1821', '4-1861',
]
const OIL_ACCS = ['4-1060']

const EXCLUDED_ACC_PREFIXES = ['1-', '2-', '6-']
const EXCLUDED_ACCS = new Set([
  '4-0001', '4-0002', '4-2001', '4-2999', '4-5000',
])

const EXCLUDED_CUSTOMERS = new Set([
  'VPS', 'Vehicle Performance Solutions T/A Just Autos',
  'Duncan Scott', 'Kent Dalton', 'Wade Kelly', 'Mark Cooper', 'Sean Poiani',
  'Allsorts Mechanical', 'HD Automotive', 'McCormacks 4wd', 'Vito Media',
  'Michael Scalzo', 'Macpherson Witham', 'Mark Naidoo', 'Anthony Barraball',
].map(s => s.toLowerCase()))

const INTERNATIONAL_DISTRIBUTORS = new Set([
  'kanoo motors wll', 'karyokuae', 'us cruiserz',
])

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

function exGst(total: number, taxCode: string | null): number {
  return taxCode === 'GST' ? total / 1.1 : total
}

// Inline date parsing — reads startDate/endDate from req.query with a FY fallback.
// No dependency on lib/cdata parseDateRange to avoid any signature-mismatch crashes.
function resolveDateRange(req: NextApiRequest): { start: string; end: string } {
  const qs = req.query || {}
  const s = typeof qs.startDate === 'string' ? qs.startDate : ''
  const e = typeof qs.endDate === 'string' ? qs.endDate : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}$/.test(e)) {
    return { start: s, end: e }
  }
  // Fallback: current AU financial year (Jul 1 → Jun 30)
  const now = new Date()
  const fy = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()
  return { start: `${fy - 1}-07-01`, end: `${fy}-06-30` }
}

type CDataResult = {
  results?: Array<{ rows?: any[][]; schema?: Array<{ columnName: string }> }>
}

function rowsOf(r: any): Record<string, any>[] {
  try {
    const set = r?.results?.[0]
    if (!set?.rows || !set?.schema) return []
    const cols = set.schema.map((c: any) => c.columnName)
    return set.rows.map((row: any[]) => {
      const o: Record<string, any> = {}
      cols.forEach((c: string, i: number) => { o[c] = row[i] })
      return o
    })
  } catch {
    return []
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function runHandler(req: NextApiRequest, res: NextApiResponse) {
  const debug = req.query.debug === '1'
  const trace: string[] = []

  try {
    trace.push('handler entered')
    const { start, end } = resolveDateRange(req)
    trace.push(`date range: ${start} to ${end}`)

    // Sanity check the cdataQuery import
    if (typeof cdataQuery !== 'function') {
      throw new Error('cdataQuery is not a function — check lib/cdata export')
    }
    trace.push('cdataQuery import ok')

    // Step 1: invoices in range
    let invRes: any
    try {
      invRes = await cdataQuery('JAWS', `
        SELECT [ID], [Number], [Date], [CustomerName], [TotalAmount], [Status]
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${start}' AND [Date] <= '${end}'
        ORDER BY [Date] DESC
      `)
    } catch (e: any) {
      throw new Error(`SaleInvoices query threw: ${e?.message || String(e)}`)
    }
    trace.push(`SaleInvoices result type: ${typeof invRes}`)

    const invoices = rowsOf(invRes)
    trace.push(`invoices fetched: ${invoices.length}`)

    if (!invoices.length) {
      return res.status(200).json({
        dateRange: { start, end },
        totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0 },
        distributors: [],
        monthlyNational: [],
        ...(debug ? { trace } : {}),
      })
    }

    const invById = new Map<string, Record<string, any>>()
    invoices.forEach(i => invById.set(i.ID, i))
    const invIds = Array.from(invById.keys())

    // Step 2: line items, batched by invoice ID
    const batches = chunk(invIds, 150)
    trace.push(`line item batches: ${batches.length}`)

    const lineRowsAll: Record<string, any>[] = []
    for (let i = 0; i < batches.length; i++) {
      const idList = batches[i].map(id => `'${id}'`).join(',')
      try {
        const r = await cdataQuery('JAWS', `
          SELECT [SaleInvoiceId], [AccountDisplayID], [TaxCodeCode], [Total], [Description]
          FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems]
          WHERE [SaleInvoiceId] IN (${idList})
        `)
        const rows = rowsOf(r)
        lineRowsAll.push(...rows)
        trace.push(`batch ${i + 1}/${batches.length}: ${rows.length} lines`)
      } catch (e: any) {
        throw new Error(`Line item batch ${i + 1}/${batches.length} threw: ${e?.message || String(e)}`)
      }
    }
    trace.push(`total line items: ${lineRowsAll.length}`)

    // Step 3: aggregate
    type DistAgg = {
      customerBase: string
      location: 'National' | 'International'
      tuning: number; parts: number; oil: number
      invoiceCount: Set<string>
      lineItems: Array<{
        date: string; invoiceNumber: string; description: string
        amountExGst: number; bucket: string; accountCode: string
      }>
    }
    const byDist = new Map<string, DistAgg>()

    for (const line of lineRowsAll) {
      const inv = invById.get(line.SaleInvoiceId)
      if (!inv) continue

      const rawCustomer: string = inv.CustomerName || ''
      if (EXCLUDED_CUSTOMERS.has(rawCustomer.toLowerCase())) continue

      const base = customerBase(rawCustomer)
      if (!base || EXCLUDED_CUSTOMERS.has(base.toLowerCase())) continue

      const acc: string = line.AccountDisplayID || ''
      if (isExcludedAccount(acc)) continue

      const bucket = bucketFor(acc)
      if (!bucket) continue

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
    trace.push(`distributors: ${byDist.size}`)

    // Step 4: shape response
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
        hasZeroStream: d.tuning === 0 || d.parts === 0 || d.oil === 0,
        lineItems: d.lineItems.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      }
    }).sort((a, b) => b.total - a.total)

    const monthly = new Map<string, number>()
    for (const d of distributors.filter(d => d.location === 'National')) {
      for (const li of d.lineItems) {
        const ym = (li.date || '').substring(0, 7)
        if (!ym) continue
        monthly.set(ym, (monthly.get(ym) || 0) + li.amountExGst)
      }
    }
    const monthlyNational = Array.from(monthly.entries())
      .map(([ym, amount]) => ({ ym, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => a.ym.localeCompare(b.ym))

    const totals = distributors.reduce((acc, d) => ({
      tuning: acc.tuning + d.tuning,
      parts: acc.parts + d.parts,
      oil: acc.oil + d.oil,
      total: acc.total + d.total,
      invoiceCount: acc.invoiceCount + d.invoiceCount,
    }), { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0 })

    return res.status(200).json({
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
      ...(debug ? { trace } : {}),
    })
  } catch (e: any) {
    // Surface EVERYTHING so we can see what broke
    console.error('distributors handler error:', e)
    return res.status(500).json({
      error: 'Internal error',
      message: e?.message || String(e),
      stack: e?.stack?.split('\n').slice(0, 5),
      trace,
    })
  }
}

// Top-level wrapper — if requireAuth itself throws, we still get a JSON response.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (typeof requireAuth !== 'function') {
      throw new Error('requireAuth is not a function — check lib/auth export')
    }
    return await requireAuth(req, res, () => runHandler(req, res))
  } catch (e: any) {
    console.error('distributors top-level error:', e)
    return res.status(500).json({
      error: 'Top-level error',
      message: e?.message || String(e),
      stack: e?.stack?.split('\n').slice(0, 5),
    })
  }
}
