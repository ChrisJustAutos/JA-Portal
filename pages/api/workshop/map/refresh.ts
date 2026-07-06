// pages/api/workshop/map/refresh.ts
// POST — manually triggers the daily MechanicDesk Workshop Map worker
// (GitHub Action md-workshop-map.yml) outside its schedule. Creates the
// md_workshop_map_runs row first (status 'pending') so the dashboard can show
// a syncing state immediately; the worker's 'start' flips it to 'running'.
// Mirrors the Pre Pick refresh trigger. Full pull takes ~2–4 minutes.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }

  const ghToken = process.env.GH_DISPATCH_TOKEN
  const ghOwner = process.env.GH_REPO_OWNER || 'ChrisJustAutos'
  const ghRepo = process.env.GH_REPO_NAME || 'JA-Portal'
  if (!ghToken) return res.status(500).json({ error: 'Server not configured: GH_DISPATCH_TOKEN missing' })

  const requestedBy = user.displayName || user.email || user.id
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  // Don't stack runs — if one is already pending/running, just report it.
  const { data: active } = await db.from('md_workshop_map_runs')
    .select('id, status, started_at').in('status', ['pending', 'running'])
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  if (active) return res.status(202).json({ ok: true, run_id: active.id, message: 'A sync is already in progress.' })

  const { data: run, error: insErr } = await db.from('md_workshop_map_runs')
    .insert({ status: 'pending', requested_by: String(requestedBy).slice(0, 120) })
    .select('id').single()
  if (insErr) return res.status(500).json({ error: `Could not create run: ${insErr.message}` })

  const dispatchRes = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'workshop-map-pull', client_payload: { requested_by: requestedBy, run_id: run.id } }),
  })
  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    await db.from('md_workshop_map_runs')
      .update({ status: 'error', error: `Dispatch failed: ${dispatchRes.status}`, completed_at: new Date().toISOString() })
      .eq('id', run.id)
    return res.status(502).json({ error: `Failed to trigger refresh: ${dispatchRes.status} ${errText.slice(0, 300)}` })
  }
  return res.status(202).json({ ok: true, run_id: run.id, message: 'Pulling from MechanicDesk — the map updates in ~2–4 minutes.' })
})
