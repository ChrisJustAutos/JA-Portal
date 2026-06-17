// pages/api/workshop/reminders.ts
// GET — communications history (workshop_reminders): SMS + emails sent/queued.
//   ?channel=sms|email  ?status=sent|failed|pending|cancelled  ?q=  ?limit=
// Gated view:diary.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 15 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()
  const channel = String(req.query.channel || '').trim()
  const status = String(req.query.status || '').trim()
  const q = String(req.query.q || '').replace(/[%,()*]/g, ' ').trim()
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))

  let custIds: string[] = []
  if (q) {
    const { data: c } = await db.from('workshop_customers').select('id').ilike('name', `%${q}%`).limit(200)
    custIds = (c || []).map((x: any) => x.id)
  }

  let qy = db.from('workshop_reminders')
    .select('id, type, channel, to_number, to_email, subject, body, status, send_at, sent_at, error, customer_id, booking_id, quote_id, created_at, customer:workshop_customers!customer_id(name)')
    .order('created_at', { ascending: false }).limit(limit)
  if (channel) qy = qy.eq('channel', channel)
  if (status) qy = qy.eq('status', status)
  if (q) {
    const ors = [`body.ilike.%${q}%`, `to_number.ilike.%${q}%`, `to_email.ilike.%${q}%`, `subject.ilike.%${q}%`]
    if (custIds.length) ors.push(`customer_id.in.(${custIds.join(',')})`)
    qy = qy.or(ors.join(','))
  }
  const { data, error } = await qy
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ comms: data || [] })
})
