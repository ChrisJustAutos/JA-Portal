// pages/api/tasks/index.ts — standalone Tasks module.
//   GET  — { groups, tasks, users }   (view:tasks)
//   POST — create a task               (edit:tasks)
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { enrolTask } from '../../../lib/task-automations'

export const config = { maxDuration: 15 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const STATUSES = ['todo', 'in_progress', 'blocked', 'done']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

export default withAuth('view:tasks', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const [g, t, u] = await Promise.all([
      db.from('task_groups').select('*').is('archived_at', null).order('sort_order', { ascending: true }),
      db.from('tasks').select('id, title, description, status, priority, assignee_id, group_id, due_at, sort_order, completed_at, created_at, assignee:user_profiles!assignee_id(id, display_name)').is('deleted_at', null).order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      db.from('user_profiles').select('id, display_name, email').eq('is_active', true).order('display_name', { ascending: true }),
    ])
    return res.status(200).json({ groups: g.data || [], tasks: t.data || [], users: u.data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:tasks')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const title = String(body.title || '').trim()
    if (!title) return res.status(400).json({ error: 'title required' })
    const { data, error } = await db.from('tasks').insert({
      title: title.slice(0, 300),
      description: body.description ? String(body.description) : null,
      status: STATUSES.includes(body.status) ? body.status : 'todo',
      priority: PRIORITIES.includes(body.priority) ? body.priority : 'normal',
      assignee_id: body.assignee_id || null,
      group_id: body.group_id || null,
      due_at: body.due_at || null,
      created_by: user.id,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    try { await enrolTask(data as any, 'task_created', db) } catch { /* best-effort */ }
    return res.status(201).json({ ok: true, task: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
