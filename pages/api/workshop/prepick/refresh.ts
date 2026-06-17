// pages/api/workshop/prepick/refresh.ts
// POST { from, to } — triggers the MechanicDesk Pre Pick worker (GitHub Action)
// to pull a fresh snapshot for the date range. The worker creates the
// md_prepick_runs row itself (via /prepick/ingest action:'start') and the page
// polls for it. Mirrors the stocktake refresh trigger. Gated edit:bookings.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'

export default withAuth('edit:bookings', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const from = String(body.from || '').trim()
  const to = String(body.to || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' })
  }

  const ghToken = process.env.GH_DISPATCH_TOKEN
  const ghOwner = process.env.GH_REPO_OWNER || 'ChrisJustAutos'
  const ghRepo = process.env.GH_REPO_NAME || 'JA-Portal'
  if (!ghToken) return res.status(500).json({ error: 'Server not configured: GH_DISPATCH_TOKEN missing' })

  const dispatchRes = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'prepick-pull', client_payload: { from, to, requested_by: user.displayName || user.email || user.id } }),
  })
  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    return res.status(502).json({ error: `Failed to trigger refresh: ${dispatchRes.status} ${errText.slice(0, 300)}` })
  }
  return res.status(202).json({ ok: true, message: 'Pulling from MechanicDesk — the snapshot updates in ~1–2 minutes.' })
})
