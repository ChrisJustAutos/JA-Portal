// pages/api/tasks/[id].ts — PATCH / DELETE a task (edit:tasks).
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const STATUSES = ['todo', 'in_progress', 'blocked', 'done']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

export default withAuth('view:tasks', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  if (!roleHasPermission(user.role, 'edit:tasks')) return res.status(403).json({ error: 'Forbidden' })
  const db = sb()

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = { updated_at: new Date().toISOString() }
    if ('title' in body) patch.title = String(body.title || '').slice(0, 300)
    if ('description' in body) patch.description = body.description ? String(body.description) : null
    if ('priority' in body && PRIORITIES.includes(body.priority)) patch.priority = body.priority
    if ('assignee_id' in body) patch.assignee_id = body.assignee_id || null
    if ('group_id' in body) patch.group_id = body.group_id || null
    if ('due_at' in body) patch.due_at = body.due_at || null
    if ('sort_order' in body) patch.sort_order = Math.round(Number(body.sort_order) || 0)
    if ('status' in body) {
      if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid status' })
      patch.status = body.status
      patch.completed_at = body.status === 'done' ? new Date().toISOString() : null
    }
    const { error } = await db.from('tasks').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { error } = await db.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
