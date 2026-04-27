// pages/api/dashboard/data.ts
// Data resolver — serves widget data via direct CData/Supabase queries.
// Rewritten: uses DATE() for day-bucketing (CData-supported), avoids fanning
// out to internal portal APIs, and uses a per-request cache to collapse
// duplicate Monday fetches.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { cdataQuery } from '../../../lib/cdata'
import { resolveDateRange, resolveCompareRange, DateRange } from '../../../lib/dashboard/dates'
import { DateRangeKey, CompareKey } from '../../../lib/dashboard/catalog'
import { reportTypesForUser, REPORT_TYPE_LABELS, REPORT_TYPE_DESCRIPTIONS, UserRole } from '../../../lib/permissions'

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// Convert a raw CData MCP response (with `results[0].schema` + `results[0].rows`
// as positional arrays) into a plain array of row objects keyed by column name.
function cdataRows(raw: any): any[] {
  const cols: string[] = raw?.results?.[0]?.schema?.map((c: any) => c.columnName) || []
  const rows: any[][] = raw?.results?.[0]?.rows || []
  return rows.map(r => {
    const o: any = {}
    cols.forEach((c, i) => { o[c] = r[i] })
    return o
  })
}

// Brisbane "today" as YYYY-MM-DD (Brisbane is UTC+10, no DST)
function brisbaneToday(): string {
  const ms = Date.now() + 10 * 60 * 60 * 1000
  return new Date(ms).toISOString().substring(0, 10)
}

// Given a YYYY-MM-DD date and a number of months, return the start-of-month
// N months back as YYYY-MM-DD. Used to build 12-month sparkline windows.
function isoMonthsBack(today: string, months: number): string {
  const d = new Date(today + 'T00:00:00Z')
  const back = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1), 1))
  return back.toISOString().substring(0, 10)
}

interface WidgetInstance {
  id: string
  type: string
  config: Record<string, any>
  dateOverride?: { range: DateRangeKey, from?: string, to?: string }
}
interface GlobalDate { key: DateRangeKey, from?: string, to?: string }

function effectiveRange(widget: WidgetInstance, global: GlobalDate, widgetPeriod?: DateRangeKey): DateRange {
  if (widget.dateOverride) return resolveDateRange(widget.dateOverride.range, widget.dateOverride.from, widget.dateOverride.to)
  if (widgetPeriod && widgetPeriod !== 'custom') return resolveDateRange(widgetPeriod)
  return resolveDateRange(global.key, global.from, global.to)
}

// ── Distributor-config helpers ────────────────────────────────────────────
// Returns a Map of lowercased customer name → note ('Excluded' | 'Sundry' | 'Internal').
// Matches the pattern used in pages/api/distributors.ts so the Sundry category
// is handled consistently across dashboard widgets and the Distributors page.
let distConfigCache: { loadedAt: number, excluded: Map<string, string> } | null = null
async function getExcludedCustomers(): Promise<Map<string, string>> {
  if (distConfigCache && (Date.now() - distConfigCache.loadedAt) < 60_000) return distConfigCache.excluded
  try {
    const { data } = await sb().from('distributor_report_excluded_customers').select('customer_name, note')
    const excluded = new Map<string, string>()
    for (const r of (data || []) as any[]) {
      const name = String(r.customer_name || '').toLowerCase().trim()
      if (!name) continue
      excluded.set(name, String(r.note || 'Excluded'))
    }
    distConfigCache = { loadedAt: Date.now(), excluded }
    return excluded
  } catch {
    return new Map()
  }
}

// ── Sales metric (single number) ──────────────────────────────────────────
async function salesMetric(metric: string, range: DateRange): Promise<number> {
  const from = `'${range.from}'`
  const to   = `'${range.to} 23:59:59'`

  if (metric === 'sales.revenue_ex_gst' || metric === 'sales.revenue_inc_gst') {
    const raw: any = await cdataQuery('JAWS',
      `SELECT SUM([TotalAmount]) AS total_inc, SUM([TotalTax]) AS total_tax
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE [Date] >= ${from} AND [Date] <= ${to}`)
    const row = cdataRows(raw)[0] || {}
    const incGst = Number(row.total_inc || 0)
    const tax    = Number(row.total_tax || 0)
    return metric === 'sales.revenue_ex_gst' ? (incGst - tax) : incGst
  }
  if (metric === 'sales.invoice_count') {
    const raw: any = await cdataQuery('JAWS',
      `SELECT COUNT(*) AS cnt FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE [Date] >= ${from} AND [Date] <= ${to}`)
    const row = cdataRows(raw)[0] || {}
    return Number(row.cnt || 0)
  }
  if (metric === 'sales.avg_invoice') {
    const raw: any = await cdataQuery('JAWS',
      `SELECT COUNT(*) AS cnt, SUM([TotalAmount] - [TotalTax]) AS rev_ex
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE [Date] >= ${from} AND [Date] <= ${to}`)
    const row = cdataRows(raw)[0] || {}
    const cnt = Number(row.cnt || 0)
    return cnt > 0 ? Number(row.rev_ex || 0) / cnt : 0
  }
  return 0
}

// ── Sales time-series with proper DATE() bucketing ────────────────────────
async function salesSeries(metric: string, range: DateRange): Promise<{ label: string, value: number }[]> {
  const from = `'${range.from}'`
  const to   = `'${range.to} 23:59:59'`
  try {
    const raw: any = await cdataQuery('JAWS',
      `SELECT DATE([Date]) AS day,
              SUM([TotalAmount]) AS total_inc,
              SUM([TotalTax])    AS total_tax,
              COUNT(*)           AS cnt
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE [Date] >= ${from} AND [Date] <= ${to}
       GROUP BY DATE([Date])
       ORDER BY day`)
    const arr = cdataRows(raw)
    const byDay: Record<string, any> = {}
    for (const r of arr) {
      const day = String(r.day).substring(0, 10)
      byDay[day] = r
    }
    const out: { label: string, value: number }[] = []
    const cursor = new Date(range.from + 'T00:00:00Z')
    const end    = new Date(range.to   + 'T00:00:00Z')
    while (cursor <= end) {
      const day = cursor.toISOString().substring(0, 10)
      const r = byDay[day]
      const value = metric === 'sales.invoice_count'
        ? Number(r?.cnt || 0)
        : metric === 'sales.revenue_inc_gst'
          ? Number(r?.total_inc || 0)
          : Number(r?.total_inc || 0) - Number(r?.total_tax || 0)
      out.push({ label: day, value })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      if (out.length > 120) break
    }
    return out
  } catch (e: any) {
    console.error('salesSeries failed:', e?.message)
    return []
  }
}

// ── Top distributors — direct aggregate with exclusions ───────────────────
async function topDistributors(range: DateRange, limit: number): Promise<{ name: string, value: number }[]> {
  const from = `'${range.from}'`
  const to   = `'${range.to} 23:59:59'`
  try {
    const raw: any = await cdataQuery('JAWS',
      `SELECT [CustomerName],
              SUM([TotalAmount] - [TotalTax]) AS revenue_ex,
              COUNT(*) AS invoice_count
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE [Date] >= ${from} AND [Date] <= ${to}
         AND [TotalAmount] > 0
         AND [CustomerName] IS NOT NULL
       GROUP BY [CustomerName]
       ORDER BY revenue_ex DESC
       LIMIT ${limit * 3}`)
    const arr = cdataRows(raw)
    const excluded = await getExcludedCustomers()

    const byName: Record<string, { name: string, value: number }> = {}
    for (const r of arr) {
      const raw2 = String(r.CustomerName || '').trim()
      if (!raw2) continue

      // Check exclusion status — matches pages/api/distributors.ts logic.
      // 'Excluded' and 'Internal' are dropped. 'Sundry' is kept but rolled
      // up under a single synthetic distributor so it renders as one row.
      const clean = raw2.replace(/\s*\((Tuning\s*\d*|Tuning)\)\s*$/i, '').trim()
      const rawKey = raw2.toLowerCase()
      const cleanKey = clean.toLowerCase()
      const note = excluded.get(rawKey) || excluded.get(cleanKey) || null
      if (note && note !== 'Sundry') continue   // drop Excluded/Internal

      const displayName = note === 'Sundry' ? 'Sundry' : clean
      if (!byName[displayName]) byName[displayName] = { name: displayName, value: 0 }
      byName[displayName].value += Number(r.revenue_ex || 0)
    }
    return Object.values(byName).sort((a, b) => b.value - a.value).slice(0, limit)
  } catch (e: any) {
    console.error('topDistributors failed:', e?.message)
    return []
  }
}

async function distributorTotal(distributor: string, range: DateRange): Promise<number> {
  if (!distributor) return 0
  const from = `'${range.from}'`
  const to   = `'${range.to} 23:59:59'`
  const distEsc = distributor.replace(/'/g, "''").replace(/\s*\(Tuning.*\)\s*$/i, '').trim()
  try {
    const raw: any = await cdataQuery('JAWS',
      `SELECT SUM([TotalAmount] - [TotalTax]) AS revenue_ex
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE [Date] >= ${from} AND [Date] <= ${to}
         AND [CustomerName] LIKE '${distEsc}%'
         AND [TotalAmount] > 0`)
    const row = cdataRows(raw)[0] || {}
    return Number(row.revenue_ex || 0)
  } catch (e: any) {
    console.error('distributorTotal failed:', e?.message)
    return 0
  }
}

// ── Jobs / supplier invoices (Supabase direct) ────────────────────────────
async function jobsMetric(metric: string): Promise<number> {
  const { data: currentRun } = await sb().from('job_report_runs').select('id').eq('is_current', true).maybeSingle()
  if (!currentRun?.id) return 0
  if (metric === 'jobs.total_count') {
    const { count } = await sb().from('job_report_jobs').select('id', { count: 'exact', head: true }).eq('run_id', currentRun.id)
    return count || 0
  }
  if (metric === 'jobs.open_count') {
    const { count } = await sb().from('job_report_jobs').select('id', { count: 'exact', head: true })
      .eq('run_id', currentRun.id)
      .not('status', 'ilike', '%closed%')
      .not('status', 'ilike', '%invoiced%')
      .not('status', 'ilike', '%complete%')
    return count || 0
  }
  if (metric === 'jobs.closed_count') {
    const { count } = await sb().from('job_report_jobs').select('id', { count: 'exact', head: true })
      .eq('run_id', currentRun.id)
      .or('status.ilike.%closed%,status.ilike.%invoiced%,status.ilike.%complete%')
    return count || 0
  }
  if (metric === 'jobs.forecast_revenue') {
    // Sum estimated_total across jobs that are NOT closed/invoiced/complete.
    // Fetch only the two columns we need then sum in JS — simpler than trying
    // to use a server-side SUM via PostgREST (which doesn't support aggregates
    // via the standard select interface).
    const { data } = await sb().from('job_report_jobs')
      .select('status, estimated_total')
      .eq('run_id', currentRun.id)
    if (!data) return 0
    let total = 0
    for (const r of data as any[]) {
      const s = String(r.status || '').toLowerCase()
      const isClosed = s.includes('closed') || s.includes('invoiced') || s.includes('complete') || s === 'done' || s === 'finished'
      if (!isClosed) total += Number(r.estimated_total || 0)
    }
    return Math.round(total * 100) / 100
  }
  return 0
}

async function supplierInvoiceMetric(metric: string, range: DateRange): Promise<number> {
  if (metric === 'supplier_invoices.pending_count') {
    const { count } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true })
      .in('status', ['parsed', 'auto_approved'])
    return count || 0
  }
  if (metric === 'supplier_invoices.approved_count') {
    const { count } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true })
      .eq('status', 'approved')
      .gte('received_at', range.from).lte('received_at', range.to + 'T23:59:59')
    return count || 0
  }
  if (metric === 'supplier_invoices.pending_value') {
    const { data } = await sb().from('supplier_invoices').select('total_inc_gst').in('status', ['parsed', 'auto_approved'])
    return (data || []).reduce((s, r: any) => s + Number(r.total_inc_gst || 0), 0)
  }
  if (metric === 'supplier_invoices.match_rate') {
    const { count: total } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true })
      .gte('received_at', range.from).lte('received_at', range.to + 'T23:59:59')
    const { count: matched } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true })
      .eq('po_matches_job', true)
      .gte('received_at', range.from).lte('received_at', range.to + 'T23:59:59')
    return (total || 0) > 0 ? (matched || 0) / (total || 0) : 0
  }
  return 0
}

// ── Monday via /api/sales with per-request dedup cache ────────────────────
async function mondaySales(req: NextApiRequest, cache: Map<string, any>, range: DateRange): Promise<any> {
  const key = `monday:${range.from}:${range.to}`
  if (cache.has(key)) return cache.get(key)
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host  = req.headers.host
  try {
    const url = `${proto}://${host}/api/sales?startDate=${range.from}&endDate=${range.to}`
    const r = await fetch(url, { headers: { cookie: req.headers.cookie || '' } })
    if (!r.ok) throw new Error(`sales ${r.status}`)
    const d = await r.json()
    cache.set(key, d)
    return d
  } catch (e: any) {
    console.error('mondaySales failed:', e?.message)
    cache.set(key, null)
    return null
  }
}

async function mondayMetric(req: NextApiRequest, cache: Map<string, any>, metric: string, range: DateRange): Promise<number> {
  const d = await mondaySales(req, cache, range)
  if (!d) return 0
  const quotesArr: any[] = Array.isArray(d?.quotes) ? d.quotes : []
  const totalQuotes = quotesArr.reduce((s, q) => s + Number(q?.totalItems || 0), 0)
  const ordersWon   = Number(d?.orders?.totalOrders || 0)
  const pipelineVal = Number(d?.distributors?.total?.value || 0)
  if (metric === 'monday.quotes_count')      return totalQuotes
  if (metric === 'monday.orders_won_count')  return ordersWon
  if (metric === 'monday.orders_lost_count') return 0
  if (metric === 'monday.pipeline_value')    return pipelineVal
  if (metric === 'monday.conversion_rate')   return totalQuotes > 0 ? ordersWon / totalQuotes : 0
  return 0
}

// ── Cached internal-API proxies for new widgets ───────────────────────────
// Each one fetches once per request and caches the parsed payload, so a
// dashboard with several stock/calls/todos widgets only triggers one
// upstream call per data source.
function origin(req: NextApiRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host  = req.headers.host
  return `${proto}://${host}`
}

async function fetchCached(req: NextApiRequest, cache: Map<string, any>, key: string, path: string): Promise<any> {
  if (cache.has(key)) return cache.get(key)
  try {
    const r = await fetch(`${origin(req)}${path}`, { headers: { cookie: req.headers.cookie || '' } })
    if (!r.ok) throw new Error(`${path} ${r.status}`)
    const d = await r.json()
    cache.set(key, d)
    return d
  } catch (e: any) {
    console.error('fetchCached failed:', key, e?.message)
    cache.set(key, null)
    return null
  }
}

async function inventoryData(req: NextApiRequest, cache: Map<string, any>): Promise<any> {
  return fetchCached(req, cache, 'inventory', '/api/inventory')
}

async function callsStats(req: NextApiRequest, cache: Map<string, any>, range: DateRange, extension?: string): Promise<any> {
  const key = `calls-stats:${range.from}:${range.to}:${extension || ''}`
  const params = new URLSearchParams({ startDate: range.from, endDate: range.to })
  if (extension) params.set('extension', extension)
  return fetchCached(req, cache, key, `/api/calls/stats?${params.toString()}`)
}

async function callsList(req: NextApiRequest, cache: Map<string, any>, range: DateRange, opts: { direction?: string, disposition?: string, limit?: number } = {}): Promise<any> {
  const key = `calls-list:${range.from}:${range.to}:${JSON.stringify(opts)}`
  const params = new URLSearchParams({ startDate: range.from, endDate: range.to })
  if (opts.direction)   params.set('direction', opts.direction)
  if (opts.disposition) params.set('disposition', opts.disposition)
  return fetchCached(req, cache, key, `/api/calls?${params.toString()}`)
}

async function todosData(req: NextApiRequest, cache: Map<string, any>, range: DateRange): Promise<any> {
  const key = `todos:${range.from}:${range.to}`
  return fetchCached(req, cache, key, `/api/todos?startDate=${range.from}&endDate=${range.to}`)
}

async function vehicleSalesSummary(req: NextApiRequest, cache: Map<string, any>, range: DateRange): Promise<any> {
  const key = `vehicle-sales:${range.from}:${range.to}`
  return fetchCached(req, cache, key, `/api/vehicle-sales/summary?from=${range.from}&to=${range.to}`)
}

async function distributorsData(req: NextApiRequest, cache: Map<string, any>, range: DateRange): Promise<any> {
  const key = `dist:${range.from}:${range.to}`
  return fetchCached(req, cache, key, `/api/distributors?startDate=${range.from}&endDate=${range.to}`)
}

async function resolveMetric(req: NextApiRequest, cache: Map<string, any>, metric: string, range: DateRange): Promise<number> {
  if (metric.startsWith('sales.'))              return salesMetric(metric, range)
  if (metric.startsWith('monday.'))             return mondayMetric(req, cache, metric, range)
  if (metric.startsWith('jobs.'))               return jobsMetric(metric)
  if (metric.startsWith('supplier_invoices.'))  return supplierInvoiceMetric(metric, range)
  return 0
}

async function resolveSeries(req: NextApiRequest, cache: Map<string, any>, metric: string, range: DateRange): Promise<{ label: string, value: number }[]> {
  if (metric.startsWith('sales.')) return salesSeries(metric, range)
  // Non-sales metrics have no efficient GROUP BY — summary only (flat bar)
  const v = await resolveMetric(req, cache, metric, range)
  return [{ label: range.from + '→' + range.to, value: v }]
}

async function resolveWidget(
  req: NextApiRequest, cache: Map<string, any>,
  widget: WidgetInstance, global: GlobalDate,
): Promise<any> {
  const { type, config } = widget
  const widgetPeriod = (config?.period || config?.periodA || undefined) as DateRangeKey | undefined
  const range = effectiveRange(widget, global, widgetPeriod)

  switch (type) {
    case 'kpi_number': {
      const value = await resolveMetric(req, cache, config.metric, range)
      let compareValue: number | null = null
      if (config.compare && config.compare !== 'none') {
        const cmpRange = resolveCompareRange(range, config.compare as CompareKey)
        if (cmpRange) compareValue = await resolveMetric(req, cache, config.metric, cmpRange)
      }
      return { value, compareValue, range, metric: config.metric }
    }
    case 'kpi_comparison': {
      const ra = resolveDateRange(config.periodA as DateRangeKey)
      const rb = resolveDateRange(config.periodB as DateRangeKey)
      const [va, vb] = await Promise.all([
        resolveMetric(req, cache, config.metric, ra),
        resolveMetric(req, cache, config.metric, rb),
      ])
      return { valueA: va, valueB: vb, rangeA: ra, rangeB: rb, metric: config.metric }
    }
    case 'progress_target': {
      const value = await resolveMetric(req, cache, config.metric, range)
      const target = Number(config.target || 0)
      const pct = target > 0 ? Math.min(1, value / target) : 0
      return { value, target, pct, range, metric: config.metric }
    }
    case 'quotes_received': {
      const days = Math.max(7, Math.min(90, Number(config.days || 14)))
      const today = resolveDateRange('today')
      const yesterday = resolveDateRange('yesterday')
      const [todayCount, yCount] = await Promise.all([
        mondayMetric(req, cache, 'monday.quotes_count', today),
        mondayMetric(req, cache, 'monday.quotes_count', yesterday),
      ])
      const series = [
        { label: yesterday.from, value: yCount },
        { label: today.from,     value: todayCount },
      ]
      return { todayCount, yesterdayCount: yCount, series, days }
    }
    case 'sales_scorecard': {
      const d = await mondaySales(req, cache, range)
      if (!d) return { reps: [], range }
      const quotesArr: any[] = Array.isArray(d?.quotes) ? d.quotes : []
      const byPerson: Record<string, { value: number, count: number }> = d?.distributors?.byPerson || {}
      const repMap: Record<string, { name: string, quotes_count: number, revenue: number }> = {}
      for (const q of quotesArr) {
        const name = q.full || q.rep || 'unknown'
        repMap[name] = { name, quotes_count: Number(q.totalItems || 0), revenue: 0 }
      }
      for (const [person, stats] of Object.entries(byPerson)) {
        if (!repMap[person]) repMap[person] = { name: person, quotes_count: 0, revenue: 0 }
        repMap[person].revenue = Number(stats?.value || 0)
      }
      const reps = Object.values(repMap).sort((a, b) => b.revenue - a.revenue)
      const limit = Math.max(3, Math.min(20, Number(config.limit || 10)))
      return { reps: reps.slice(0, limit), range }
    }
    case 'pipeline_value': {
      const d = await mondaySales(req, cache, range)
      if (!d) return { value: 0, count: 0 }
      return {
        value: Number(d?.distributors?.total?.value || 0),
        count: Number(d?.distributors?.total?.count || 0),
      }
    }
    case 'line_chart':
    case 'bar_chart': {
      const series = await resolveSeries(req, cache, config.metric, range)
      return { series, range, metric: config.metric, bucket: config.bucket || 'day' }
    }
    case 'donut_chart': {
      const src = config.source
      if (src === 'jobs_by_status') {
        const { data: run } = await sb().from('job_report_runs').select('id').eq('is_current', true).maybeSingle()
        if (!run?.id) return { segments: [] }
        const { data } = await sb().from('job_report_jobs').select('status').eq('run_id', run.id)
        const counts: Record<string, number> = {}
        for (const r of (data as any[]) || []) { const k = r.status || '(no status)'; counts[k] = (counts[k] || 0) + 1 }
        return { segments: Object.entries(counts).map(([label, value]) => ({ label, value })) }
      }
      if (src === 'jobs_by_type') {
        const { data: run } = await sb().from('job_report_runs').select('id').eq('is_current', true).maybeSingle()
        if (!run?.id) return { segments: [] }
        const { data } = await sb().from('job_report_jobs').select('job_type').eq('run_id', run.id)
        const counts: Record<string, number> = {}
        for (const r of (data as any[]) || []) {
          const k = (r.job_type && String(r.job_type).trim()) || '(no type)'
          counts[k] = (counts[k] || 0) + 1
        }
        return { segments: Object.entries(counts).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) }
      }
      if (src === 'supplier_invoices_by_status') {
        const { data } = await sb().from('supplier_invoices').select('status')
        const counts: Record<string, number> = {}
        for (const r of (data as any[]) || []) counts[r.status] = (counts[r.status] || 0) + 1
        return { segments: Object.entries(counts).map(([label, value]) => ({ label, value })) }
      }
      if (src === 'leads_by_rep') {
        const d = await mondaySales(req, cache, range)
        if (!d) return { segments: [] }
        const quotesArr: any[] = Array.isArray(d?.quotes) ? d.quotes : []
        return { segments: quotesArr.map((q: any) => ({ label: q.full || q.rep || '?', value: Number(q.totalItems || 0) })).filter(s => s.value > 0) }
      }
      return { segments: [] }
    }
    case 'distributor_total': {
      const dist = String(config.distributor || '').trim()
      const value = await distributorTotal(dist, range)
      let compareValue: number | null = null
      if (config.compare && config.compare !== 'none') {
        const cmpRange = resolveCompareRange(range, config.compare as CompareKey)
        if (cmpRange) compareValue = await distributorTotal(dist, cmpRange)
      }
      return { value, compareValue, distributor: dist, range }
    }
    case 'top_distributors': {
      const limit = Math.max(3, Math.min(25, Number(config.limit || 10)))
      const items = await topDistributors(range, limit)
      return { items, range }
    }
    case 'job_status_breakdown': {
      const { data: run } = await sb().from('job_report_runs').select('id').eq('is_current', true).maybeSingle()
      if (!run?.id) return { segments: [], hasReport: false }
      const { data } = await sb().from('job_report_jobs').select('status').eq('run_id', run.id)
      const counts: Record<string, number> = {}
      for (const r of (data as any[]) || []) { const k = r.status || '(no status)'; counts[k] = (counts[k] || 0) + 1 }
      return { segments: Object.entries(counts).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value), hasReport: true }
    }
    case 'supplier_invoice_queue': {
      const statuses = ['parsed', 'auto_approved', 'approved', 'rejected', 'queued_myob', 'pushed_to_myob', 'push_failed']
      const counts: Record<string, number> = {}
      await Promise.all(statuses.map(async s => {
        const { count } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true }).eq('status', s)
        counts[s] = count || 0
      }))
      return counts
    }
    case 'recent_activity': {
      const limit = Math.max(5, Math.min(50, Number(config.limit || 15)))
      const events: any[] = []
      const { data: approvedInvs } = await sb().from('supplier_invoices')
        .select('id, supplier_name, invoice_number, total_inc_gst, reviewed_at, status')
        .not('reviewed_at', 'is', null)
        .order('reviewed_at', { ascending: false })
        .limit(limit)
      for (const i of approvedInvs || []) {
        events.push({
          time: (i as any).reviewed_at,
          kind: 'invoice_' + (i as any).status,
          title: `${(i as any).status === 'approved' ? 'Approved' : (i as any).status === 'rejected' ? 'Rejected' : 'Reviewed'}: ${(i as any).supplier_name || '?'} — ${(i as any).invoice_number || '?'}`,
          value: Number((i as any).total_inc_gst || 0),
          link: `/supplier-invoices/${(i as any).id}`,
        })
      }
      events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      return { events: events.slice(0, limit) }
    }
    case 'leaderboard': {
      const src = config.source
      const limit = Math.max(3, Math.min(25, Number(config.limit || 10)))
      if (src === 'reps_by_revenue' || src === 'reps_by_orders_won') {
        const d = await mondaySales(req, cache, range)
        if (!d) return { items: [], metricKind: src === 'reps_by_revenue' ? 'money' : 'count' }
        const byPerson: Record<string, { value: number, count: number }> = d?.distributors?.byPerson || {}
        const mapped = Object.entries(byPerson).map(([name, stats]) => ({
          name,
          value: src === 'reps_by_revenue' ? Number(stats?.value || 0) : Number(stats?.count || 0),
        }))
        mapped.sort((a, b) => b.value - a.value)
        return { items: mapped.slice(0, limit), metricKind: src === 'reps_by_revenue' ? 'money' : 'count' }
      }
      if (src === 'distributors_by_revenue') {
        const items = await topDistributors(range, limit)
        return { items, metricKind: 'money' }
      }
      if (src === 'suppliers_by_spend') {
        const { data } = await sb().from('supplier_invoices')
          .select('supplier_name, total_inc_gst')
          .in('status', ['parsed', 'auto_approved', 'approved', 'queued_myob', 'pushed_to_myob'])
        const agg: Record<string, number> = {}
        for (const r of (data as any[]) || []) {
          const k = r.supplier_name || '(unknown)'
          agg[k] = (agg[k] || 0) + Number(r.total_inc_gst || 0)
        }
        const arr = Object.entries(agg).map(([name, value]) => ({ name, value }))
        arr.sort((a, b) => b.value - a.value)
        return { items: arr.slice(0, limit), metricKind: 'money' }
      }
      return { items: [], metricKind: 'count' }
    }
    case 'markdown_note': {
      return { content: String(config.content || '') }
    }

    // ── Calls widgets ────────────────────────────────────────────────────
    case 'calls_kpi': {
      const ext = String(config.extension || '').trim() || undefined
      const stats = await callsStats(req, cache, range, ext)
      if (!stats) return { total: 0, answered: 0, missed_inbound: 0, talk_seconds: 0, range }
      // /api/calls/stats returns the period totals on `today` (yes the field
      // is misnamed — it always reflects the requested range).
      return {
        total:          stats.today?.total          || 0,
        answered:       stats.today?.answered       || 0,
        missed_inbound: stats.today?.missed_inbound || 0,
        talk_seconds:   stats.today?.talk_seconds   || 0,
        range,
      }
    }
    case 'calls_agent_leaderboard': {
      const limit = Math.max(3, Math.min(15, Number(config.limit || 8)))
      const stats = await callsStats(req, cache, range)
      if (!stats?.agents) return { agents: [], range }
      const agents = (stats.agents as any[])
        .map(a => ({
          name:         a.display_name,
          extension:    a.extension,
          talk_seconds: Number(a.week_talk_seconds || 0),  // = period talk seconds (legacy field name)
          total:        Number(a.today_total || 0),
        }))
        .filter(a => a.talk_seconds > 0)
        .sort((a, b) => b.talk_seconds - a.talk_seconds)
        .slice(0, limit)
      return { agents, range }
    }
    case 'calls_missed_recent': {
      const limit = Math.max(5, Math.min(30, Number(config.limit || 10)))
      // Missed inbound = direction inbound + disposition NOT ANSWERED. The
      // calls API doesn't take a "not answered" filter, so we filter in JS.
      const data = await callsList(req, cache, range, { direction: 'inbound' })
      if (!data?.calls) return { calls: [] }
      const missed = (data.calls as any[])
        .filter(c => c.disposition !== 'ANSWERED')
        .slice(0, limit)
      return { calls: missed }
    }

    // ── Todos widgets ────────────────────────────────────────────────────
    case 'todos_kpi': {
      const data = await todosData(req, cache, range)
      if (!data?.totals) return { openTotal: 0, critical: 0, completedInPeriod: 0 }
      const managerFilter = String(config.manager || '').trim()
      if (managerFilter) {
        // Filter to the named manager's row
        const m = (data.managers as any[]).find(x => String(x.manager || '').toLowerCase() === managerFilter.toLowerCase())
        if (!m) return { openTotal: 0, critical: 0, completedInPeriod: 0 }
        return {
          openTotal:         m.openTotal || 0,
          critical:          m.critical || 0,
          completedInPeriod: m.completedInPeriod || 0,
        }
      }
      return {
        openTotal:         data.totals.openTotal         || 0,
        critical:          data.totals.critical          || 0,
        completedInPeriod: data.totals.completedInPeriod || 0,
      }
    }
    case 'todos_manager_scorecard': {
      const data = await todosData(req, cache, range)
      if (!data?.managers) return { managers: [] }
      const managers = (data.managers as any[])
        .map(m => ({
          manager:           m.manager,
          openTotal:         m.openTotal || 0,
          critical:          m.critical || 0,
          completedInPeriod: m.completedInPeriod || 0,
          avgAgeDays:        m.avgAgeDays ?? null,
        }))
        .sort((a, b) => b.openTotal - a.openTotal)
      return { managers }
    }

    // ── Inventory widgets ────────────────────────────────────────────────
    case 'stock_health_kpi': {
      const inv = await inventoryData(req, cache)
      if (!inv?.totals) return {}
      return {
        stockValue:           inv.totals.stockValue           || 0,
        totalSkus:            inv.totals.totalSkus            || 0,
        lowStockCount:        inv.totals.lowStockCount        || 0,
        outOfStockCount:      inv.totals.outOfStockCount      || 0,
        deadStock180dCount:   inv.totals.deadStock180dCount   || 0,
        deadStock180dValue:   inv.totals.deadStock180dValue   || 0,
      }
    }
    case 'stock_critical_reorder': {
      const within = Math.max(7, Math.min(90, Number(config.days || 30)))
      const limit  = Math.max(5, Math.min(30, Number(config.limit || 12)))
      const inv = await inventoryData(req, cache)
      if (!inv?.items) return { items: [] }
      const items = (inv.items as any[])
        .filter(i => i.daysOfCover !== null && i.daysOfCover < within && i.qtyOnHand > 0)
        .sort((a, b) => (a.daysOfCover || 0) - (b.daysOfCover || 0))
        .slice(0, limit)
        .map(i => ({
          sku: i.number, name: i.name,
          qtyOnHand: i.qtyOnHand, qtyOnOrder: i.qtyOnOrder,
          daysOfCover: i.daysOfCover, supplier: i.supplier,
        }))
      return { items }
    }
    case 'stock_dead_top': {
      const limit = Math.max(5, Math.min(25, Number(config.limit || 10)))
      const inv = await inventoryData(req, cache)
      if (!inv?.items) return { items: [] }
      const items = (inv.items as any[])
        .filter(i => i.isDead180d && (i.stockValue || 0) > 0)
        .sort((a, b) => (b.stockValue || 0) - (a.stockValue || 0))
        .slice(0, limit)
        .map(i => ({
          sku: i.number, name: i.name,
          stockValue: i.stockValue, qtyOnHand: i.qtyOnHand,
          daysSinceLastSold: i.daysSinceLastSold,
        }))
      return { items }
    }

    // ── Sales: top active leads ──────────────────────────────────────────
    case 'top_active_leads': {
      const limit = Math.max(5, Math.min(25, Number(config.limit || 10)))
      const d = await mondaySales(req, cache, range)
      if (!d?.activeLeads) return { leads: [] }
      const PIPELINE_STATUSES = ['3 Days','14 Days','On Hold','Quote On Hold','Quote Sent','Not Done','Follow Up Done','Quote Not Issued']
      const leads = (d.activeLeads as any[])
        .filter(l => PIPELINE_STATUSES.includes(l.status))
        .map(l => ({
          name:   l.name,
          rep:    l.repFull || l.rep || 'unknown',
          value:  Number(l.quoteValue || 0),
          status: l.status,
          url:    l.url || null,
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit)
      return { leads }
    }

    // ── Distributor: 12-month sparkline for one distributor ──────────────
    case 'distributor_trend_mini': {
      const dist = String(config.distributor || '').trim()
      if (!dist) return { series: [], distributor: '' }
      // Pull 12 months ending today
      const today = brisbaneToday()
      const from  = isoMonthsBack(today, 12)
      const fullRange: DateRange = { from, to: today }
      const d = await distributorsData(req, cache, fullRange)
      if (!d?.lineItems) return { series: [], distributor: dist }
      // Group revenue by month for the named distributor (canonical alias match)
      const targetLower = dist.toLowerCase()
      const byMonth: Record<string, number> = {}
      for (const li of (d.lineItems as any[])) {
        const name = String(li.CustomerName || '').toLowerCase()
        if (name !== targetLower) continue
        const monthKey = String(li.Date || '').substring(0, 7)
        if (!monthKey) continue
        byMonth[monthKey] = (byMonth[monthKey] || 0) + Number(li.Total || 0)
      }
      // Build dense 12-month series (zero-fill missing months)
      const series: { label: string, value: number }[] = []
      const startD = new Date(from + 'T00:00:00Z')
      for (let i = 0; i < 12; i++) {
        const m = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth() + i, 1))
        const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`
        series.push({ label: key, value: Math.round(byMonth[key] || 0) })
      }
      return { series, distributor: dist }
    }

    // ── Reports: quick-launch tiles for the user's available report types
    case 'reports_quick_launch': {
      const user = await getSessionUser(req)
      if (!user) return { items: [] }
      const types = reportTypesForUser(user.role as UserRole, null, user.visibleTabs || null)
      const items = types.map(t => ({
        type:        t,
        label:       REPORT_TYPE_LABELS[t]       || t,
        description: REPORT_TYPE_DESCRIPTIONS[t] || '',
      }))
      return { items }
    }

    // ── Vehicle sales (VPS classification) ───────────────────────────────
    case 'vehicle_sales_kpi': {
      const v = await vehicleSalesSummary(req, cache, range)
      if (!v?.summary) return {}
      return {
        total_ex_gst:       v.summary.total_ex_gst       || 0,
        classified_total:   v.summary.classified_total   || 0,
        unclassified_total: v.summary.unclassified_total || 0,
        invoice_count:      v.summary.invoice_count      || 0,
      }
    }
  }
  throw new Error(`Unknown widget type: ${type}`)
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  return requireAuth(req, res, async () => {
    try {
      const body = req.body || {}
      const widgets: WidgetInstance[] = Array.isArray(body.widgets) ? body.widgets : []
      const global: GlobalDate = body.globalDateRange || { key: 'today' }
      const cache = new Map<string, any>()
      const entries = await Promise.all(widgets.map(async (w) => {
        try {
          const data = await resolveWidget(req, cache, w, global)
          return [w.id, { ok: true, data }] as [string, any]
        } catch (e: any) {
          console.error('widget', w.id, w.type, 'failed:', e?.message)
          return [w.id, { ok: false, error: e?.message || 'Resolver failed' }] as [string, any]
        }
      }))
      res.status(200).json({ results: Object.fromEntries(entries) })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}
