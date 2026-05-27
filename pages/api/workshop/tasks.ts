// pages/api/workshop/tasks.ts
// GET  ?status= — list workshop tasks
// POST          — create a task (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { TASK_STATUSES, TASK_PRIORITIES } from '../../../lib/workshop'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const status = String(req.query.status || '').trim()
    let q = db.from('workshop_tasks').select('*').order('created_at', { ascending: false }).limit(300)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ tasks: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const title = String(body.title || '').trim()
    if (!title) return res.status(400).json({ error: 'title required' })
    const { data, error } = await db.from('workshop_tasks').insert({
      title,
      assignee: body.assignee ? String(body.assignee) : null,
      status: TASK_STATUSES.includes(body.status) ? body.status : 'todo',
      priority: TASK_PRIORITIES.includes(body.priority) ? body.priority : 'medium',
      category: body.category ? String(body.category) : null,
      notes: body.notes ? String(body.notes) : null,
      due_date: body.due_date || null,
      created_by: user.id,
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, id: data.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
