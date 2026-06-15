// pages/api/b2b/admin/reorder/[id].ts
// PATCH — edit a reorder row (moq, morgans_judgment, notes). DELETE — remove it.
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 10 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_catalogue', async (req, res) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    if ('moq' in body) patch.moq = body.moq === '' || body.moq == null ? null : Math.max(0, Math.round(Number(body.moq) || 0))
    if ('morgans_judgment' in body) patch.morgans_judgment = body.morgans_judgment === '' || body.morgans_judgment == null ? null : Number(body.morgans_judgment)
    if ('notes' in body) patch.notes = body.notes ? String(body.notes).slice(0, 500) : null
    if ('sort_order' in body) patch.sort_order = Math.round(Number(body.sort_order) || 0)
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No editable fields' })
    const { error } = await db.from('b2b_reorder_items').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { error } = await db.from('b2b_reorder_items').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
