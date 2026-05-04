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
