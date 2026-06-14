// pages/api/workshop/comm-templates.ts
// Editable customer communication templates (workshop_comm_templates).
//   GET            — all templates (view:diary)
//   POST           — create (admin:settings)
//   PATCH ?id=     — update (admin:settings)
//   DELETE ?id=    — delete (admin:settings)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const TRIGGERS = ['booking_confirmation', 'booking_reminder', 'ready', 'follow_up', 'service_due', 'rego_due']
const EDITABLE = ['trigger', 'name', 'channel', 'subject', 'body', 'enabled', 'offset_value', 'offset_unit', 'offset_dir', 'job_types', 'sort_order'] as const

function clean(body: any, forInsert: boolean): any {
  const p: any = {}
  for (const f of EDITABLE) {
    if (!(f in body)) continue
    if (f === 'enabled') p[f] = !!body[f]
    else if (f === 'offset_value') p[f] = Math.max(0, Math.round(Number(body[f]) || 0))
    else if (f === 'sort_order') p[f] = Number(body[f]) || 0
    else if (f === 'job_types') p[f] = Array.isArray(body[f]) ? body[f].filter((x: any) => typeof x === 'string') : []
    else if (f === 'channel') p[f] = body[f] === 'email' ? 'email' : 'sms'
    else if (f === 'offset_unit') p[f] = body[f] === 'hours' ? 'hours' : 'days'
    else if (f === 'offset_dir') p[f] = body[f] === 'after' ? 'after' : 'before'
    else if (f === 'trigger') { if (TRIGGERS.includes(body[f])) p[f] = body[f] }
    else p[f] = body[f] === '' ? null : body[f]
  }
  if (forInsert) {
    if (!p.trigger) p.trigger = 'booking_reminder'
    if (!p.name) p.name = 'New template'
    if (p.body == null) p.body = ''
  }
  return p
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('workshop_comm_templates').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ templates: data || [] })
  }

  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  let body: any = {}
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  }

  if (req.method === 'POST') {
    const { data, error } = await db.from('workshop_comm_templates').insert(clean(body, true)).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, template: data })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_comm_templates').update({ ...clean(body, false), updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_comm_templates').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
