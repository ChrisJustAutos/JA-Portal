// pages/api/crm/tasks/[id].ts
// PATCH  — update status/priority/assignee/due/title/description (edit:crm)
// DELETE — soft-delete (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { TASK_PRIORITIES, TASK_STATUSES } from '../../../../lib/crm'
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
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const { data: before } = await db.from('crm_tasks').select('assignee_id, status').eq('id', id).single()
    if (!before) return res.status(404).json({ error: 'Not found' })

    const patch: any = {}
    if ('title' in body) patch.title = String(body.title).slice(0, 200)
    if ('description' in body) patch.description = body.description ? String(body.description) : null
    if ('priority' in body && (TASK_PRIORITIES as readonly string[]).includes(body.priority)) patch.priority = body.priority
    if ('assignee_id' in body) patch.assignee_id = body.assignee_id || null
    if ('due_at' in body) patch.due_at = body.due_at || null
    if ('status' in body && (TASK_STATUSES as readonly string[]).includes(body.status)) {
      patch.status = body.status
      patch.completed_at = body.status === 'done' ? new Date().toISOString() : null
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No patchable fields' })

    const { data, error } = await db.from('crm_tasks').update(patch).eq('id', id).select('*').single()
    if (error) return res.status(500).json({ error: error.message })

    // Notify a newly-assigned user (reassignment).
    if (patch.assignee_id && patch.assignee_id !== before.assignee_id && patch.assignee_id !== user.id) {
      await notify({
        module: 'crm', title: 'Task assigned to you', body: data.title,
        href: '/crm/tasks', userIds: [patch.assignee_id], excludeUserId: user.id,
        dedupeKey: `crm-task-reassign:${id}:${patch.assignee_id}`,
      })
    }
    return res.status(200).json({ ok: true, task: data })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('crm_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
