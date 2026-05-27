// pages/api/workshop/tasks/[id].ts
// PATCH  — update a task (status, fields).  (edit:bookings)
// DELETE — remove a task.                   (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { TASK_STATUSES, TASK_PRIORITIES } from '../../../../lib/workshop'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const EDITABLE = ['title', 'assignee', 'category', 'notes', 'due_date'] as const

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
  const db = sb()

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    for (const f of EDITABLE) if (f in body) patch[f] = body[f] === '' ? null : body[f]
    if ('status' in body) {
      if (!TASK_STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid status' })
      patch.status = body.status
    }
    if ('priority' in body) {
      if (!TASK_PRIORITIES.includes(body.priority)) return res.status(400).json({ error: 'invalid priority' })
      patch.priority = body.priority
    }
    const { error } = await db.from('workshop_tasks').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { error } = await db.from('workshop_tasks').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
