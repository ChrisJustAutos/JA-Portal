// pages/api/calls/live/agent/snapshot.ts
// POST — the on-PBX agent pushes the current active-call list here (~every 2s).
// Auth: X-Service-Token with the calls:monitor scope (the agent's existing
// JA_PORTAL_API_KEY token must carry that scope).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../../lib/service-auth'
import { MONITOR_SCOPE, SNAPSHOT_ID } from '../../../../../lib/live-calls'

export const config = { maxDuration: 10 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const svc = await validateServiceToken(req, MONITOR_SCOPE)
  if (!svc) return res.status(401).json({ error: 'Invalid or missing X-Service-Token (scope calls:monitor)' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const calls = Array.isArray(body.calls) ? body.calls.slice(0, 200) : []

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { error } = await sb.from('live_call_snapshot').upsert({
    id: SNAPSHOT_ID,
    calls,
    updated_at: new Date().toISOString(),
  })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true, count: calls.length })
}
