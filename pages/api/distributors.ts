// pages/api/distributors.ts
// Reads revenue-account categories from Supabase and reads customer
// classification entirely from the dist_groups/dist_group_members system
// (the Membership tab on /admin/groups).
//
// CUSTOMER CLASSIFICATION — single source of truth (30 Apr 2026):
//   Each MYOB customer (after alias resolution to canonical name) belongs
//   to exactly one group in the 'type' dimension:
//
//     • Distributors  → shown as a distributor
//     • Sundry        → rolled up into a single 'Sundry' bucket
//     • Excluded      → dropped entirely
//     • (no membership) → shown as a distributor (default)
//
//   No legacy hardcoded list. No fallback table. Classification is purely
//   what the user has set via the Membership tab. Unclassified customers
//   appear on the report by default — fix that by classifying them in
//   the Membership tab.
//
// Caching:
// - On each GET, check distributors_cache for the (start, end) range first.
// - Cache hit → return payload immediately with fromCache/computedAt flags.
// - Cache miss OR ?refresh=1 → compute live via MYOB, upsert into cache.
// - The nightly Vercel cron (/api/distributors/refresh-cache) rewrites cache
//   entries for known ranges (FY2025, FY2026, each month) at 02:00 AEST so
//   morning loads are instant.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange, endDateExclusive } from '../../lib/cdata'
import { lineExGst } from '../../lib/gst'
import { getGrouping, groupNameFor, GroupingSnapshot } from '../../lib/distGroups'

export const config = { maxDuration: 60 }

// ── Categories config ───────────────────────────────────────────────────
// Kept as a small fallback so a dropped DB connection doesn't take the
// report offline entirely. This is INFRASTRUCTURE config (which MYOB
// account codes belong to which revenue category), not customer
// classification — it doesn't drift the way exclusion lists do.
const FALLBACK_CATEGORIES = [
  { name: 'Tuning', sort_order: 1, account_codes: ['4-1905','4-1910','4-1915','4-1920'] },
  { name: 'Parts',  sort_order: 2, account_codes: ['4-1000','4-1401','4-1602','4-1701','4-1802','4-1803','4-1805','4-1807','4-1811','4-1813','4-1814','4-1821','4-1861'] },
  { name: 'Oil',    sort_order: 3, account_codes: ['4-1060'] },
]

interface LoadedConfig {
  categories: Array<{ name: string; sort_order: number; account_codes: string[] }>
  source: 'db' | 'fallback'
}

let _cfgCache: { cfg: LoadedConfig; at: number } | null = null
const CFG_TTL = 60 * 1000

function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

async function loadConfig(): Promise<LoadedConfig> {
  if (_cfgCache && Date.now() - _cfgCache.at < CFG_TTL) return _cfgCache.cfg
  try {
    const sb = sbAdmin()
    const catsRes = await sb
      .from('distributor_report_categories')
      .select('name, sort_order, account_codes')
      .order('sort_order')
    const cats = (catsRes.data || []).map((r: any) => ({
      name: String(r.name),
      sort_order: Number(r.sort_order) || 0,
      account_codes: Array.isArray(r.account_codes) ? r.account_codes.map(String) : [],
    }))
    if (cats.length === 0) {
      const cfg: LoadedConfig = { categories: FALLBACK_CATEGORIES, source: 'fallback' }
      _cfgCache = { cfg, at: Date.now() }
      return cfg
    }
    const cfg: LoadedConfig = { categories: cats, source: 'db' }
    _cfgCache = { cfg, at: Date.now() }
    return cfg
  } catch (e: any) {
    console.error('distributors: config load failed, using fallback —', e?.message)
    const cfg: LoadedConfig = { categories: FALLBACK_CATEGORIES, source: 'fallback' }
    _cfgCache = { cfg, at: Date.now() }
    return cfg
  }
}

// ── Customer classification helper ──────────────────────────────────────
// Returns one of: 'Distributors' | 'Sundry' | 'Excluded' | null based on
// which group (in the 'type' dimension) the canonical name belongs to.
// null means no membership in any type group → treated as a distributor.
function classifyCustomer(rawMyobName: string, snapshot: GroupingSnapshot): {
  canonical: string
  classification: string | null
} {
  const raw = String(rawMyobName || '').trim()
  if (!raw) return { canonical: '', classification: null }

  // Try the raw name first (covers most cases including aliases that map
  // tuning-suffixed names directly).
  let canonical = snapshot.aliasMap[raw]

  // Fall back to suffix-stripped name (e.g. "Foo Pty Ltd (Tuning 2)" → "Foo Pty Ltd"),
  // which gives us a chance against an alias defined on the bare name.
  if (!canonical) {
    const stripped = raw
      .replace(/\s*\(Tuning 2\)\s*$/i, '')
      .replace(/\s*\(Tuning 1\)\s*$/i, '')
      .replace(/\s*\(Tuning\)\s*$/i, '')
      .trim()
    canonical = snapshot.aliasMap[stripped] || stripped
  }

  const classification = groupNameFor(canonical, 'type', snapshot)
  return { canonical, classification }
}

// ── Core compute function ──────────────────────────────────────────────
export async function computeDistributorsPayload(start: string, end: string) {
  const cfg = await loadConfig()
  const grouping = await getGrouping()

  const accToCat = new Map<string, string>()
  for (const c of cfg.categories) {
    for (const code of c.account_codes) accToCat.set(code, c.name)
  }
  const allAccounts = Array.from(accToCat.keys())
  const categoryNames = cfg.categories.map(c => c.name)

  if (allAccounts.length === 0) {
    return {
      dateRange: { start, end }, configSource: cfg.source, categories: categoryNames,
      totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0, byCategory: {} },
      distributors: [], monthlyNational: [],
    }
  }

  const invRes: any = await cdataQuery('JAWS',
    "SELECT [ID],[Number],[Date],[CustomerName],[CustomerPurchaseOrderNumber],[IsTaxInclusive] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '" + start + "' AND [Date] < '" + endDateExclusive(end) + "'"
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
    return {
      dateRange: { start, end }, configSource: cfg.source, categories: categoryNames,
      totals: { tuning: 0, parts: 0, oil: 0, total: 0, invoiceCount: 0, distributorCount: 0, byCategory: {} },
      distributors: [], monthlyNational: [],
    }
  }

  const accList = allAccounts.map(a => "'" + a + "'").join(',')
  const lineRes: any = await cdataQuery('JAWS',
    "SELECT [SaleInvoiceId],[AccountDisplayID],[TaxCodeCode],[Total],[Description] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [AccountDisplayID] IN (" + accList + ")"
  )
  const lCols: string[] = lineRes?.results?.[0]?.schema?.map((c: any) => c.columnName) || []
  const lRows: any[][] = lineRes?.results?.[0]?.rows || []

  // Region detection: customers in the 'International' group in the region
  // dimension are tagged as such. Default is National.
  const intlSet = new Set<string>()
  const intlGroup = (grouping.groupsByDimension['region'] || []).find(g => g.name === 'International')
  if (intlGroup) {
    for (const m of grouping.members) {
      if (m.group_id === intlGroup.id) intlSet.add(m.canonical_name)
    }
  }

  const byDist = new Map<string, any>()
  for (const r of lRows) {
    const line: any = {}
    lCols.forEach((c, i) => { line[c] = r[i] })
    const inv = invById.get(line.SaleInvoiceId)
    if (!inv) continue
    const raw: string = String(inv.CustomerName || '')

    // Classify via the dist_groups system. Drop Excluded entirely;
    // roll Sundry into a single bucket; everyone else (Distributors group OR
    // no group membership) is shown as a real distributor.
    const { canonical, classification } = classifyCustomer(raw, grouping)
    if (!canonical) continue
    if (classification === 'Excluded') continue

    const acc: string = line.AccountDisplayID || ''
    const cat = accToCat.get(acc)
    if (!cat) continue
    const total = Number(line.Total) || 0
    const amt = lineExGst(total, inv.IsTaxInclusive, line.TaxCodeCode)

    const isSundry = classification === 'Sundry'
    const distKey = isSundry ? '__SUNDRY__' : canonical
    if (!byDist.has(distKey)) {
      byDist.set(distKey, {
        customerBase: isSundry ? 'Sundry' : canonical,
        location: isSundry ? 'Sundry' : (intlSet.has(canonical) ? 'International' : 'National'),
        isSundry,
        byCategory: {} as Record<string, number>,
        invoiceIds: new Set<string>(),
        lineItems: [] as any[],
      })
    }
    const agg = byDist.get(distKey)
    agg.byCategory[cat] = (agg.byCategory[cat] || 0) + amt
    agg.invoiceIds.add(inv.ID)
    agg.lineItems.push({
      date: inv.Date, invoiceNumber: inv.Number, description: line.Description || '',
      amountExGst: amt, bucket: cat, category: cat, accountCode: acc,
      poNumber: inv.CustomerPurchaseOrderNumber || '',
      sundryCustomer: isSundry ? canonical : null,
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
      isSundry: !!d.isSundry,
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

  return {
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
  }
}

// ── Range key classifier ────────────────────────────────────────────────
export function classifyRangeKey(start: string, end: string): string {
  if (start === '2024-07-01' && end === '2025-06-30') return 'FY2025'
  if (start === '2025-07-01' && end === '2026-06-30') return 'FY2026'
  const mStart = /^(\d{4})-(\d{2})-01$/.exec(start)
  if (mStart) {
    const year = Number(mStart[1])
    const month = Number(mStart[2])
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const expectedEnd = `${mStart[1]}-${mStart[2]}-${String(lastDay).padStart(2, '0')}`
    if (end === expectedEnd) return `${mStart[1]}-${mStart[2]}`
  }
  return 'custom'
}

// ── Cache helpers ───────────────────────────────────────────────────────
async function readCache(sb: ReturnType<typeof sbAdmin>, start: string, end: string) {
  const { data, error } = await sb
    .from('distributors_cache')
    .select('payload, computed_at, config_source, invoice_count, range_key')
    .eq('start_date', start)
    .eq('end_date', end)
    .maybeSingle()
  if (error) {
    console.warn('[distributors] cache read failed (non-fatal):', error.message)
    return null
  }
  return data
}

async function writeCache(
  sb: ReturnType<typeof sbAdmin>,
  start: string,
  end: string,
  payload: any,
  computedMs: number,
) {
  const row = {
    range_key: classifyRangeKey(start, end),
    start_date: start,
    end_date: end,
    payload,
    invoice_count: payload?.totals?.invoiceCount ?? 0,
    config_source: payload?.configSource ?? 'fallback',
    computed_at: new Date().toISOString(),
    computed_ms: computedMs,
  }
  const { error, data } = await sb
    .from('distributors_cache')
    .upsert(row, { onConflict: 'start_date,end_date' })
    .select('id')
  if (error) {
    console.error('[distributors] writeCache upsert error:', error.message, 'code:', error.code, 'details:', error.details)
    throw new Error(`writeCache: ${error.message}`)
  }
  console.log('[distributors] writeCache upsert returned:', data?.length, 'rows')
}

// ── HTTP handler ────────────────────────────────────────────────────────
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const params = new URLSearchParams(req.query as Record<string,string>)
      const { start, end } = parseDateRange(params)
      const rp = params.get('refresh')
      const forceRefresh = rp === '1' || rp === 'true'

      const sb = sbAdmin()

      // 1. Try cache first unless forcing refresh.
      if (!forceRefresh) {
        const cached = await readCache(sb, start, end)
        if (cached && cached.payload) {
          return res.status(200).json({
            ...cached.payload,
            fromCache: true,
            cachedAt: cached.computed_at,
            rangeKey: cached.range_key,
          })
        }
      }

      // 2. Cache miss (or forced refresh) — compute live.
      const t0 = Date.now()
      const payload = await computeDistributorsPayload(start, end)
      const computedMs = Date.now() - t0

      // 3. Store in cache for next time.
      try {
        await writeCache(sb, start, end, payload, computedMs)
        console.log('[distributors] cache WRITE ok for', start, '→', end, 'invoiceCount=', payload?.totals?.invoiceCount)
      } catch (e: any) {
        console.error('[distributors] cache write threw:', e?.message, e?.stack)
      }

      return res.status(200).json({
        ...payload,
        fromCache: false,
        cachedAt: new Date().toISOString(),
        rangeKey: classifyRangeKey(start, end),
        computedMs,
      })
    } catch (e: any) {
      console.error('distributors error:', e && e.message, e && e.stack)
      return res.status(500).json({ error: 'Internal error', message: (e && e.message) || String(e) })
    }
  })
}
