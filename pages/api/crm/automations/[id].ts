// pages/api/crm/automations/[id].ts
// PATCH  — update fields and/or replace the step list (edit:crm)
// DELETE — soft-delete the automation (edit:crm). Active enrolments stop on
//          their next sweep (the engine cancels when the automation is gone).

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const ACTIONS = ['email', 'sms', 'task', 'notify_owner']
function stepRows(automationId: string, steps: any[]): any[] {
  return (Array.isArray(steps) ? steps : []).map((s, i) => ({
    automation_id: automationId,
    step_order: i + 1,
    delay_hours: Math.max(0, Math.round(Number(s.delay_hours) || 0)),
    action: ACTIONS.includes(s.action) ? s.action : 'email',
    subject: s.subject ? String(s.subject) : null,
    body: s.body ? String(s.body) : null,
    task_priority: s.task_priority || 'normal',
  }))
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const patch: any = {}
    if ('name' in body) patch.name = String(body.name).trim()
    if ('description' in body) patch.description = body.description ? String(body.description) : null
    if ('trigger_event' in body) patch.trigger_event = body.trigger_event === 'stage_changed' ? 'stage_changed' : 'lead_created'
    if ('trigger_stage' in body) patch.trigger_stage = body.trigger_stage || null
    if ('enabled' in body) patch.enabled = !!body.enabled
    if ('cancel_on_stages' in body && Array.isArray(body.cancel_on_stages)) patch.cancel_on_stages = body.cancel_on_stages

    if (Object.keys(patch).length) {
      const { error } = await db.from('crm_automations').update(patch).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
    }
    // Full replace of steps when provided.
    if ('steps' in body) {
      await db.from('crm_automation_steps').delete().eq('automation_id', id)
      const rows = stepRows(id, body.steps)
      if (rows.length) {
        const { error: sErr } = await db.from('crm_automation_steps').insert(rows)
        if (sErr) return res.status(500).json({ error: sErr.message })
      }
    }
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('crm_automations').update({ deleted_at: new Date().toISOString(), enabled: false }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
