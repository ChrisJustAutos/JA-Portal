// pages/api/dashboard/sources.ts
// Provides lookup lists for config pickers — e.g. list of distributors to
// choose from when configuring a distributor_total widget.
//
// GET ?source=distributors → { items: [{ value, label }] }

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.status(405).end(); return }
  return requireAuth(req, res, async () => {
    const source = String(req.query.source || '')
    try {
      if (source === 'distributors') {
        // Reuse /api/distributors — returns distributor list for current FY
        const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
        const host  = req.headers.host
        const r = await fetch(`${proto}://${host}/api/distributors`, {
          headers: { cookie: req.headers.cookie || '' },
        })
        if (!r.ok) throw new Error(`distributors API ${r.status}`)
        const d = await r.json()
        const rows = Array.isArray(d?.distributors) ? d.distributors : []
        const items = rows.map((x: any) => ({ value: x.name, label: x.name }))
          .filter((x: any) => x.value && x.label)
          .sort((a: any, b: any) => a.label.localeCompare(b.label))
        res.status(200).json({ items })
        return
      }
      res.status(400).json({ error: 'Unknown source: ' + source })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}
