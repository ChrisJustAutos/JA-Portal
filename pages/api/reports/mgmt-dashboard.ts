// pages/api/reports/mgmt-dashboard.ts
// Management Dashboard report (JAWS entity) — live rebuild of the
// JAWS_Management_Dashboard Excel workbook. All computation lives in
// lib/mgmt-dashboard (chart configs seeded by migration 184); this is
// auth + params + the config editor.
//
// GET  ?refresh=1                     → full payload { generatedAt, kpis,
//        charts, kpiHistory, config } (expensive MYOB pulls served from the
//        nightly-warmed cache unless refresh is forced)
// PATCH { chart_key, patch: { enabled?, title?, chart_type?, config? } }
//        → merge-update one mgmt_dashboard_charts row (config is shallow-
//        merged over the existing config) and return the updated row.
//
// Auth: view:reports AND role admin|manager (financials — cash, GP, margins).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { computeMgmtDashboard } from '../../../lib/mgmt-dashboard'

export const config = { maxDuration: 300 }

const CHART_TYPES = ['bars', 'stackedBars', 'pie', 'hbar', 'kpis']

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (user.role !== 'admin' && user.role !== 'manager') {
    return res.status(403).json({ error: 'Forbidden — Management Dashboard is admin/manager only', role: user.role })
  }
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  if (req.method === 'GET') {
    try {
      const payload = await computeMgmtDashboard(db, { refresh: req.query.refresh === '1' })
      res.setHeader('Cache-Control', 'private, no-store')
      return res.status(200).json(payload)
    } catch (e: any) {
      console.error('[mgmt-dashboard] failed:', e?.message || e)
      return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
    }
  }

  if (req.method === 'PATCH') {
    const { chart_key: chartKey, patch } = (req.body || {}) as { chart_key?: string; patch?: any }
    if (!chartKey || typeof chartKey !== 'string') return res.status(400).json({ error: 'chart_key required' })
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'patch object required' })

    const { data: existing, error: loadErr } = await db
      .from('mgmt_dashboard_charts')
      .select('key, title, chart_type, position, enabled, config')
      .eq('key', chartKey)
      .maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })
    if (!existing) return res.status(404).json({ error: `Unknown chart '${chartKey}'` })

    const update: Record<string, any> = { updated_at: new Date().toISOString() }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') return res.status(400).json({ error: 'patch.enabled must be boolean' })
      update.enabled = patch.enabled
    }
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || !patch.title.trim()) return res.status(400).json({ error: 'patch.title must be a non-empty string' })
      update.title = patch.title.trim()
    }
    if (patch.chart_type !== undefined) {
      if (typeof patch.chart_type !== 'string' || CHART_TYPES.indexOf(patch.chart_type) < 0) {
        return res.status(400).json({ error: `patch.chart_type must be one of ${CHART_TYPES.join(', ')}` })
      }
      update.chart_type = patch.chart_type
    }
    if (patch.config !== undefined) {
      if (typeof patch.config !== 'object' || patch.config === null || Array.isArray(patch.config)) {
        return res.status(400).json({ error: 'patch.config must be an object' })
      }
      // Merge-update: patched keys replace, everything else survives. The
      // computation kind is pinned to the row — a config edit can't silently
      // repoint a chart at a different algorithm.
      update.config = { ...(existing.config || {}), ...patch.config, kind: (existing.config || {}).kind }
    }
    if (Object.keys(update).length === 1) return res.status(400).json({ error: 'patch is empty — nothing to update' })

    const { data: updated, error: updErr } = await db
      .from('mgmt_dashboard_charts')
      .update(update)
      .eq('key', chartKey)
      .select('key, title, chart_type, position, enabled, config, updated_at')
      .single()
    if (updErr) return res.status(500).json({ error: updErr.message })
    return res.status(200).json({ ok: true, chart: updated })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
