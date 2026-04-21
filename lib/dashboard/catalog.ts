// lib/dashboard/catalog.ts
// The widget catalog — single source of truth shared between frontend and API.
// Adding a new widget type means: (1) add a DEF here, (2) add a renderer in
// components/dashboard/widgets/<type>.tsx, (3) add a data resolver in
// pages/api/dashboard/data.ts.

export type DateRangeKey = 'today'|'yesterday'|'this_week'|'this_month'|'this_fy'|'last_7'|'last_30'|'last_90'|'custom'|'all'
export type BucketKey    = 'day'|'week'|'month'
export type CompareKey   = 'none'|'yesterday'|'last_week'|'last_month'|'last_period'

export type FieldType =
  | { kind: 'text', placeholder?: string }
  | { kind: 'select', options: { value: string, label: string }[] }
  | { kind: 'number', min?: number, max?: number, step?: number }
  | { kind: 'date_range' }
  | { kind: 'metric' }                             // picks from METRICS
  | { kind: 'metric_source', sources: string[] }   // e.g. 'distributors'|'reps'
  | { kind: 'compare' }
  | { kind: 'bucket' }
  | { kind: 'markdown' }
  | { kind: 'boolean' }

export interface WidgetField {
  key: string
  label: string
  type: FieldType
  required?: boolean
  helpText?: string
  defaultValue?: any
}

export interface WidgetDef {
  type: string
  label: string
  category: 'metric'|'sales'|'chart'|'distributor'|'ops'|'activity'|'misc'
  description: string
  defaultSize: { w: number, h: number }    // in grid units (12-col grid)
  fields: WidgetField[]
}

// Metrics catalog — what you can aggregate. Each has an id, a label, and
// a kind that the data resolver uses. Adding a new metric here exposes it
// in the config UI automatically.
export const METRICS: { id: string, label: string, group: string, returns: 'money'|'count'|'percentage' }[] = [
  // Sales (MYOB-sourced)
  { id: 'sales.revenue_ex_gst',   label: 'Revenue (ex GST)',         group: 'Sales',      returns: 'money' },
  { id: 'sales.revenue_inc_gst',  label: 'Revenue (inc GST)',        group: 'Sales',      returns: 'money' },
  { id: 'sales.invoice_count',    label: 'Invoice count',            group: 'Sales',      returns: 'count' },
  { id: 'sales.avg_invoice',      label: 'Avg invoice value',        group: 'Sales',      returns: 'money' },

  // Monday-sourced leads/orders/quotes
  { id: 'monday.quotes_count',    label: 'Quotes received',          group: 'Leads',      returns: 'count' },
  { id: 'monday.orders_won_count',label: 'Orders won',               group: 'Leads',      returns: 'count' },
  { id: 'monday.orders_lost_count',label:'Orders lost',              group: 'Leads',      returns: 'count' },
  { id: 'monday.pipeline_value',  label: 'Open pipeline value',      group: 'Leads',      returns: 'money' },
  { id: 'monday.conversion_rate', label: 'Quote → order conversion', group: 'Leads',      returns: 'percentage' },

  // Jobs (Mechanics Desk report)
  { id: 'jobs.total_count',       label: 'Job count (total)',        group: 'Jobs',       returns: 'count' },
  { id: 'jobs.open_count',        label: 'Jobs open',                group: 'Jobs',       returns: 'count' },
  { id: 'jobs.closed_count',      label: 'Jobs closed',              group: 'Jobs',       returns: 'count' },
  { id: 'jobs.forecast_revenue',  label: 'Forecast revenue (open)',  group: 'Jobs',       returns: 'money' },

  // Supplier invoices
  { id: 'supplier_invoices.pending_count',    label: 'Supplier invoices pending',    group: 'Payables', returns: 'count' },
  { id: 'supplier_invoices.approved_count',   label: 'Supplier invoices approved',   group: 'Payables', returns: 'count' },
  { id: 'supplier_invoices.pending_value',    label: 'Supplier invoices pending $',  group: 'Payables', returns: 'money' },
  { id: 'supplier_invoices.match_rate',       label: 'PO match rate',                 group: 'Payables', returns: 'percentage' },
]

export const DATE_RANGE_OPTIONS: { value: DateRangeKey, label: string }[] = [
  { value: 'today',      label: 'Today' },
  { value: 'yesterday',  label: 'Yesterday' },
  { value: 'this_week',  label: 'This week (Mon-Sun)' },
  { value: 'this_month', label: 'This month' },
  { value: 'this_fy',    label: 'This FY (Jul-Jun)' },
  { value: 'last_7',     label: 'Last 7 days' },
  { value: 'last_30',    label: 'Last 30 days' },
  { value: 'last_90',    label: 'Last 90 days' },
  { value: 'all',        label: 'All time' },
  { value: 'custom',     label: 'Custom…' },
]

// Widget definitions. Each type's `fields` drive the config panel UI; the
// `config` object a widget stores is exactly the shape of these fields.
export const WIDGETS: WidgetDef[] = [
  // ── Metric tiles ────────────────────────────────────────────────────────
  {
    type: 'kpi_number',
    label: 'KPI Number',
    category: 'metric',
    description: 'Single number with optional trend vs previous period.',
    defaultSize: { w: 3, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true, defaultValue: 'New KPI' },
      { key: 'metric', label: 'Metric', type: { kind: 'metric' }, required: true, defaultValue: 'sales.revenue_ex_gst' },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'today' },
      { key: 'compare', label: 'Compare to', type: { kind: 'compare' }, defaultValue: 'yesterday' },
    ],
  },
  {
    type: 'kpi_comparison',
    label: 'KPI Comparison (two values)',
    category: 'metric',
    description: 'Two metric values side-by-side (e.g. today vs yesterday).',
    defaultSize: { w: 4, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true },
      { key: 'metric', label: 'Metric', type: { kind: 'metric' }, required: true },
      { key: 'periodA', label: 'Left period', type: { kind: 'date_range' }, required: true, defaultValue: 'today' },
      { key: 'periodB', label: 'Right period', type: { kind: 'date_range' }, required: true, defaultValue: 'yesterday' },
    ],
  },
  {
    type: 'progress_target',
    label: 'Progress to target',
    category: 'metric',
    description: 'Current value vs a target with progress bar.',
    defaultSize: { w: 4, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true },
      { key: 'metric', label: 'Metric', type: { kind: 'metric' }, required: true },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'this_month' },
      { key: 'target', label: 'Target value', type: { kind: 'number', min: 0 }, required: true, defaultValue: 100000 },
    ],
  },

  // ── Sales-specific ──────────────────────────────────────────────────────
  {
    type: 'quotes_received',
    label: 'Quotes received (per day)',
    category: 'sales',
    description: 'Today vs yesterday quote counts with trend sparkline.',
    defaultSize: { w: 4, h: 3 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Quotes received' },
      { key: 'days', label: 'Trend days', type: { kind: 'number', min: 7, max: 90, step: 1 }, defaultValue: 14 },
    ],
  },
  {
    type: 'sales_scorecard',
    label: 'Sales rep scorecard',
    category: 'sales',
    description: 'Leaderboard of sales reps by revenue + quote counts.',
    defaultSize: { w: 6, h: 4 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Sales scorecard' },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'this_month' },
      { key: 'limit', label: 'Top N', type: { kind: 'number', min: 3, max: 20 }, defaultValue: 10 },
    ],
  },
  {
    type: 'pipeline_value',
    label: 'Pipeline value',
    category: 'sales',
    description: 'Sum of open quote/order values, optionally by stage.',
    defaultSize: { w: 4, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Open pipeline' },
    ],
  },

  // ── Charts ─────────────────────────────────────────────────────────────
  {
    type: 'line_chart',
    label: 'Line chart (metric over time)',
    category: 'chart',
    description: 'Any metric plotted over time with daily/weekly/monthly buckets.',
    defaultSize: { w: 6, h: 4 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true },
      { key: 'metric', label: 'Metric', type: { kind: 'metric' }, required: true, defaultValue: 'sales.revenue_ex_gst' },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'last_30' },
      { key: 'bucket', label: 'Bucket', type: { kind: 'bucket' }, required: true, defaultValue: 'day' },
    ],
  },
  {
    type: 'bar_chart',
    label: 'Bar chart (by period)',
    category: 'chart',
    description: 'Metric shown as bars across days/weeks/months.',
    defaultSize: { w: 6, h: 4 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true },
      { key: 'metric', label: 'Metric', type: { kind: 'metric' }, required: true },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'last_7' },
      { key: 'bucket', label: 'Bucket', type: { kind: 'bucket' }, required: true, defaultValue: 'day' },
    ],
  },
  {
    type: 'donut_chart',
    label: 'Donut (category breakdown)',
    category: 'chart',
    description: 'Pie-style breakdown. Good for job statuses, invoice statuses etc.',
    defaultSize: { w: 4, h: 4 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true },
      { key: 'source', label: 'Source',
        type: { kind: 'select', options: [
          { value: 'jobs_by_status',               label: 'Jobs by status' },
          { value: 'jobs_by_type',                 label: 'Jobs by type' },
          { value: 'supplier_invoices_by_status',  label: 'Supplier invoices by status' },
          { value: 'leads_by_rep',                 label: 'Leads by rep' },
        ]},
        required: true, defaultValue: 'jobs_by_status' },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, defaultValue: 'this_month' },
    ],
  },

  // ── Distributor ─────────────────────────────────────────────────────────
  {
    type: 'distributor_total',
    label: 'Distributor total',
    category: 'distributor',
    description: 'Revenue for a single distributor in a period.',
    defaultSize: { w: 3, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' } },
      { key: 'distributor', label: 'Distributor',
        type: { kind: 'metric_source', sources: ['distributors'] },
        required: true, helpText: 'Pick one distributor.' },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'this_month' },
      { key: 'compare', label: 'Compare to', type: { kind: 'compare' }, defaultValue: 'last_month' },
    ],
  },
  {
    type: 'top_distributors',
    label: 'Top distributors',
    category: 'distributor',
    description: 'Leaderboard of top-N distributors by revenue.',
    defaultSize: { w: 4, h: 4 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Top distributors' },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, required: true, defaultValue: 'this_month' },
      { key: 'limit', label: 'Top N', type: { kind: 'number', min: 3, max: 25 }, defaultValue: 10 },
    ],
  },

  // ── Ops / jobs ──────────────────────────────────────────────────────────
  {
    type: 'job_status_breakdown',
    label: 'Job status breakdown',
    category: 'ops',
    description: 'Mechanics Desk job counts by status.',
    defaultSize: { w: 4, h: 3 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Jobs by status' },
    ],
  },
  {
    type: 'supplier_invoice_queue',
    label: 'Supplier invoice queue',
    category: 'ops',
    description: 'Counts by status from the supplier invoice pipeline.',
    defaultSize: { w: 4, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Supplier invoices' },
    ],
  },

  // ── Activity ────────────────────────────────────────────────────────────
  {
    type: 'recent_activity',
    label: 'Recent activity',
    category: 'activity',
    description: 'Feed of recent portal events: orders won, invoices approved, to-dos completed.',
    defaultSize: { w: 4, h: 5 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, defaultValue: 'Recent activity' },
      { key: 'limit', label: 'Items', type: { kind: 'number', min: 5, max: 50 }, defaultValue: 15 },
    ],
  },
  {
    type: 'leaderboard',
    label: 'Generic leaderboard',
    category: 'activity',
    description: 'Configurable top-N list across any data source.',
    defaultSize: { w: 4, h: 4 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' }, required: true, defaultValue: 'Leaderboard' },
      { key: 'source', label: 'Source',
        type: { kind: 'select', options: [
          { value: 'reps_by_revenue',          label: 'Reps by revenue' },
          { value: 'reps_by_orders_won',       label: 'Reps by orders won' },
          { value: 'distributors_by_revenue',  label: 'Distributors by revenue' },
          { value: 'suppliers_by_spend',       label: 'Suppliers by spend (pending + approved invoices)' },
        ]},
        required: true },
      { key: 'period', label: 'Period', type: { kind: 'date_range' }, defaultValue: 'this_month' },
      { key: 'limit', label: 'Top N', type: { kind: 'number', min: 3, max: 25 }, defaultValue: 10 },
    ],
  },

  // ── Misc ───────────────────────────────────────────────────────────────
  {
    type: 'markdown_note',
    label: 'Note (markdown)',
    category: 'misc',
    description: 'Pin a note to your dashboard. Supports basic markdown.',
    defaultSize: { w: 4, h: 2 },
    fields: [
      { key: 'title', label: 'Title', type: { kind: 'text' } },
      { key: 'content', label: 'Content', type: { kind: 'markdown' }, defaultValue: '' },
    ],
  },
]

export function getWidgetDef(type: string): WidgetDef | null {
  return WIDGETS.find(w => w.type === type) || null
}

// Build a default config object for a new widget of a given type
export function defaultConfigFor(type: string): Record<string, any> {
  const def = getWidgetDef(type)
  if (!def) return {}
  const out: Record<string, any> = {}
  for (const f of def.fields) {
    if (f.defaultValue !== undefined) out[f.key] = f.defaultValue
  }
  return out
}
