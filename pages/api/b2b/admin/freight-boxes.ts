// pages/api/b2b/admin/freight-boxes.ts
// CRUD for the standard freight cartons used by the cartonizer.
//   GET                              → { boxes: [...] } (active + inactive, sorted)
//   POST   { name, length_mm, width_mm, height_mm, max_weight_g }  → create
//   PATCH  ?id=  { ...editable }      → update
//   DELETE ?id=                       → remove
// Dims in mm, weight in grams (matches b2b_catalogue freight_* columns).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const NUM_FIELDS = ['length_mm', 'width_mm', 'height_mm', 'max_weight_g', 'sort_order'] as const

function cleanBody(body: any): { update: Record<string, any>; issues: string[] } {
  const update: Record<string, any> = {}
  const issues: string[] = []
  if ('name' in body) {
    const n = String(body.name || '').trim()
    if (!n) issues.push('Name required'); else update.name = n.slice(0, 60)
  }
  if ('is_active' in body) update.is_active = !!body.is_active
  for (const f of NUM_FIELDS) {
    if (f in body) {
      const v = parseInt(String(body[f]), 10)
      if (!Number.isFinite(v) || v < 0) issues.push(`${f} must be a non-negative number`)
      else update[f] = v
    }
  }
  return { update, issues }
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_freight_boxes')
      .select('id, name, length_mm, width_mm, height_mm, max_weight_g, sort_order, is_active')
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ boxes: data || [] })
  }

  if (req.method === 'POST') {
    const { update, issues } = cleanBody(req.body || {})
    for (const f of ['name', 'length_mm', 'width_mm', 'height_mm', 'max_weight_g']) {
      if (!(f in update)) issues.push(`${f} required`)
    }
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    const { data, error } = await c.from('b2b_freight_boxes').insert(update).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, id: data.id })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { update, issues } = cleanBody(req.body || {})
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' })
    const { error } = await c.from('b2b_freight_boxes').update(update).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await c.from('b2b_freight_boxes').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
