// pages/api/crm/segments/index.ts
// GET  — list segments
// POST — create a segment (edit:crm)

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

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('crm_segments').select('*').is('deleted_at', null).order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ segments: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('crm_segments').insert({
      name, description: body.description ? String(body.description) : null,
      definition: body.definition && typeof body.definition === 'object' ? body.definition : {},
      created_by: user.id,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, segment: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
