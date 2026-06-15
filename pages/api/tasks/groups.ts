// pages/api/tasks/groups.ts — task groups CRUD (edit:tasks for writes).
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

export default withAuth('view:tasks', async (req, res, user) => {
  const db = sb()
  if (req.method === 'GET') {
    const { data } = await db.from('task_groups').select('*').is('archived_at', null).order('sort_order', { ascending: true })
    return res.status(200).json({ groups: data || [] })
  }
  if (!roleHasPermission(user.role, 'edit:tasks')) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('task_groups').insert({ name: name.slice(0, 120), color: body.color || '#4f8ef7', sort_order: Number(body.sort_order) || 0 }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, group: data })
  }
  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: any = {}
    if ('name' in body) patch.name = String(body.name || '').slice(0, 120)
    if ('color' in body) patch.color = body.color || null
    if ('sort_order' in body) patch.sort_order = Number(body.sort_order) || 0
    const { error } = await db.from('task_groups').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }
  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    // Detach tasks, then archive the group (keeps task history).
    await db.from('tasks').update({ group_id: null }).eq('group_id', id)
    const { error } = await db.from('task_groups').update({ archived_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }
  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
