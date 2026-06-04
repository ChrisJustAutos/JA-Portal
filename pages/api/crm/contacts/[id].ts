// pages/api/crm/contacts/[id].ts
// GET    — contact + its leads, open tasks and full activity timeline
// PATCH  — update contact fields (edit:crm)
// DELETE — soft-delete (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { logActivity } from '../../../../lib/crm'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const PATCHABLE = ['name', 'first_name', 'last_name', 'email', 'phone', 'mobile', 'company_name', 'postcode', 'source', 'owner_id', 'notes', 'tags']

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: contact, error } = await db.from('crm_contacts')
      .select('*, owner:user_profiles!crm_contacts_owner_id_fkey(id, display_name), workshop:workshop_customers(id, name)')
      .eq('id', id).is('deleted_at', null).single()
    if (error || !contact) return res.status(404).json({ error: 'Not found' })

    const [{ data: leads }, { data: tasks }, { data: activities }] = await Promise.all([
      db.from('crm_leads').select('id, title, stage, value, owner_id, next_follow_up_at, created_at').eq('contact_id', id).is('deleted_at', null).order('created_at', { ascending: false }),
      db.from('crm_tasks').select('id, title, status, priority, due_at, assignee_id').eq('contact_id', id).is('deleted_at', null).neq('status', 'done').order('due_at', { ascending: true, nullsFirst: false }),
      db.from('crm_activities').select('id, type, body, meta, actor_id, created_at, actor:user_profiles(id, display_name)').eq('contact_id', id).order('created_at', { ascending: false }).limit(200),
    ])
    return res.status(200).json({ contact, leads: leads || [], tasks: tasks || [], activities: activities || [] })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    for (const k of PATCHABLE) if (k in body) patch[k] = body[k]
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No patchable fields' })
    const { data, error } = await db.from('crm_contacts').update(patch).eq('id', id).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, contact: data })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('crm_contacts').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
