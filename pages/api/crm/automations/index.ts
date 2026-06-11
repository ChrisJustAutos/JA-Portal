// pages/api/crm/automations/index.ts
// GET  — list automations (with steps) + enrolment counts
// POST — create an automation with its steps (edit:crm)

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

  if (req.method === 'GET') {
    const { data: autos, error } = await db.from('crm_automations')
      .select('*, steps:crm_automation_steps(*)').is('deleted_at', null).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    for (const a of autos || []) (a as any).steps = ((a as any).steps || []).sort((x: any, y: any) => x.step_order - y.step_order)
    const { data: enr } = await db.from('crm_automation_enrolments').select('automation_id, status')
    const counts: Record<string, { active: number; done: number; cancelled: number }> = {}
    for (const e of enr || []) {
      const c = (counts[e.automation_id] ||= { active: 0, done: 0, cancelled: 0 })
      if (e.status === 'active') c.active++; else if (e.status === 'done') c.done++; else c.cancelled++
    }
    return res.status(200).json({ automations: autos || [], counts })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })

    const insert: any = {
      name,
      description: body.description ? String(body.description) : null,
      trigger_event: body.trigger_event === 'stage_changed' ? 'stage_changed' : 'lead_created',
      trigger_stage: body.trigger_stage || null,
      enabled: !!body.enabled,
      cancel_on_stages: Array.isArray(body.cancel_on_stages) ? body.cancel_on_stages : ['won', 'lost'],
      created_by: user.id,
    }
    if (body.graph) insert.graph = body.graph   // new flows save their graph via PATCH after creation
    const { data: auto, error } = await db.from('crm_automations').insert(insert).select('id').single()
    if (error) return res.status(500).json({ error: error.message })

    const rows = stepRows(auto.id, body.steps)
    if (rows.length) {
      const { error: sErr } = await db.from('crm_automation_steps').insert(rows)
      if (sErr) return res.status(500).json({ error: sErr.message })
    }
    return res.status(201).json({ ok: true, id: auto.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
