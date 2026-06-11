// pages/api/calls/originate.ts
// Click-to-dial from the CRM. POST queues an 'originate' request into
// call_monitor_events (the same queue the on-PBX ja-ami-monitor agent drains
// over Realtime for Listen/Whisper/Barge): the agent rings the caller's own
// extension first, then dials the customer and bridges, acking 'connected'
// (+ the call's Linkedid) or a mapped failure. GET polls the outcome.
//
// The call is pre-logged to the CRM timeline immediately, so the activity
// exists even if CDR linkage never completes; the crm-campaigns cron later
// attaches the calls-table record by linkedid (duration / recording).
//
// Gated use:phone. Feature-flagged client-side (NEXT_PUBLIC_CLICK_TO_DIAL)
// until the PBX worker understands mode='originate'.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { toE164AU } from '../../../lib/clicksend'
import { logActivity } from '../../../lib/crm'
import { REQUEST_TTL_MS } from '../../../lib/live-calls'

export const config = { maxDuration: 10 }

export default withAuth('use:phone', async (req, res, user) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  // ── Poll one of my own requests ──
  if (req.method === 'GET') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data } = await sb.from('call_monitor_events')
      .select('status, error, actor_extension, dial_number, result_linkedid')
      .eq('id', id).eq('actor_user_id', user.id).maybeSingle()
    if (!data) return res.status(404).json({ error: 'not_found' })
    return res.status(200).json(data)
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'GET or POST only' })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  // Resolve the number: explicit, or from the CRM contact (mobile → phone).
  let rawNumber: string | null = body.to ? String(body.to) : null
  let contactId: string | null = body.contact_id || null
  const leadId: string | null = body.lead_id || null
  let contactName: string | null = null
  if (!rawNumber && leadId && !contactId) {
    const { data: lead } = await sb.from('crm_leads').select('contact_id').eq('id', leadId).maybeSingle()
    contactId = lead?.contact_id || null
  }
  if (contactId) {
    const { data: c } = await sb.from('crm_contacts').select('id, name, mobile, phone').eq('id', contactId).maybeSingle()
    if (c) { contactName = c.name; if (!rawNumber) rawNumber = c.mobile || c.phone || null }
  }
  if (!rawNumber) return res.status(400).json({ error: 'No phone number — pass to/contact_id/lead_id' })
  const dialNumber = toE164AU(rawNumber)
  if (!dialNumber) return res.status(400).json({ error: `"${rawNumber}" doesn't look like a valid AU number` })

  // Caller's handset extension (the PBX rings this first).
  const { data: prof } = await sb.from('user_profiles').select('phone_extension').eq('id', user.id).maybeSingle()
  const ext = ((prof as any)?.phone_extension || '').trim()
  if (!ext) {
    return res.status(400).json({ error: 'no_extension', message: 'No phone extension is set on your profile. Ask an admin to map your extension in Settings → Users.' })
  }

  // Keep the queue clean (same sweep as spy.ts).
  await sb.from('call_monitor_events')
    .update({ status: 'expired', completed_at: new Date().toISOString() })
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - REQUEST_TTL_MS).toISOString())

  const { data: row, error } = await sb.from('call_monitor_events').insert({
    actor_user_id: user.id,
    actor_extension: ext,
    mode: 'originate',
    dial_number: dialNumber,
    contact_id: contactId,
    lead_id: leadId,
    status: 'pending',
  }).select('id').single()
  if (error) return res.status(500).json({ error: error.message })

  // Pre-log the outbound call on the CRM timeline — outcome + CDR link get
  // attached later by the linkage cron / poller.
  if (contactId || leadId) {
    await logActivity(sb, {
      contact_id: contactId, lead_id: leadId, type: 'call',
      body: `Outbound call to ${contactName ? `${contactName} (${dialNumber})` : dialNumber}`,
      meta: { originate_id: row.id, direction: 'out', number: dialNumber },
      actor_id: user.id,
    })
  }

  return res.status(202).json({ ok: true, request_id: row.id, extension: ext, status: 'pending' })
})
