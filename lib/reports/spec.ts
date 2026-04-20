// lib/reports/spec.ts
// Types for report configuration. Shared between client and server.

import type { ReportType } from '../permissions'

export type SectionId =
  | 'kpi-summary'
  | 'pnl-summary'
  | 'top-customers'
  | 'receivables-aging'
  | 'payables-aging'
  | 'stock-summary'
  | 'stock-reorder'
  | 'stock-dead'
  | 'distributor-ranking'
  | 'pipeline'
  | 'trend-charts'
  | 'ai-narrative'

export interface SectionMeta {
  id: SectionId
  label: string
  description: string
  // Which entities this section supports (all/jaws/vps)
  entityScope: 'all' | 'jaws' | 'vps'
}

export const SECTION_META: Record<SectionId, SectionMeta> = {
  'kpi-summary':         { id: 'kpi-summary',        label: 'KPI Summary',           description: 'Top-line revenue, margin, receivables, stock value', entityScope: 'all' },
  'pnl-summary':         { id: 'pnl-summary',        label: 'P&L Summary',           description: 'Income, COS, overheads, net profit per entity',      entityScope: 'all' },
  'top-customers':       { id: 'top-customers',      label: 'Top Customers',         description: 'Top 10 customers by revenue (ex-GST)',              entityScope: 'all' },
  'receivables-aging':   { id: 'receivables-aging',  label: 'Receivables Aging',     description: 'Open invoices by age bucket (30/60/90+ days)',      entityScope: 'all' },
  'payables-aging':      { id: 'payables-aging',     label: 'Payables Aging',        description: 'Open supplier bills by age bucket',                  entityScope: 'all' },
  'stock-summary':       { id: 'stock-summary',      label: 'Stock Summary',         description: 'Total stock value, item count, stock turn',         entityScope: 'jaws' },
  'stock-reorder':       { id: 'stock-reorder',      label: 'Reorder Alerts',        description: 'Items below reorder level',                          entityScope: 'jaws' },
  'stock-dead':          { id: 'stock-dead',         label: 'Dead Stock',            description: 'Items with held value but no sales in 90+ days',    entityScope: 'jaws' },
  'distributor-ranking': { id: 'distributor-ranking',label: 'Distributor Ranking',   description: 'Top distributors by revenue with bucket breakdown', entityScope: 'jaws' },
  'pipeline':            { id: 'pipeline',           label: 'Sales Pipeline',        description: 'Open orders, quotes, conversion rate',              entityScope: 'jaws' },
  'trend-charts':        { id: 'trend-charts',       label: '6-Month Trends',        description: 'Income and expense trend for last 6 months',        entityScope: 'all' },
  'ai-narrative':        { id: 'ai-narrative',       label: 'AI Commentary',         description: 'Claude writes narrative commentary on the data',    entityScope: 'all' },
}

// Default section selection for each report type.
// User can override these in the UI before generating.
export const DEFAULT_SECTIONS: Record<ReportType, SectionId[]> = {
  'monthly-management': [
    'kpi-summary', 'pnl-summary', 'top-customers',
    'receivables-aging', 'stock-summary', 'trend-charts', 'ai-narrative',
  ],
  'executive-summary': [
    'kpi-summary', 'trend-charts', 'ai-narrative',
  ],
  'distributor-performance': [
    'distributor-ranking', 'trend-charts', 'ai-narrative',
  ],
  'cash-flow': [
    'receivables-aging', 'payables-aging', 'ai-narrative',
  ],
  'stock-health': [
    'stock-summary', 'stock-reorder', 'stock-dead', 'ai-narrative',
  ],
  'sales-pipeline': [
    'pipeline', 'top-customers', 'ai-narrative',
  ],
}

// ── Runtime config — what the user submits to generate a report ─────

export interface ReportConfig {
  type: ReportType
  periodStart: string           // YYYY-MM-DD
  periodEnd: string             // YYYY-MM-DD
  entities: ('JAWS' | 'VPS')[]  // which companies to include (default: both)
  sections: SectionId[]         // which sections to include (default: DEFAULT_SECTIONS[type])
  // Per-section period override (optional). Keys are SectionId.
  sectionOverrides?: Partial<Record<SectionId, { periodStart: string; periodEnd: string }>>
  title?: string                // optional custom title
}

// ── The response from /api/reports/generate ─────────────────────────

export interface GeneratedSection {
  id: SectionId
  label: string
  data: any                     // section-specific shape
  narrativeBeats?: string[]     // optional AI-generated bullets for this section
}

export interface GeneratedReport {
  type: ReportType
  title: string
  periodStart: string
  periodEnd: string
  entities: ('JAWS' | 'VPS')[]
  generatedAt: string
  sections: GeneratedSection[]
  narrative?: string            // overall AI commentary (from ai-narrative section)
  amountsAreExGst: true
}
