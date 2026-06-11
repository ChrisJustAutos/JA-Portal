// pages/api/crm/leads/[id].ts
// GET    — lead + contact, tasks and activity timeline
// PATCH  — update fields; a stage change logs an activity + stamps won/lost
// DELETE — soft-delete (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { logActivity } from '../../../../lib/crm'
import { setLeadStage } from '../../../../lib/crm-server'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const PATCHABLE = ['title', 'value', 'owner_id', 'source', 'vehicle', 'details', 'next_follow_up_at', 'contact_attempts', 'lost_reason']

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: lead, error } = await db.from('crm_leads')
      .select('*, contact:crm_contacts(id, name, email, phone, mobile, company_name, workshop_customer_id), owner:user_profiles!crm_leads_owner_id_fkey(id, display_name)')
      .eq('id', id).is('deleted_at', null).single()
    if (error || !lead) return res.status(404).json({ error: 'Not found' })
    // Quote management lives on the lead drawer — attach the linked quote.
    if ((lead as any).workshop_quote_id) {
      const { data: quote } = await db.from('workshop_quotes')
        .select('id, status, subtotal, gst, total, deleted_at').eq('id', (lead as any).workshop_quote_id).maybeSingle()
      ;(lead as any).quote = quote && !quote.deleted_at ? quote : null
    }
    const [{ data: tasks }, { data: activities }] = await Promise.all([
      db.from('crm_tasks').select('id, title, status, priority, due_at, assignee_id').eq('lead_id', id).is('deleted_at', null).order('due_at', { ascending: true, nullsFirst: false }),
      db.from('crm_activities').select('id, type, body, meta, actor_id, created_at, actor:user_profiles(id, display_name)').eq('lead_id', id).order('created_at', { ascending: false }).limit(200),
    ])
    return res.status(200).json({ lead, tasks: tasks || [], activities: activities || [] })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const { data: before } = await db.from('crm_leads').select('stage, contact_id, title').eq('id', id).single()
    if (!before) return res.status(404).json({ error: 'Not found' })

    const patch: any = {}
    for (const k of PATCHABLE) if (k in body) patch[k] = body[k] === '' ? null : body[k]

    // Stage moves go through the shared setLeadStage (validation against
    // crm_pipeline_stages, won/lost stamping, activity + automation enrolment)
    // so the workshop bridge and this route behave identically.
    const wantsStage = 'stage' in body && body.stage !== before.stage
    if (wantsStage) {
      const r = await setLeadStage(db, id, body.stage, user.id)
      if (!r.ok) return res.status(400).json({ error: r.error })
    }
    if (Object.keys(patch).length === 0 && !wantsStage) return res.status(400).json({ error: 'No patchable fields' })

    if (Object.keys(patch).length > 0) {
      const { error } = await db.from('crm_leads').update(patch).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      if (!wantsStage) {
        await logActivity(db, { lead_id: id, contact_id: before.contact_id, type: 'note', body: `Lead updated by ${user.displayName || user.email}`, actor_id: user.id })
      }
    }
    const { data } = await db.from('crm_leads').select('*').eq('id', id).single()
    return res.status(200).json({ ok: true, lead: data })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('crm_leads').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
