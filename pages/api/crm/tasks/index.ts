// pages/api/crm/tasks/index.ts
// GET  ?assignee=me|<id>&status=&view=open|all  — list tasks
// POST                                          — create a task (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { TASK_PRIORITIES, TASK_STATUSES, logActivity } from '../../../../lib/crm'
import { notify } from '../../../../lib/notifications'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const assignee = String(req.query.assignee || '').trim()
    const status = String(req.query.status || '').trim()
    const view = String(req.query.view || 'open').trim()
    let query = db.from('crm_tasks')
      .select('id, title, description, status, priority, assignee_id, due_at, contact_id, lead_id, completed_at, created_at, assignee:user_profiles!crm_tasks_assignee_id_fkey(id, display_name), contact:crm_contacts(id, name), lead:crm_leads(id, title)')
      .is('deleted_at', null)
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(500)
    if (assignee === 'me') query = query.eq('assignee_id', user.id)
    else if (assignee) query = query.eq('assignee_id', assignee)
    if (status && (TASK_STATUSES as readonly string[]).includes(status)) query = query.eq('status', status)
    else if (view === 'open') query = query.neq('status', 'done')
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ tasks: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const title = String(body.title || '').trim()
    if (!title) return res.status(400).json({ error: 'title required' })
    const priority = (TASK_PRIORITIES as readonly string[]).includes(body.priority) ? body.priority : 'normal'

    const { data, error } = await db.from('crm_tasks').insert({
      title: title.slice(0, 200),
      description: body.description ? String(body.description) : null,
      status: 'open',
      priority,
      assignee_id: body.assignee_id || user.id,
      due_at: body.due_at || null,
      contact_id: body.contact_id || null,
      lead_id: body.lead_id || null,
      created_by: user.id,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })

    if (data.contact_id || data.lead_id) {
      await logActivity(db, { contact_id: data.contact_id, lead_id: data.lead_id, type: 'task', body: `Task: ${data.title}`, actor_id: user.id })
    }
    // Notify the assignee if it isn't the creator.
    if (data.assignee_id && data.assignee_id !== user.id) {
      await notify({
        module: 'crm', title: 'New task assigned to you', body: data.title,
        href: '/crm/tasks', userIds: [data.assignee_id], excludeUserId: user.id,
        dedupeKey: `crm-task:${data.id}`,
      })
    }
    return res.status(201).json({ ok: true, task: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
