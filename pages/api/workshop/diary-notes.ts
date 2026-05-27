// pages/api/workshop/diary-notes.ts
// GET    ?from=ISO&to=ISO — notes anchored in the range (for the diary)
// POST                    — add a day note (edit:bookings)
// DELETE ?id=             — remove a note (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

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
    const from = String(req.query.from || '')
    const to = String(req.query.to || '')
    if (!from || !to) return res.status(400).json({ error: 'from and to required' })
    const { data, error } = await db.from('workshop_diary_notes')
      .select('*').gte('note_date', from).lt('note_date', to).order('note_date', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ notes: data || [] })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const content = String(body.content || '').trim()
    const note_date = String(body.note_date || '')
    if (!content || !note_date) return res.status(400).json({ error: 'content and note_date required' })
    const { data, error } = await db.from('workshop_diary_notes').insert({
      content,
      note_date,
      note_end_date: body.note_end_date || null,
      author_name: user.displayName || user.email,
      created_by: user.id,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, note: data })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_diary_notes').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'GET, POST or DELETE only' })
})
