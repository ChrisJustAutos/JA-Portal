// lib/crm-call-link.ts
// SERVER-ONLY. Stitches phone calls onto the CRM timeline (runs from the
// crm-campaigns cron, every 5 min):
//
// 1. Originated (click-to-dial) calls: connected originate rows whose CDR has
//    landed (calls.linkedid match) get calls.id attached to both the queue row
//    and the pre-logged 'call' activity (duration + recording flag).
// 2. All other recent calls: matched to a CRM contact by number (last-9
//    digits) and logged as a 'call' activity exactly once — closes the
//    "inbound calls invisible in the CRM" gap. calls.crm_logged_at is the
//    processed marker either way (set even when no contact matches).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity, phoneKey } from './crm'

const WINDOW_HOURS = 48

export async function processCallLinkage(db: SupabaseClient): Promise<{ linked: number; logged: number }> {
  const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString()
  let linked = 0, logged = 0

  // ── 1. Attach CDRs to connected originates ──
  const { data: pendingLinks } = await db.from('call_monitor_events')
    .select('id, result_linkedid, actor_extension, dial_number, contact_id, lead_id, completed_at')
    .eq('mode', 'originate').eq('status', 'connected').is('call_id', null)
    .gte('created_at', sinceIso).limit(50)
  for (const ev of pendingLinks || []) {
    let call: any = null
    if (ev.result_linkedid) {
      const { data } = await db.from('calls').select('id, duration_seconds, has_recording, disposition').eq('linkedid', ev.result_linkedid).maybeSingle()
      call = data
    }
    if (!call && ev.dial_number && ev.completed_at) {
      // Fallback: ext + number tail within ±5 min of completion.
      const k = phoneKey(ev.dial_number)
      if (k) {
        const lo = new Date(new Date(ev.completed_at).getTime() - 5 * 60000).toISOString()
        const hi = new Date(new Date(ev.completed_at).getTime() + 5 * 60000).toISOString()
        const { data } = await db.from('calls')
          .select('id, duration_seconds, has_recording, disposition')
          .eq('agent_ext', ev.actor_extension).ilike('external_number', `%${k}`)
          .gte('call_date', lo).lte('call_date', hi).limit(1)
        call = data?.[0] || null
      }
    }
    if (!call) continue
    await db.from('call_monitor_events').update({ call_id: call.id }).eq('id', ev.id)
    await db.from('calls').update({ crm_logged_at: new Date().toISOString() }).eq('id', call.id)
    // Enrich the pre-logged activity with the CDR.
    const { data: acts } = await db.from('crm_activities')
      .select('id, meta').contains('meta', { originate_id: ev.id }).limit(1)
    if (acts && acts.length) {
      await db.from('crm_activities').update({
        meta: { ...(acts[0].meta || {}), call_id: call.id, duration: call.duration_seconds, has_recording: call.has_recording, disposition: call.disposition },
      }).eq('id', acts[0].id)
    }
    linked++
  }

  // ── 2. Log recent unprocessed calls to matching contacts ──
  const { data: calls } = await db.from('calls')
    .select('id, linkedid, call_date, direction, external_number, caller_name, duration_seconds, disposition, has_recording')
    .is('crm_logged_at', null).gte('call_date', sinceIso)
    .order('call_date', { ascending: true }).limit(200)
  for (const c of calls || []) {
    const k = phoneKey(c.external_number)
    let contactId: string | null = null
    if (k) {
      const { data: matches } = await db.from('crm_contacts')
        .select('id').is('deleted_at', null)
        .or(`phone.ilike.%${k},mobile.ilike.%${k}`).limit(1)
      contactId = matches?.[0]?.id || null
    }
    if (contactId) {
      const mins = c.duration_seconds ? `${Math.round(Number(c.duration_seconds) / 60)} min` : null
      await logActivity(db, {
        contact_id: contactId, type: 'call',
        body: `${c.direction === 'inbound' ? 'Inbound' : 'Outbound'} call${c.caller_name ? ` — ${c.caller_name}` : ''}${mins ? ` (${mins})` : ''}${c.disposition && c.disposition !== 'ANSWERED' ? ` · ${String(c.disposition).toLowerCase().replace(/_/g, ' ')}` : ''}`,
        meta: { call_id: c.id, direction: c.direction === 'inbound' ? 'in' : 'out', duration: c.duration_seconds, has_recording: c.has_recording },
      })
      logged++
    }
    await db.from('calls').update({ crm_logged_at: new Date().toISOString() }).eq('id', c.id)
  }

  return { linked, logged }
}
