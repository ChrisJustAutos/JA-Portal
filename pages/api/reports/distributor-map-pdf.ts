// pages/api/reports/distributor-map-pdf.ts
// GET ?fy=2026&radius=100 → the Distributor Map report as a PDF download.
//
// Recomputes through the same lib/distributor-map.ts the screen and the weekly
// sales recap use, so there is one definition of "quotes in this area" — this
// route is auth + params + render, no logic of its own.
//
// Deliberately NOT month-filtered: the screen already shows a month at a time,
// and the point of the export is the whole year month by month. The radius does
// carry through, because it changes which quotes belong to whom.
//
// Sibling of distributor-map.ts rather than a nested route, so the read API
// stays a plain file and Next never has to choose between a file and a folder
// of the same name.
//
// Same gate as the read API: view:reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { computeDistributorMap } from '../../../lib/distributor-map'
import { renderDistributorMapPdf, distributorMapPdfFilename } from '../../../lib/distributor-map-pdf'

// Monday paging plus the geo join — the read API allows 60s, and rendering
// adds a little on top.
export const config = { maxDuration: 120 }

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
    if (!result) return res.status(404).json({ error: 'No workshop-map data yet — the daily MechanicDesk pull has not run.' })

    const data = {
      fy: result.fy,
      radiusKm: result.radiusKm,
      months: result.months,
      entities: result.entities,
      quotesSyncedAt: result.quotesSyncedAt,
    }
    const buffer = await renderDistributorMapPdf(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${distributorMapPdfFilename(data)}"`)
    res.setHeader('Content-Length', String(buffer.length))
    return res.status(200).send(buffer)
  } catch (e: any) {
    console.error('[distributor-map-pdf] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
})
