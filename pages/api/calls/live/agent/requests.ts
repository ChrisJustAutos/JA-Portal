// pages/api/calls/live/agent/requests.ts
// GET — the on-PBX agent drains the spy-request queue here. Pending requests
// older than the TTL are expired first; the rest are atomically claimed
// (status -> 'claimed') and returned, so two agent polls never double-ring.
// Auth: X-Service-Token with the calls:monitor scope.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../../lib/service-auth'
import { MONITOR_SCOPE, REQUEST_TTL_MS } from '../../../../../lib/live-calls'

export const config = { maxDuration: 10 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const svc = await validateServiceToken(req, MONITOR_SCOPE)
  if (!svc) return res.status(401).json({ error: 'Invalid or missing X-Service-Token (scope calls:monitor)' })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const now = new Date()

  // Sweep stale pending requests so the phone doesn't ring late.
  await sb.from('call_monitor_events')
    .update({ status: 'expired', completed_at: now.toISOString() })
    .eq('status', 'pending')
    .lt('created_at', new Date(now.getTime() - REQUEST_TTL_MS).toISOString())

  // Claim the remaining pending requests (atomic via UPDATE ... RETURNING).
  const { data, error } = await sb.from('call_monitor_events')
    .update({ status: 'claimed', claimed_at: now.toISOString() })
    .eq('status', 'pending')
    .select('id, actor_extension, target_channel, target_call_linkedid, target_agent_ext, mode')
  if (error) return res.status(500).json({ error: error.message })

  const requests = (data || []).map((r: any) => ({
    id: r.id,
    listener_extension: r.actor_extension,
    target_channel: r.target_channel,
    target_call_linkedid: r.target_call_linkedid,
    target_agent_ext: r.target_agent_ext,
    mode: r.mode,
  }))
  return res.status(200).json({ requests })
}
