// pages/api/reports/generate.ts
// POST — Given a ReportConfig, fetches data for each section in parallel
// and returns a GeneratedReport (all data + AI narrative).

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { roleCanGenerateReportType, REPORT_TYPE_LABELS } from '../../../lib/permissions'
import type { ReportConfig, GeneratedReport, GeneratedSection, SectionId } from '../../../lib/reports/spec'
import { SECTION_META, DEFAULT_SECTIONS } from '../../../lib/reports/spec'
import {
  fetchKpiSummary, fetchPnlSummary, fetchTopCustomers,
  fetchReceivablesAging, fetchPayablesAging,
  fetchStockSummary, fetchStockReorder, fetchStockDead,
  fetchDistributorRanking, fetchPipeline, fetchTrendCharts,
  fetchSalesFunnel, fetchSalesRepScorecard, fetchSalesPipelineCombined,
} from '../../../lib/reports/fetchers'
import { fetchMondaySalesData, type MondaySalesData } from '../../../lib/reports/monday-fetcher'
import { generateSectionInsights, generateOverallNarrative } from '../../../lib/reports/narrative'

export const config = { maxDuration: 300 }

// Which sections need Monday.com data
const MONDAY_DEPENDENT: SectionId[] = ['sales-pipeline-combined', 'sales-funnel', 'sales-rep-scorecard']

// Resolve the effective date range for a section — use sectionOverrides if set
function resolveRange(cfg: ReportConfig, sid: SectionId) {
  const override = cfg.sectionOverrides?.[sid]
  if (override && override.periodStart && override.periodEnd) {
    return { periodStart: override.periodStart, periodEnd: override.periodEnd }
  }
  return { periodStart: cfg.periodStart, periodEnd: cfg.periodEnd }
}

interface SharedContext {
  monday: MondaySalesData | null
  myobPipeline: any   // PipelineData from fetchers
}

async function fetchSectionData(
  cfg: ReportConfig,
  sid: SectionId,
  shared: SharedContext,
): Promise<any> {
  const meta = SECTION_META[sid]
  const entities = meta.entityScope === 'jaws'
    ? (['JAWS'] as const)
    : meta.entityScope === 'vps' ? (['VPS'] as const)
    : cfg.entities
  const range = resolveRange(cfg, sid)

  switch (sid) {
    case 'kpi-summary':          return await fetchKpiSummary([...entities], range)
    case 'pnl-summary':          return await fetchPnlSummary([...entities], range)
    case 'top-customers':        return await fetchTopCustomers([...entities], range, 10)
    case 'receivables-aging':    return await fetchReceivablesAging([...entities])
    case 'payables-aging':       return await fetchPayablesAging([...entities])
    case 'stock-summary':        return await fetchStockSummary()
    case 'stock-reorder':        return await fetchStockReorder()
    case 'stock-dead':           return await fetchStockDead()
    case 'distributor-ranking':  return await fetchDistributorRanking(range)
    case 'pipeline':             return await fetchPipeline()
    case 'trend-charts':         return await fetchTrendCharts([...entities])
    case 'sales-pipeline-combined': return fetchSalesPipelineCombined(shared.monday, shared.myobPipeline)
    case 'sales-funnel':         return await fetchSalesFunnel(shared.monday, shared.myobPipeline, range)
    case 'sales-rep-scorecard':  return fetchSalesRepScorecard(shared.monday)
    case 'ai-narrative':         return {} // narrative is injected at the report level
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const cfg = req.body as ReportConfig
  if (!cfg?.type) return res.status(400).json({ error: 'type is required' })
  if (!cfg?.periodStart || !cfg?.periodEnd) return res.status(400).json({ error: 'periodStart and periodEnd required' })

  // ACL check — user's role must allow this report type
  if (!roleCanGenerateReportType(user.role, cfg.type)) {
    return res.status(403).json({ error: `Your role (${user.role}) cannot generate ${REPORT_TYPE_LABELS[cfg.type]}` })
  }

  // Defaults
  const entities = (cfg.entities && cfg.entities.length > 0) ? cfg.entities : ['JAWS', 'VPS']
  const requestedSections = (cfg.sections && cfg.sections.length > 0) ? cfg.sections : DEFAULT_SECTIONS[cfg.type]
  const effectiveConfig: ReportConfig = {
    ...cfg,
    entities: entities as ('JAWS' | 'VPS')[],
    sections: requestedSections,
  }

  // ── Shared context pre-fetch ─────────────────────────────────────
  // If any section needs Monday data, fetch it once up-front and reuse.
  // Same for MYOB pipeline — the combined sections reuse it.
  const needsMonday = requestedSections.some(s => MONDAY_DEPENDENT.includes(s))
  const needsMyobPipeline = requestedSections.some(s =>
    s === 'pipeline' || s === 'sales-pipeline-combined' || s === 'sales-funnel'
  )

  const [shared_monday, shared_myobPipeline] = await Promise.all([
    needsMonday ? fetchMondaySalesData(req, cfg.periodStart, cfg.periodEnd).catch(() => null) : Promise.resolve(null),
    needsMyobPipeline ? fetchPipeline().catch(() => null) : Promise.resolve(null),
  ])
  const shared: SharedContext = { monday: shared_monday, myobPipeline: shared_myobPipeline }

  // Fetch all data sections in parallel. If one fails, others still succeed.
  const dataSections = requestedSections.filter(s => s !== 'ai-narrative')
  const sectionResults: GeneratedSection[] = await Promise.all(
    dataSections.map(async (sid): Promise<GeneratedSection> => {
      const meta = SECTION_META[sid]
      try {
        // Reuse pre-fetched pipeline for the bare `pipeline` section too,
        // to avoid double-fetching when both `pipeline` and a sales-* section are in the report.
        if (sid === 'pipeline' && shared.myobPipeline) {
          return { id: sid, label: meta.label, data: shared.myobPipeline }
        }
        const data = await fetchSectionData(effectiveConfig, sid, shared)
        return { id: sid, label: meta.label, data }
      } catch (err: any) {
        console.error(`Section ${sid} failed:`, err.message)
        return { id: sid, label: meta.label, data: { error: err.message || 'Fetch failed' } }
      }
    })
  )

  // Generate per-section insight bullets in parallel (only for sections with real data)
  await Promise.all(sectionResults.map(async (s) => {
    if (!s.data || s.data.error) return
    // Skip bullets for trend-charts (hard to describe in prose) and stock-summary (too trivial)
    if (s.id === 'trend-charts') return
    try {
      const beats = await generateSectionInsights(s.label, s.data)
      if (beats.length > 0) s.narrativeBeats = beats
    } catch { /* silent — bullets are optional */ }
  }))

  // Overall narrative (only if 'ai-narrative' was requested)
  let overallNarrative: string | undefined
  if (requestedSections.includes('ai-narrative')) {
    try {
      overallNarrative = await generateOverallNarrative(effectiveConfig, sectionResults)
    } catch (err: any) {
      console.error('Overall narrative failed:', err.message)
    }
  }

  const report: GeneratedReport = {
    type: cfg.type,
    title: cfg.title?.trim() || REPORT_TYPE_LABELS[cfg.type],
    periodStart: cfg.periodStart,
    periodEnd: cfg.periodEnd,
    entities: entities as ('JAWS' | 'VPS')[],
    generatedAt: new Date().toISOString(),
    sections: sectionResults,
    narrative: overallNarrative,
    amountsAreExGst: true,
  }

  return res.status(200).json(report)
}

export default withAuth('generate:reports', handler)
