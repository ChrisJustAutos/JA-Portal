// pages/api/workshop/prepick/refresh.ts
// POST { from, to } — triggers the MechanicDesk Pre Pick worker (GitHub Action)
// to pull a fresh snapshot for the date range.
//
// We create the md_prepick_runs row HERE (status 'pending') before dispatching,
// then pass its id to the worker as run_id. This makes the newest run 'pending'
// the instant the user clicks — so the page can show a loading state reliably
// instead of briefly seeing the previous 'done' snapshot while the GH Action
// (~60-90s) spins up. The worker's 'start' action flips this same row to
// 'running' (it does NOT create a second row when a run_id is supplied).
// Mirrors the stocktake refresh trigger. Gated edit:bookings.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
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

  const requestedBy = user.displayName || user.email || user.id

  // 1. Create the pending run row so the UI has something to poll immediately.
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: run, error: insErr } = await db.from('md_prepick_runs')
    .insert({ from_date: from, to_date: to, status: 'pending', requested_by: String(requestedBy).slice(0, 120) })
    .select('id').single()
  if (insErr) return res.status(500).json({ error: `Could not create run: ${insErr.message}` })
  const runId = run.id

  // 2. Dispatch the worker, handing it the run id to fill in.
  const dispatchRes = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'prepick-pull', client_payload: { from, to, requested_by: requestedBy, run_id: runId } }),
  })
  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    // Roll the row to error so the UI doesn't spin forever on a failed dispatch.
    await db.from('md_prepick_runs').update({ status: 'error', error: `Dispatch failed: ${dispatchRes.status}`, completed_at: new Date().toISOString() }).eq('id', runId)
    return res.status(502).json({ error: `Failed to trigger refresh: ${dispatchRes.status} ${errText.slice(0, 300)}` })
  }
  return res.status(202).json({ ok: true, run_id: runId, message: 'Pulling from MechanicDesk — the snapshot updates in ~1–2 minutes.' })
})
