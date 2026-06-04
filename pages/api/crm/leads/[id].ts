// pages/api/crm/leads/[id].ts
// GET    — lead + contact, tasks and activity timeline
// PATCH  — update fields; a stage change logs an activity + stamps won/lost
// DELETE — soft-delete (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { LEAD_STAGES, LEAD_STAGE_LABELS, LeadStage, logActivity } from '../../../../lib/crm'

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

    let stageChanged = false
    if ('stage' in body && (LEAD_STAGES as readonly string[]).includes(body.stage) && body.stage !== before.stage) {
      patch.stage = body.stage as LeadStage
      stageChanged = true
      if (body.stage === 'won') { patch.won_at = new Date().toISOString(); patch.lost_at = null }
      else if (body.stage === 'lost') { patch.lost_at = new Date().toISOString(); patch.won_at = null }
      else { patch.won_at = null; patch.lost_at = null }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No patchable fields' })

    const { data, error } = await db.from('crm_leads').update(patch).eq('id', id).select('*').single()
    if (error) return res.status(500).json({ error: error.message })

    if (stageChanged) {
      await logActivity(db, {
        lead_id: id, contact_id: before.contact_id, type: 'stage_change',
        body: `${LEAD_STAGE_LABELS[before.stage as LeadStage] || before.stage} → ${LEAD_STAGE_LABELS[body.stage as LeadStage]}`,
        meta: { from: before.stage, to: body.stage }, actor_id: user.id,
      })
    } else {
      await logActivity(db, { lead_id: id, contact_id: before.contact_id, type: 'note', body: `Lead updated by ${user.displayName || user.email}`, actor_id: user.id })
    }
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
