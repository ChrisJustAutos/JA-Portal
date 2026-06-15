// pages/api/tasks/automations/index.ts
// GET  — list task automations + enrolment counts (view:tasks)
// POST — create a blank automation (edit:tasks)
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

export default withAuth('view:tasks', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const { data: autos, error } = await db.from('task_automations')
      .select('*').is('deleted_at', null).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const { data: enr } = await db.from('task_automation_enrolments').select('automation_id, status')
    const counts: Record<string, { active: number; done: number; cancelled: number }> = {}
    for (const e of enr || []) {
      const c = (counts[e.automation_id] ||= { active: 0, done: 0, cancelled: 0 })
      if (e.status === 'active') c.active++; else if (e.status === 'done') c.done++; else c.cancelled++
    }
    return res.status(200).json({ automations: autos || [], counts })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:tasks')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('task_automations').insert({
      name, description: body.description ? String(body.description) : null,
      trigger_event: 'task_created', enabled: false, created_by: user.id,
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, id: data.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
