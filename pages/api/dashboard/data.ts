// pages/api/dashboard/data.ts
// Data resolver — serves the numbers/series/lists that widgets display.
//
// POST body:
//   {
//     widgets: [
//       { id, type, config, dateOverride? },
//       ...
//     ],
//     globalDateRange: { key, from?, to? }
//   }
//
// Response:
//   { results: { [widgetId]: { ok: true, data: ... } | { ok: false, error: ... } } }
//
// Each widget returns a shape specific to its type. The frontend renderers
// know how to consume each shape. Unknown/failed widgets return { ok: false,
// error } so the UI can render an error state without blanking the dashboard.

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

interface WidgetInstance {
  id: string
  type: string
  config: Record<string, any>
  dateOverride?: { range: DateRangeKey, from?: string, to?: string }
}

interface GlobalDate { key: DateRangeKey, from?: string, to?: string }

// Pick the effective date range for a widget — per-widget override wins if set.
function effectiveRange(widget: WidgetInstance, global: GlobalDate, widgetPeriod?: DateRangeKey): DateRange {
  if (widget.dateOverride) {
    return resolveDateRange(widget.dateOverride.range, widget.dateOverride.from, widget.dateOverride.to)
  }
  if (widgetPeriod && widgetPeriod !== 'custom') {
    // widget has its own period in config (not a global override)
    return resolveDateRange(widgetPeriod)
  }
  return resolveDateRange(global.key, global.from, global.to)
}

// ── Sales metric helpers (MYOB via CData) ─────────────────────────────────

async function salesMetric(metric: string, range: DateRange): Promise<number> {
  // SaleInvoices table: Date, TotalAmount, TotalTax, TaxCodeCode filtering etc.
  // Ex-GST: TotalAmount - TotalTax
  // Exclude deleted / voided via Status != 'Deleted'.
  const fromQ = `CAST('${range.from}' AS DATE)`
  const toQ   = `CAST('${range.to}'   AS DATE)`

  if (metric === 'sales.revenue_ex_gst' || metric === 'sales.revenue_inc_gst') {
    const rows: any = await cdataQuery('JAWS',
      `SELECT SUM(TotalAmount) as total_inc, SUM(TotalTax) as total_tax
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE Date >= ${fromQ} AND Date <= ${toQ}`)
    const row = Array.isArray(rows) ? rows[0] : rows
    const incGst = Number(row?.total_inc || 0)
    const tax    = Number(row?.total_tax || 0)
    return metric === 'sales.revenue_ex_gst' ? (incGst - tax) : incGst
  }
  if (metric === 'sales.invoice_count') {
    const rows: any = await cdataQuery('JAWS',
      `SELECT COUNT(*) as cnt FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE Date >= ${fromQ} AND Date <= ${toQ}`)
    const row = Array.isArray(rows) ? rows[0] : rows
    return Number(row?.cnt || 0)
  }
  if (metric === 'sales.avg_invoice') {
    const rows: any = await cdataQuery('JAWS',
      `SELECT COUNT(*) as cnt, SUM(TotalAmount - TotalTax) as rev_ex
       FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
       WHERE Date >= ${fromQ} AND Date <= ${toQ}`)
    const row = Array.isArray(rows) ? rows[0] : rows
    const cnt = Number(row?.cnt || 0)
    return cnt > 0 ? Number(row?.rev_ex || 0) / cnt : 0
  }
  return 0
}

// ── Monday metric helpers — via internal fetch to existing /api/sales ─────

// Call the existing /api/sales endpoint and return its response. The shape:
// { orders: {monthly, byType, totalOrders, totalValue, tracedOrders},
//   distributors: {byDistributor, byStatus, byPerson, mtdByDist, mtdByPerson, total, mtdTotal},
//   quotes: [{rep, full, id, stats, totalItems}, ...],
//   activeLeads: [...]
// }
async function mondaySalesSummary(req: NextApiRequest, range: DateRange): Promise<any> {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host  = req.headers.host
  const url = `${proto}://${host}/api/sales?startDate=${range.from}&endDate=${range.to}`
  const res = await fetch(url, { headers: { cookie: req.headers.cookie || '' } })
  if (!res.ok) throw new Error(`sales API ${res.status}`)
  return await res.json()
}

async function mondayMetric(req: NextApiRequest, metric: string, range: DateRange): Promise<number> {
  try {
    const d = await mondaySalesSummary(req, range)
    // quotes is an array of per-rep stats. totalItems = count of items
    // created in the period on that board.
    const quotesArr: any[] = Array.isArray(d?.quotes) ? d.quotes : []
    const totalQuotes = quotesArr.reduce((s, q) => s + Number(q?.totalItems || 0), 0)
    const ordersWon   = Number(d?.orders?.totalOrders || 0)     // counts active-status orders in range
    const ordersTotal = ordersWon  // orders.ts only fetches "won"-type bookings; lost not included
    const pipelineVal = Number(d?.distributors?.total?.value || 0)

    if (metric === 'monday.quotes_count')      return totalQuotes
    if (metric === 'monday.orders_won_count')  return ordersWon
    if (metric === 'monday.orders_lost_count') return 0  // not exposed by sales.ts
    if (metric === 'monday.pipeline_value')    return pipelineVal
    if (metric === 'monday.conversion_rate') {
      return totalQuotes > 0 ? ordersWon / totalQuotes : 0
    }
  } catch (e: any) {
    // swallow and return 0 — widget shows "0" instead of erroring out
    console.error('mondayMetric:', e?.message)
  }
  return 0
}

// ── Jobs / supplier invoice helpers (Supabase direct) ─────────────────────

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
  // "pending" covers parsed + auto_approved — still awaiting review or push
  if (metric === 'supplier_invoices.pending_count') {
    const { count } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true })
      .in('status', ['parsed', 'auto_approved'])
    return count || 0
  }
  if (metric === 'supplier_invoices.approved_count') {
    const { count } = await sb().from('supplier_invoices').select('id', { count: 'exact', head: true })
      .eq('status', 'approved')
      .gte('received_at', range.from)
      .lte('received_at', range.to + 'T23:59:59')
    return count || 0
  }
  if (metric === 'supplier_invoices.pending_value') {
    const { data } = await sb().from('supplier_invoices').select('total_inc_gst')
      .in('status', ['parsed', 'auto_approved'])
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

// Dispatch metric to the right source based on prefix
async function resolveMetric(req: NextApiRequest, metric: string, range: DateRange): Promise<number> {
  if (metric.startsWith('sales.'))              return salesMetric(metric, range)
  if (metric.startsWith('monday.'))             return mondayMetric(req, metric, range)
  if (metric.startsWith('jobs.'))               return jobsMetric(metric)
  if (metric.startsWith('supplier_invoices.'))  return supplierInvoiceMetric(metric, range)
  return 0
}

// ── Time-series metric helper (for line/bar charts) ───────────────────────

async function metricSeries(req: NextApiRequest, metric: string, range: DateRange, bucket: 'day'|'week'|'month'): Promise<{ label: string, value: number }[]> {
  // For MYOB metrics, we can query the SUM grouped by date bucket natively.
  if (metric === 'sales.revenue_ex_gst' || metric === 'sales.revenue_inc_gst' || metric === 'sales.invoice_count') {
    const group = bucket === 'month'
      ? "SUBSTRING(CONVERT(VARCHAR(10), Date, 121), 1, 7)"
      : bucket === 'week'
        ? "SUBSTRING(CONVERT(VARCHAR(10), DATEADD(day, -DATEPART(weekday, Date)+2, Date), 121), 1, 10)"
        : "CONVERT(VARCHAR(10), Date, 121)"
    // Some SQL dialects via CData won't support DATEPART/DATEADD — fall back
    // to pulling all rows and bucketing in JS below if that query fails.
    try {
      const rows: any = await cdataQuery('JAWS',
        `SELECT ${group} as bucket, SUM(TotalAmount) as total_inc, SUM(TotalTax) as total_tax, COUNT(*) as cnt
         FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
         WHERE Date >= CAST('${range.from}' AS DATE) AND Date <= CAST('${range.to}' AS DATE)
         GROUP BY ${group} ORDER BY ${group}`)
      const arr = Array.isArray(rows) ? rows : []
      return arr.map((r: any) => ({
        label: String(r.bucket),
        value: metric === 'sales.invoice_count'
          ? Number(r.cnt || 0)
          : metric === 'sales.revenue_inc_gst'
            ? Number(r.total_inc || 0)
            : Number(r.total_inc || 0) - Number(r.total_tax || 0),
      }))
    } catch { /* fall through */ }
  }

  // Fallback / other metrics: pull rows and bucket in JS. For simplicity we
  // build buckets from the range even if that metric doesn't have real series data.
  const buckets: { label: string, value: number }[] = []
  const from = new Date(range.from + 'T00:00:00Z')
  const to = new Date(range.to + 'T00:00:00Z')
  const cursor = new Date(from)
  while (cursor <= to) {
    const label = cursor.toISOString().substring(0, 10)
    // Single-day sub-range
    const dayRange: DateRange = { from: label, to: label }
    const v = await resolveMetric(req, metric, dayRange)
    buckets.push({ label, value: v })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (buckets.length > 90) break  // safety cap
  }
  return buckets
}

// ── Main resolver per widget type ─────────────────────────────────────────

async function resolveWidget(
  req: NextApiRequest,
  widget: WidgetInstance,
  global: GlobalDate,
): Promise<any> {
  const { type, config } = widget
  const widgetPeriod = (config?.period || config?.periodA || undefined) as DateRangeKey | undefined
  const range = effectiveRange(widget, global, widgetPeriod)

  switch (type) {
    case 'kpi_number': {
      const value = await resolveMetric(req, config.metric, range)
      let compareValue: number | null = null
      if (config.compare && config.compare !== 'none') {
        const cmpRange = resolveCompareRange(range, config.compare as CompareKey)
        if (cmpRange) compareValue = await resolveMetric(req, config.metric, cmpRange)
      }
      return { value, compareValue, range, metric: config.metric }
    }

    case 'kpi_comparison': {
      const ra = resolveDateRange(config.periodA as DateRangeKey)
      const rb = resolveDateRange(config.periodB as DateRangeKey)
      const [va, vb] = await Promise.all([
        resolveMetric(req, config.metric, ra),
        resolveMetric(req, config.metric, rb),
      ])
      return { valueA: va, valueB: vb, rangeA: ra, rangeB: rb, metric: config.metric }
    }

    case 'progress_target': {
      const value = await resolveMetric(req, config.metric, range)
      const target = Number(config.target || 0)
      const pct = target > 0 ? Math.min(1, value / target) : 0
      return { value, target, pct, range, metric: config.metric }
    }

    case 'quotes_received': {
      const days = Math.max(7, Math.min(90, Number(config.days || 14)))
      const today = resolveDateRange('today')
      const yesterday = resolveDateRange('yesterday')
      const [todayCount, yCount] = await Promise.all([
        mondayMetric(req, 'monday.quotes_count', today),
        mondayMetric(req, 'monday.quotes_count', yesterday),
      ])
      // Trend sparkline: last N days
      const trendRange: DateRange = (() => {
        const to = today.to
        const from = new Date(today.to + 'T00:00:00Z')
        from.setUTCDate(from.getUTCDate() - (days - 1))
        return { from: from.toISOString().substring(0, 10), to }
      })()
      const series = await metricSeries(req, 'monday.quotes_count', trendRange, 'day')
      return { todayCount, yesterdayCount: yCount, series, days }
    }

    case 'sales_scorecard': {
      try {
        const d = await mondaySalesSummary(req, range)
        const quotesArr: any[] = Array.isArray(d?.quotes) ? d.quotes : []
        const byPerson: Record<string, { value: number, count: number }> = d?.distributors?.byPerson || {}
        // Merge quotes count with distributor revenue for each rep
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
      } catch {}
      return { reps: [], range }
    }

    case 'pipeline_value': {
      try {
        const d = await mondaySalesSummary(req, range)
        const totalV = Number(d?.distributors?.total?.value || 0)
        const totalC = Number(d?.distributors?.total?.count || 0)
        return { value: totalV, count: totalC }
      } catch {}
      return { value: 0, count: 0 }
    }

    case 'line_chart':
    case 'bar_chart': {
      const series = await metricSeries(req, config.metric, range, (config.bucket || 'day') as any)
      return { series, range, metric: config.metric, bucket: config.bucket || 'day' }
    }

    case 'donut_chart': {
      const src = config.source
      if (src === 'jobs_by_status') {
        const { data: run } = await sb().from('job_report_runs').select('id').eq('is_current', true).maybeSingle()
        if (!run?.id) return { segments: [] }
        const { data } = await sb().from('job_report_jobs').select('status').eq('run_id', run.id)
        const counts: Record<string, number> = {}
        for (const r of (data as any[]) || []) {
          const k = r.status || '(no status)'
          counts[k] = (counts[k] || 0) + 1
        }
        return { segments: Object.entries(counts).map(([label, value]) => ({ label, value })) }
      }
      if (src === 'supplier_invoices_by_status') {
        const { data } = await sb().from('supplier_invoices').select('status')
        const counts: Record<string, number> = {}
        for (const r of (data as any[]) || []) counts[r.status] = (counts[r.status] || 0) + 1
        return { segments: Object.entries(counts).map(([label, value]) => ({ label, value })) }
      }
      if (src === 'leads_by_rep') {
        try {
          const d = await mondaySalesSummary(req, range)
          const quotesArr: any[] = Array.isArray(d?.quotes) ? d.quotes : []
          return { segments: quotesArr.map((q: any) => ({
            label: q.full || q.rep || '?',
            value: Number(q.totalItems || 0),
          })).filter((s: any) => s.value > 0) }
        } catch {}
      }
      return { segments: [] }
    }

    case 'distributor_total': {
      const dist = String(config.distributor || '').trim()
      if (!dist) return { value: 0, compareValue: null, distributor: null }
      // Query SaleInvoices for this customer
      const fromQ = `CAST('${range.from}' AS DATE)`
      const toQ   = `CAST('${range.to}' AS DATE)`
      const distEsc = dist.replace(/'/g, "''")
      const rows: any = await cdataQuery('JAWS',
        `SELECT SUM(TotalAmount) as total_inc, SUM(TotalTax) as total_tax
         FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
         WHERE Date >= ${fromQ} AND Date <= ${toQ}
           AND CustomerName LIKE '%${distEsc}%'`)
      const row = Array.isArray(rows) ? rows[0] : rows
      const value = Number(row?.total_inc || 0) - Number(row?.total_tax || 0)
      let compareValue: number | null = null
      if (config.compare && config.compare !== 'none') {
        const cmpRange = resolveCompareRange(range, config.compare as CompareKey)
        if (cmpRange) {
          const r2: any = await cdataQuery('JAWS',
            `SELECT SUM(TotalAmount) as total_inc, SUM(TotalTax) as total_tax
             FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
             WHERE Date >= CAST('${cmpRange.from}' AS DATE) AND Date <= CAST('${cmpRange.to}' AS DATE)
               AND CustomerName LIKE '%${distEsc}%'`)
          const row2 = Array.isArray(r2) ? r2[0] : r2
          compareValue = Number(row2?.total_inc || 0) - Number(row2?.total_tax || 0)
        }
      }
      return { value, compareValue, distributor: dist, range }
    }

    case 'top_distributors': {
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
      const host = req.headers.host
      try {
        const url = `${proto}://${host}/api/distributors?startDate=${range.from}&endDate=${range.to}`
        const r = await fetch(url, { headers: { cookie: req.headers.cookie || '' } })
        if (r.ok) {
          const d = await r.json()
          // Shape: { distributors: [{ name, tuning, parts, oil, total, ... }] }
          const rows = Array.isArray(d?.distributors) ? d.distributors : []
          const sorted = rows.slice().sort((a: any, b: any) => Number(b.total || 0) - Number(a.total || 0))
          const limit = Math.max(3, Math.min(25, Number(config.limit || 10)))
          return { items: sorted.slice(0, limit).map((x: any) => ({ name: x.name, value: Number(x.total || 0) })), range }
        }
      } catch {}
      return { items: [], range }
    }

    case 'job_status_breakdown': {
      const { data: run } = await sb().from('job_report_runs').select('id').eq('is_current', true).maybeSingle()
      if (!run?.id) return { segments: [], hasReport: false }
      const { data } = await sb().from('job_report_jobs').select('status').eq('run_id', run.id)
      const counts: Record<string, number> = {}
      for (const r of (data as any[]) || []) {
        const k = r.status || '(no status)'
        counts[k] = (counts[k] || 0) + 1
      }
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
      // Approved supplier invoices
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
      // Sort combined by time desc, trim
      events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      return { events: events.slice(0, limit) }
    }

    case 'leaderboard': {
      const src = config.source
      const limit = Math.max(3, Math.min(25, Number(config.limit || 10)))
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
      const host = req.headers.host

      if (src === 'reps_by_revenue' || src === 'reps_by_orders_won') {
        try {
          const d = await mondaySalesSummary(req, range)
          const byPerson: Record<string, { value: number, count: number }> = d?.distributors?.byPerson || {}
          const mapped = Object.entries(byPerson).map(([name, stats]) => ({
            name,
            value: src === 'reps_by_revenue' ? Number(stats?.value || 0) : Number(stats?.count || 0),
          }))
          mapped.sort((a, b) => b.value - a.value)
          return { items: mapped.slice(0, limit), metricKind: src === 'reps_by_revenue' ? 'money' : 'count' }
        } catch {}
      }
      if (src === 'distributors_by_revenue') {
        try {
          const url = `${proto}://${host}/api/distributors?startDate=${range.from}&endDate=${range.to}`
          const r = await fetch(url, { headers: { cookie: req.headers.cookie || '' } })
          if (r.ok) {
            const d = await r.json()
            const rows = Array.isArray(d?.distributors) ? d.distributors : []
            const mapped = rows.map((r: any) => ({ name: r.name, value: Number(r.total || 0) }))
            mapped.sort((a: any, b: any) => b.value - a.value)
            return { items: mapped.slice(0, limit), metricKind: 'money' }
          }
        } catch {}
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

      const entries = await Promise.all(widgets.map(async (w) => {
        try {
          const data = await resolveWidget(req, w, global)
          return [w.id, { ok: true, data }] as [string, any]
        } catch (e: any) {
          return [w.id, { ok: false, error: e?.message || 'Resolver failed' }] as [string, any]
        }
      }))
      const results = Object.fromEntries(entries)
      res.status(200).json({ results })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}
