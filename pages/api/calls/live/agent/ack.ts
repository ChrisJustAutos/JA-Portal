// pages/api/calls/live/agent/ack.ts
// POST — the on-PBX agent reports the outcome of a claimed spy request.
// Body: { id, ok, error? }. ok -> 'connected', else 'failed' (error e.g.
// "not_registered"). Auth: X-Service-Token with the calls:monitor scope.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../../lib/service-auth'
import { MONITOR_SCOPE } from '../../../../../lib/live-calls'

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

  const id = String(body.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const ok = body.ok === true || body.ok === 'true'
  const errMsg = body.error ? String(body.error).slice(0, 300) : null

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { error } = await sb.from('call_monitor_events')
    .update({ status: ok ? 'connected' : 'failed', error: ok ? null : errMsg, completed_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['claimed', 'pending'])
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true })
}
