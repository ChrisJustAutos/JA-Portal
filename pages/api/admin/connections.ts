// pages/api/admin/connections.ts
// Reads the integration_health table and returns the current status of every
// known integration. Powers /admin/connections page.
//
// GET /api/admin/connections
//   → { connections: [...], updated_at: ISO string, summary: { green, yellow, red, unknown } }
//
// Admin-only — Morgan and Matt have admin role for the away period.
//
// The cron worker (separate, written next) updates the rows. This endpoint
// is read-only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '../../../lib/auth'
import { SNAPSHOT_ID, MONITOR_HEALTH_WARN_MS, MONITOR_HEALTH_DOWN_MS } from '../../../lib/live-calls'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface IntegrationRow {
  name: string
  display_name: string
  category: string
  status: 'green' | 'yellow' | 'red' | 'unknown'
  last_check_at: string | null
  last_success_at: string | null
  last_error: string | null
  metadata: Record<string, any> | null
  fix_url: string | null
  runbook_section: string | null
  check_interval_min: number
  updated_at: string
}

// Derive the AMI monitor's health from the freshness of the snapshot it
// writes. Yellow if the last flush was > 60s ago, red if > 5min, unknown if it
// has never reported.
function buildAmiMonitorRow(snap: { calls: any; updated_at: string } | null): IntegrationRow {
  const nowIso = new Date().toISOString()
  const updatedAt = snap?.updated_at ?? null
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null
  const channels = Array.isArray(snap?.calls) ? snap!.calls.length : 0

  let status: IntegrationRow['status']
  let last_error: string | null = null
  if (!snap || ageMs == null || !isFinite(ageMs)) {
    status = 'unknown'
    last_error = 'No snapshot reported yet'
  } else if (ageMs > MONITOR_HEALTH_DOWN_MS) {
    status = 'red'
    last_error = `No snapshot for ${Math.round(ageMs / 1000)}s — monitor likely offline`
  } else if (ageMs > MONITOR_HEALTH_WARN_MS) {
    status = 'yellow'
    last_error = `Last snapshot ${Math.round(ageMs / 1000)}s ago`
  } else {
    status = 'green'
  }

  return {
    name: 'ami-monitor',
    display_name: 'Live Call Monitor (AMI)',
    category: 'phone',
    status,
    last_check_at: updatedAt,
    last_success_at: status === 'green' ? updatedAt : null,
    last_error,
    metadata: { host_id: SNAPSHOT_ID, active_channels: channels },
    fix_url: null,
    runbook_section: null,
    check_interval_min: 0,
    updated_at: updatedAt ?? nowIso,
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }

    const { data, error } = await sb()
      .from('integration_health')
      .select('*')
      .order('category', { ascending: true })
      .order('display_name', { ascending: true })

    if (error) {
      res.status(500).json({ error: 'Failed to read integration health: ' + error.message })
      return
    }

    const rows = (data || []) as IntegrationRow[]

    // Computed row for the on-PBX AMI monitor. We can't reach the agent's
    // /healthz from Vercel (Tailscale), so liveness is derived from how fresh
    // the snapshot it writes to live_call_snapshot is. Done on the fly here so
    // it never depends on the connections cron actually running.
    try {
      const { data: snap } = await sb()
        .from('live_call_snapshot')
        .select('calls, updated_at')
        .eq('id', SNAPSHOT_ID)
        .maybeSingle()
      rows.push(buildAmiMonitorRow(snap as { calls: any; updated_at: string } | null))
    } catch {
      // Non-fatal — fall through with whatever integration_health returned.
    }

    // Tally per status — UI shows a header summary like "18 green / 2 yellow / 1 red / 1 unknown"
    const summary = {
      green: 0,
      yellow: 0,
      red: 0,
      unknown: 0,
    }
    for (const r of rows) {
      if (r.status in summary) (summary as any)[r.status]++
    }

    // Group by category for the UI to render section-by-section
    const byCategory: Record<string, IntegrationRow[]> = {}
    for (const r of rows) {
      if (!byCategory[r.category]) byCategory[r.category] = []
      byCategory[r.category].push(r)
    }

    // Find the most-stale check across the table — useful banner: "Cron last ran X ago"
    let mostRecentCheck: string | null = null
    for (const r of rows) {
      if (r.last_check_at && (!mostRecentCheck || r.last_check_at > mostRecentCheck)) {
        mostRecentCheck = r.last_check_at
      }
    }

    res.status(200).json({
      connections: rows,
      byCategory,
      summary,
      mostRecentCheck,
      generated_at: new Date().toISOString(),
    })
  })
}
