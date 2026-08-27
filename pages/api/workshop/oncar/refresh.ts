// pages/api/workshop/oncar/refresh.ts
// POST { lookback_days? } — triggers the "parts on cars" worker (GitHub Action)
// to re-sweep MechanicDesk.
//
// Same pattern as the Pre Pick refresh: create the md_oncar_runs row HERE
// (status 'pending') before dispatching and hand its id to the worker, so the
// newest run is 'pending' the instant the button is pressed and the screen can
// show a spinner rather than briefly re-showing the previous snapshot while the
// Action (~60-90s) spins up. Gated edit:stocktakes — this is a stocktake tool.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export default withAuth('edit:stocktakes', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const lookbackRaw = Number(body.lookback_days)
  const lookback = isFinite(lookbackRaw) && lookbackRaw > 0 ? Math.min(Math.round(lookbackRaw), 1000) : 365

  const ghToken = process.env.GH_DISPATCH_TOKEN
  const ghOwner = process.env.GH_REPO_OWNER || 'ChrisJustAutos'
  const ghRepo = process.env.GH_REPO_NAME || 'JA-Portal'
  if (!ghToken) return res.status(500).json({ error: 'Server not configured: GH_DISPATCH_TOKEN missing' })

  const requestedBy = user.displayName || user.email || user.id
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: run, error: insErr } = await db.from('md_oncar_runs')
    .insert({ status: 'pending', requested_by: String(requestedBy).slice(0, 120) })
    .select('id').single()
  if (insErr) return res.status(500).json({ error: `Could not create run: ${insErr.message}` })
  const runId = run.id

  const dispatchRes = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'oncar-pull',
      client_payload: { lookback_days: lookback, requested_by: requestedBy, run_id: runId },
    }),
  })
  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => '')
    await db.from('md_oncar_runs')
      .update({ status: 'error', error: `Dispatch failed: ${dispatchRes.status}`, completed_at: new Date().toISOString() })
      .eq('id', runId)
    return res.status(502).json({ error: `Failed to trigger refresh: ${dispatchRes.status} ${errText.slice(0, 300)}` })
  }
  return res.status(202).json({ ok: true, run_id: runId, message: 'Checking MechanicDesk — this takes a couple of minutes.' })
})
