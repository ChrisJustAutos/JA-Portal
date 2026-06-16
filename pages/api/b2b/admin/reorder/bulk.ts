// pages/api/b2b/admin/reorder/bulk.ts
// POST — bulk edit / delete reorder rows.
//   { action: 'update', ids: string[], patch: { moq?, morgans_judgment?, notes? } }
//   { action: 'delete', ids: string[] }
// Only the patch fields supplied are changed (blank = clear). Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 15 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_catalogue', async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const ids = Array.isArray(body.ids) ? body.ids.map((x: any) => String(x || '').trim()).filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: 'ids required' })
  if (ids.length > 1000) return res.status(400).json({ error: 'Too many rows in one request' })
  const db = sb()

  if (body.action === 'delete') {
    const { error } = await db.from('b2b_reorder_items').delete().in('id', ids)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, deleted: ids.length })
  }

  if (body.action === 'update') {
    const p = body.patch || {}
    const patch: any = {}
    if ('moq' in p) patch.moq = p.moq === '' || p.moq == null ? null : Math.max(0, Math.round(Number(p.moq) || 0))
    if ('morgans_judgment' in p) patch.morgans_judgment = p.morgans_judgment === '' || p.morgans_judgment == null ? null : Number(p.morgans_judgment)
    if ('notes' in p) patch.notes = p.notes ? String(p.notes).slice(0, 500) : null
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No editable fields' })
    const { error } = await db.from('b2b_reorder_items').update(patch).in('id', ids)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, updated: ids.length })
  }

  return res.status(400).json({ error: "action must be 'update' or 'delete'" })
})
