// pages/api/workshop/map/index.ts
// Read API for the Workshop Map & Conversion dashboard (Reports → Map).
// GET /api/workshop/map[?fy=2026] → the prebuilt per-FY payload the daily MD
// worker cached (md_workshop_map_cache), plus available FYs + last-sync info.
// All filtering (month / vehicle) happens client-side — this is one SELECT.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: fyRows, error: fyErr } = await db.from('md_workshop_map_cache')
    .select('fy, synced_at').order('fy', { ascending: false })
  if (fyErr) return res.status(500).json({ error: fyErr.message })
  const fys = (fyRows || []).map(r => r.fy)
  if (!fys.length) {
    return res.status(200).json({ fy: null, fys: [], payload: null, synced_at: null, last_run: await lastRun(db) })
  }

  const wanted = Number(req.query.fy)
  const fy = fys.includes(wanted) ? wanted : fys[0]

  const { data: cache, error } = await db.from('md_workshop_map_cache')
    .select('fy, payload, synced_at').eq('fy', fy).single()
  if (error) return res.status(500).json({ error: error.message })

  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json({
    fy: cache.fy,
    fys,
    payload: cache.payload,
    synced_at: cache.synced_at,
    last_run: await lastRun(db),
  })
})

async function lastRun(db: SupabaseClient) {
  const { data } = await db.from('md_workshop_map_runs')
    .select('id, status, started_at, completed_at, error, invoice_count, quote_count')
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  return data || null
}
