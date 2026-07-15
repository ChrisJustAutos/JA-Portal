// pages/api/calls/live/spy.ts
// POST — enqueue a live monitor request (listen / whisper / barge) for an
//        in-progress call. The on-PBX agent drains the queue and rings the
//        manager's own extension via ChanSpy. Returns immediately with a
//        request id; the client polls GET ?id= for the outcome.
// GET ?id=<uuid> — status of one of the caller's own requests.
//
// Gated to monitor:calls (admin/manager). Every request is also the audit row.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { SPY_MODES, SpyMode, REQUEST_TTL_MS } from '../../../../lib/live-calls'

export const config = { maxDuration: 10 }

export default withAuth('monitor:calls', async (req, res, user) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  // ── Poll the outcome of one of my own requests ──
  if (req.method === 'GET') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data } = await sb
      .from('call_monitor_events')
      .select('status, error, actor_extension')
      .eq('id', id)
      .eq('actor_user_id', user.id)
      .maybeSingle()
    if (!data) return res.status(404).json({ error: 'not_found' })
    return res.status(200).json({ status: data.status, error: data.error, extension: data.actor_extension })
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'GET or POST only' })
  }

  // ── Enqueue a new request ──
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const mode = String(body.mode || '') as SpyMode
  const targetChannel = String(body.target_channel || '').trim()
  const actorKind = (body.actor_kind === 'device') ? 'device' : 'handset'
  if (!SPY_MODES.includes(mode)) return res.status(400).json({ error: 'mode must be listen|whisper|barge' })
  if (!targetChannel) return res.status(400).json({ error: 'target_channel required' })

  // Resolve the extension the agent will ring — handset (phone_extension) or
  // web softphone (webrtc_extension), depending on which button the user hit.
  // The stale-pending sweep (agent claims/acks rows directly, so nothing else
  // expires forgotten requests) runs in PARALLEL — every round trip here
  // delays the handset ringing.
  const [{ data: prof }] = await Promise.all([
    sb.from('user_profiles')
      .select('phone_extension, webrtc_extension')
      .eq('id', user.id)
      .maybeSingle(),
    sb.from('call_monitor_events')
      .update({ status: 'expired', completed_at: new Date().toISOString() })
      .eq('status', 'pending')
      .lt('created_at', new Date(Date.now() - REQUEST_TTL_MS).toISOString()),
  ])
  const ext = actorKind === 'device'
    ? ((prof as any)?.webrtc_extension || '').trim()
    : ((prof as any)?.phone_extension  || '').trim()
  if (!ext) {
    return res.status(400).json({
      error: 'no_extension',
      message: actorKind === 'device'
        ? 'No browser softphone extension is set on your profile. Ask an admin to set one in Settings → Users.'
        : 'No phone extension is set on your profile. Ask an admin to map your extension in Settings → Users.',
    })
  }

  const { data: row, error } = await sb.from('call_monitor_events').insert({
    actor_user_id: user.id,
    actor_extension: ext,
    actor_kind: actorKind,
    mode,
    target_call_linkedid: body.target_call_linkedid ? String(body.target_call_linkedid) : null,
    target_channel: targetChannel,
    target_agent_ext: body.target_agent_ext ? String(body.target_agent_ext) : null,
    status: 'pending',
  }).select('id').single()
  if (error) return res.status(500).json({ error: error.message })

  return res.status(202).json({ ok: true, request_id: row.id, extension: ext, status: 'pending' })
})
