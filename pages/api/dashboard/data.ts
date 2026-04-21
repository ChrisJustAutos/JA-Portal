// pages/api/dashboard/data.ts
// Data resolver — serves widget data via direct CData/Supabase queries.
// Rewritten: uses DATE() for day-bucketing (CData-supported), avoids fanning
// out to internal portal APIs, and uses a per-request cache to collapse
// duplicate Monday fetches.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'
import { cdataQuery } from '../../../lib/cdata'
import { resolveDateRange, resolveCompareRange, DateRange } from '../../../lib/dashboard/dates'
import { DateRangeKey, CompareKey } from '../../../lib/dashboard/catalog'

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
let distConfigCache: { loadedAt: number, excluded: string[] } | null = null
async function getExcludedCustomers(): Promise<string[]> {
  if (distConfigCache && (Date.now() - distConfigCache.loadedAt) < 60_000) return distConfigCache.excluded
  try {
    const { data } = await sb().from('distributor_report_excluded_customers').select('customer_name')
    const excluded = (data || []).map((r: any) => String(r.customer_name || '').toLowerCase())
    distConfigCache = { loadedAt: Date.now(), excluded }
    return excluded
  } catch {
    return []
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
      if (excluded.includes(raw2.toLowerCase())) continue
      const clean = raw2.replace(/\s*\((Tuning\s*\d*|Tuning)\)\s*$/i, '').trim()
      if (!byName[clean]) byName[clean] = { name: clean, value: 0 }
      byName[clean].value += Number(r.revenue_ex || 0)
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
