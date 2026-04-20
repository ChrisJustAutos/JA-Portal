// pages/api/distributors.ts
// Reads revenue-account categories and excluded-customer list from Supabase
// (`distributor_report_categories`, `distributor_report_excluded_customers`).
// Falls back to hard-coded legacy defaults if the config table is empty or
// the query fails — ensures the report keeps working even if config is broken.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'
import { lineExGst } from '../../lib/gst'

export const config = { maxDuration: 60 }

// ── Config loader with fallback ─────────────────────────────────────────
const LEGACY_CATEGORIES = [
  { name: 'Tuning', sort_order: 1, account_codes: ['4-1905','4-1910','4-1915','4-1920'] },
  { name: 'Parts',  sort_order: 2, account_codes: ['4-1000','4-1401','4-1602','4-1701','4-1802','4-1803','4-1805','4-1807','4-1811','4-1813','4-1814','4-1821','4-1861'] },
  { name: 'Oil',    sort_order: 3, account_codes: ['4-1060'] },
]
const LEGACY_EXCLUDED = [
  'vps','vehicle performance solutions t/a just autos',
  'duncan scott','kent dalton','wade kelly','mark cooper','sean poiani',
  'allsorts mechanical','hd automotive','mccormacks 4wd','vito media',
  'michael scalzo','macpherson witham','mark naidoo','anthony barraball',
]

interface LoadedConfig {
  categories: Array<{ name: string; sort_order: number; account_codes: string[] }>
  excluded: Set<string>
  source: 'db' | 'fallback'
}

let _cfgCache: { cfg: LoadedConfig; at: number } | null = null
const CFG_TTL = 60 * 1000

async function loadConfig(): Promise<LoadedConfig> {
  if (_cfgCache && Date.now() - _cfgCache.at < CFG_TTL) return _cfgCache.cfg
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    const cfg: LoadedConfig = { categories: LEGACY_CATEGORIES, excluded: new Set(LEGACY_EXCLUDED), source: 'fallback' }
    _cfgCache = { cfg, at: Date.now() }
    return cfg
  }
  try {
    const sb = createClient(url, key, { auth: { persistSession: false } })
    const [catsRes, exRes] = await Promise.all([
      sb.from('distributor_report_categories').select('name, sort_order, account_codes').order('sort_order'),
      sb.from('distributor_report_excluded_customers').select('customer_name'),
    ])
    const cats = (catsRes.data || []).map((r: any) => ({
      name: String(r.name),
      sort_order: Number(r.sort_order) || 0,
      account_codes: Array.isArray(r.account_codes) ? r.account_codes.map(String) : [],
    }))
    const excluded = new Set((exRes.data || []).map((r: any) => String(r.customer_name).toLowerCase()))
    if (cats.length === 0) {
      const cfg: LoadedConfig = {
        categories: LEGACY_CATEGORIES,
        excluded: excluded.size > 0 ? excluded : new Set(LEGACY_EXCLUDED),
        source: 'fallback',
      }
      _cfgCache = { cfg, at: Date.now() }
      return cfg
    }
    const cfg: LoadedConfig = { categories: cats, excluded, source: 'db' }
    _cfgCache = { cfg, at: Date.now() }
    return cfg
  } catch (e: any) {
    console.error('distributors: config load failed, using fallback —', e?.message)
    const cfg: LoadedConfig = { categories: LEGACY_CATEGORIES, excluded: new Set(LEGACY_EXCLUDED), source: 'fallback' }
    _cfgCache = { cfg, at: Date.now() }
    return cfg
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string,string>))
      const cfg = await loadConfig()

      const accToCat = new Map<string, string>()
      for (const c of cfg.categories) {
        for (const code of c.account_codes) accToCat.set(code, c.name)
      }
      const allAccounts = Array.from(accToCat.keys())
      const categoryNames = cfg.categories.map(c => c.name)

      if (allAccounts.length === 0) {
        return res.status(200).json({
          dateRange: { start, end }, configSource: cfg.source, categories: categoryNames,
          totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0, byCategory: {} },
          distributors: [], monthlyNational: [],
        })
      }

      const invRes: any = await cdataQuery('JAWS',
        "SELECT [ID],[Number],[Date],[CustomerName],[CustomerPurchaseOrderNumber],[IsTaxInclusive] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '" + start + "' AND [Date] <= '" + end + "'"
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
          dateRange: { start, end }, configSource: cfg.source, categories: categoryNames,
          totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0, byCategory: {} },
          distributors: [], monthlyNational: [],
        })
      }

      const accList = allAccounts.map(a => "'" + a + "'").join(',')
      const lineRes: any = await cdataQuery('JAWS',
        "SELECT [SaleInvoiceId],[AccountDisplayID],[TaxCodeCode],[Total],[Description] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [AccountDisplayID] IN (" + accList + ")"
      )
      const lCols: string[] = lineRes?.results?.[0]?.schema?.map((c: any) => c.columnName) || []
      const lRows: any[][] = lineRes?.results?.[0]?.rows || []

      const INTL = new Set(['kanoo motors wll','karyokuae','us cruiserz'])
      const EXCLUDED = cfg.excluded

      const byDist = new Map<string, any>()
      for (const r of lRows) {
        const line: any = {}
        lCols.forEach((c, i) => { line[c] = r[i] })
        const inv = invById.get(line.SaleInvoiceId)
        if (!inv) continue
        const raw: string = String(inv.CustomerName || '')
        if (EXCLUDED.has(raw.toLowerCase())) continue
        const base = raw.replace(/\s*\(Tuning 2\)\s*$/i,'').replace(/\s*\(Tuning 1\)\s*$/i,'').replace(/\s*\(Tuning\)\s*$/i,'').trim()
        if (!base || EXCLUDED.has(base.toLowerCase())) continue
        const acc: string = line.AccountDisplayID || ''
        const cat = accToCat.get(acc)
        if (!cat) continue
        const total = Number(line.Total) || 0
        const amt = lineExGst(total, inv.IsTaxInclusive, line.TaxCodeCode)
        if (!byDist.has(base)) {
          byDist.set(base, {
            customerBase: base,
            location: INTL.has(base.toLowerCase()) ? 'International' : 'National',
            byCategory: {} as Record<string, number>,
            invoiceIds: new Set<string>(),
            lineItems: [] as any[],
          })
        }
        const agg = byDist.get(base)
        agg.byCategory[cat] = (agg.byCategory[cat] || 0) + amt
        agg.invoiceIds.add(inv.ID)
        agg.lineItems.push({
          date: inv.Date, invoiceNumber: inv.Number, description: line.Description || '',
          amountExGst: amt, bucket: cat, category: cat, accountCode: acc,
          poNumber: inv.CustomerPurchaseOrderNumber || '',
        })
      }

      const distributors = Array.from(byDist.values()).map((d: any) => {
        const rounded: Record<string, number> = {}
        for (const name of categoryNames) rounded[name] = Math.round((d.byCategory[name] || 0) * 100) / 100
        const total = Object.values(rounded).reduce((s: number, v: number) => s + v, 0)
        const tuning = rounded['Tuning'] || 0
        const parts  = rounded['Parts']  || 0
        const oil    = rounded['Oil']    || 0
        const streamsWithValue = Object.values(rounded).filter(v => v > 0).length
        return {
          customerBase: d.customerBase, location: d.location,
          tuning, parts, oil,
          byCategory: rounded,
          total: Math.round(total * 100) / 100,
          invoiceCount: d.invoiceIds.size,
          avgJobValue: d.invoiceIds.size ? Math.round((total / d.invoiceIds.size) * 100) / 100 : 0,
          hasZeroStream: streamsWithValue < categoryNames.length,
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
      const byCategoryTotal: Record<string, number> = {}
      for (const name of categoryNames) byCategoryTotal[name] = 0
      for (const d of distributors) {
        tT += d.tuning; tP += d.parts; tO += d.oil; tTot += d.total; tIC += d.invoiceCount
        for (const name of categoryNames) byCategoryTotal[name] += (d.byCategory[name] || 0)
      }
      for (const name of categoryNames) byCategoryTotal[name] = Math.round(byCategoryTotal[name] * 100) / 100

      return res.status(200).json({
        dateRange: { start, end },
        configSource: cfg.source,
        categories: categoryNames,
        totals: {
          tuning: Math.round(tT * 100) / 100,
          parts: Math.round(tP * 100) / 100,
          oil: Math.round(tO * 100) / 100,
          total: Math.round(tTot * 100) / 100,
          invoiceCount: tIC,
          distributorCount: distributors.length,
          byCategory: byCategoryTotal,
        },
        distributors: distributors,
        monthlyNational: monthlyNational,
      })
    } catch (e: any) {
      console.error('distributors error:', e && e.message, e && e.stack)
      return res.status(500).json({ error: 'Internal error', message: (e && e.message) || String(e) })
    }
  })
}
