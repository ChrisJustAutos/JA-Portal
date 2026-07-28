// pages/api/reports/distributor-map.ts
// Read API for the Distributor Map report (Reports → Distributor Map).
// All the logic lives in lib/distributor-map.ts (shared with the weekly
// sales recap's Distributor Areas section) — this is auth + params + shape.
//
// GET ?fy=2026&radius=100 · auth view:reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { computeDistributorMap } from '../../../lib/distributor-map'

export const config = { maxDuration: 60 }

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  try {
    const result = await computeDistributorMap(db, token, {
      fy: Number(req.query.fy) || undefined,
      radiusKm: Number(req.query.radius) || undefined,
    })
    if (!result) return res.status(200).json({ fy: null, fys: [], distributors: [], quotePoints: [], months: [] })

    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).json({
      fy: result.fy, fys: result.fys, radiusKm: result.radiusKm, months: result.months,
      distributors: result.entities,
      quotePoints: result.points,
      quotesSyncedAt: result.quotesSyncedAt,
      bookingsAsOf: new Date().toISOString(),
    })
  } catch (e: any) {
    console.error('[distributor-map] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
})
