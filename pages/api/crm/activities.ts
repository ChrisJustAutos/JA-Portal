// pages/api/crm/activities.ts
// POST — add a manual timeline entry (note/call/email/sms) to a contact and/or
//        lead (edit:crm). GET ?contact_id= / ?lead_id= — fetch a timeline.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { ActivityType, logActivity } from '../../../lib/crm'

export const config = { maxDuration: 10 }

const MANUAL_TYPES: ActivityType[] = ['note', 'call', 'email', 'sms']

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const contactId = String(req.query.contact_id || '').trim()
    const leadId = String(req.query.lead_id || '').trim()
    if (!contactId && !leadId) return res.status(400).json({ error: 'contact_id or lead_id required' })
    let query = db.from('crm_activities')
      .select('id, type, body, meta, actor_id, created_at, contact_id, lead_id, actor:user_profiles(id, display_name)')
      .order('created_at', { ascending: false }).limit(200)
    if (contactId) query = query.eq('contact_id', contactId)
    if (leadId) query = query.eq('lead_id', leadId)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ activities: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const text = String(body.body || '').trim()
    if (!text) return res.status(400).json({ error: 'body required' })
    if (!body.contact_id && !body.lead_id) return res.status(400).json({ error: 'contact_id or lead_id required' })
    const type: ActivityType = MANUAL_TYPES.includes(body.type) ? body.type : 'note'
    await logActivity(db, { contact_id: body.contact_id || null, lead_id: body.lead_id || null, type, body: text, actor_id: user.id })
    return res.status(201).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
