// pages/api/b2b/admin/freight-pallets.ts
// CRUD for the pallet options the cartonizer chooses between.
//   GET                                                          → { pallets: [...] }
//   POST   { name, length_mm, width_mm, max_height_mm, max_weight_g } → create
//   PATCH  ?id=  { ...editable }                                  → update
//   DELETE ?id=                                                   → remove
// Dims in mm, weight in grams — same units as freight-boxes, which this mirrors.
//
// The palletise-over-weight threshold is NOT here: it decides pallet vs cartons
// for the whole order rather than belonging to any one pallet, so it stays on
// b2b_settings (see the Freight packaging screen).

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

const NUM_FIELDS = ['length_mm', 'width_mm', 'max_height_mm', 'max_weight_g', 'sort_order'] as const
const REQUIRED = ['name', 'length_mm', 'width_mm', 'max_height_mm', 'max_weight_g'] as const

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
  // A pallet with no capacity would be picked and then ship nothing.
  if ('max_weight_g' in update && update.max_weight_g === 0) issues.push('Max weight must be greater than zero')
  return { update, issues }
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_freight_pallets')
      .select('id, name, length_mm, width_mm, max_height_mm, max_weight_g, sort_order, is_active')
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ pallets: data || [] })
  }

  if (req.method === 'POST') {
    const { update, issues } = cleanBody(req.body || {})
    for (const f of REQUIRED) if (!(f in update)) issues.push(`${f} required`)
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    const { data, error } = await c.from('b2b_freight_pallets').insert(update).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, id: data.id })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { update, issues } = cleanBody(req.body || {})
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' })
    const { error } = await c.from('b2b_freight_pallets').update(update).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await c.from('b2b_freight_pallets').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
