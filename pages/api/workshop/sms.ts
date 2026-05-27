// pages/api/workshop/sms.ts
// POST { to? | customer_id?, body, booking_id?, type? } — send a customer SMS
// now via ClickSend and log it to workshop_reminders. Gated edit:bookings.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { sendSms } from '../../../lib/clicksend'

export const config = { maxDuration: 30 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const text = String(body.body || '').trim()
  if (!text) return res.status(400).json({ error: 'body required' })

  const db = sb()
  let number: string | null = body.to ? String(body.to) : null
  if (!number && body.customer_id) {
    const { data: c } = await db.from('workshop_customers').select('mobile, phone').eq('id', body.customer_id).maybeSingle()
    number = (c as any)?.mobile || (c as any)?.phone || null
  }
  if (!number) return res.status(400).json({ error: 'no_number', message: 'No mobile number on file for this customer.' })

  const { data: settings } = await db.from('workshop_settings').select('sms_from').eq('id', 'singleton').maybeSingle()
  const result = await sendSms(number, text, (settings as any)?.sms_from)

  await db.from('workshop_reminders').insert({
    type: ['booking', 'ready', 'followup', 'service_due', 'manual'].includes(body.type) ? body.type : 'manual',
    customer_id: body.customer_id || null,
    booking_id: body.booking_id || null,
    to_number: number,
    body: text,
    send_at: new Date().toISOString(),
    status: result.ok ? 'sent' : 'failed',
    clicksend_message_id: result.messageId || null,
    error: result.ok ? null : (result.error || 'send_failed'),
    sent_at: new Date().toISOString(),
    created_by: user.id,
  })

  if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'send_failed' })
  return res.status(200).json({ ok: true, messageId: result.messageId })
})
