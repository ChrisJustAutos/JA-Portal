// pages/api/calls/live/spy.ts
// POST — start a live monitor session (listen / whisper / barge) on an
// in-progress call. Resolves the caller's own phone extension, rings it via
// the FreePBX-side ChanSpy service, and audits every attempt. Gated to
// monitor:calls (admin/manager).
//
// Body: { target_channel, mode, target_call_linkedid?, target_agent_ext? }

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { isPbxLiveConfigured, startSpy } from '../../../../lib/pbx-live'
import type { SpyMode } from '../../../../lib/pbx-live'

export const config = { maxDuration: 15 }

const MODES: SpyMode[] = ['listen', 'whisper', 'barge']

export default withAuth('monitor:calls', async (req, res, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const mode = String(body.mode || '') as SpyMode
  const targetChannel = String(body.target_channel || '').trim()
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode must be listen|whisper|barge' })
  if (!targetChannel) return res.status(400).json({ error: 'target_channel required' })

  if (!isPbxLiveConfigured()) {
    return res.status(503).json({ error: 'not_configured', message: 'Live monitoring is not configured yet (PBX service offline).' })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  // Resolve the manager's extension (the phone we'll ring).
  const { data: prof } = await sb
    .from('user_profiles').select('phone_extension').eq('id', user.id).maybeSingle()
  const ext = ((prof as any)?.phone_extension || '').trim()
  if (!ext) {
    return res.status(400).json({
      error: 'no_extension',
      message: 'No phone extension is set on your profile. Ask an admin to map your extension in Settings → Users.',
    })
  }

  // Audit the attempt up-front.
  const { data: evt } = await sb.from('call_monitor_events').insert({
    actor_user_id: user.id,
    actor_extension: ext,
    mode,
    target_call_linkedid: body.target_call_linkedid ? String(body.target_call_linkedid) : null,
    target_channel: targetChannel,
    target_agent_ext: body.target_agent_ext ? String(body.target_agent_ext) : null,
    status: 'requested',
  }).select('id').single()

  try {
    const result = await startSpy({ listenerExtension: ext, targetChannel, mode })
    if (!result.ok) {
      if (evt?.id) await sb.from('call_monitor_events').update({ status: 'failed', error: result.error || 'failed' }).eq('id', evt.id)
      const message = result.error === 'not_registered'
        ? `Your phone (ext ${ext}) isn't registered — log into your handset or softphone first, then try again.`
        : (result.error || 'Could not start monitoring.')
      return res.status(409).json({ error: result.error || 'failed', message })
    }
    if (evt?.id) await sb.from('call_monitor_events').update({ status: 'connected' }).eq('id', evt.id)
    return res.status(200).json({ ok: true, extension: ext, mode })
  } catch (e: any) {
    if (evt?.id) await sb.from('call_monitor_events').update({ status: 'failed', error: e?.message || 'error' }).eq('id', evt.id)
    return res.status(502).json({ error: 'pbx_error', message: e?.message || 'PBX unreachable' })
  }
})
