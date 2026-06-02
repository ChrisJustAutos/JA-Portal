// pages/api/b2b/admin/freight-satchels.ts
// CRUD for flat-rate satchels (e.g. AusPost prepaid) offered alongside carrier
// rates at quote time.
//   GET                          → { satchels: [...] } (active + inactive, sorted)
//   POST   { name, max_weight_g, cost_ex_gst, sell_ex_gst, max_*_mm? }  → create
//   PATCH  ?id=  { ...editable }  → update
//   DELETE ?id=                   → remove
// Weights in grams, dims in mm, prices EX-GST (the manager UI enters inc-GST and
// converts). Mirrors freight-boxes.ts.

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

const INT_FIELDS = ['max_weight_g', 'sort_order'] as const
// Optional integer dims — may be cleared back to null.
const NULLABLE_INT_FIELDS = ['max_length_mm', 'max_width_mm', 'max_height_mm'] as const
const MONEY_FIELDS = ['cost_ex_gst', 'sell_ex_gst'] as const

function cleanBody(body: any): { update: Record<string, any>; issues: string[] } {
  const update: Record<string, any> = {}
  const issues: string[] = []
  if ('name' in body) {
    const n = String(body.name || '').trim()
    if (!n) issues.push('Name required'); else update.name = n.slice(0, 60)
  }
  if ('is_active' in body) update.is_active = !!body.is_active
  for (const f of INT_FIELDS) {
    if (f in body) {
      const v = parseInt(String(body[f]), 10)
      if (!Number.isFinite(v) || v < 0) issues.push(`${f} must be a non-negative number`)
      else update[f] = v
    }
  }
  for (const f of NULLABLE_INT_FIELDS) {
    if (f in body) {
      const raw = body[f]
      if (raw == null || String(raw).trim() === '') { update[f] = null; continue }
      const v = parseInt(String(raw), 10)
      if (!Number.isFinite(v) || v < 0) issues.push(`${f} must be a non-negative number`)
      else update[f] = v
    }
  }
  for (const f of MONEY_FIELDS) {
    if (f in body) {
      const v = Math.round(Number(body[f]) * 100) / 100
      if (!Number.isFinite(v) || v < 0) issues.push(`${f} must be a non-negative amount`)
      else update[f] = v
    }
  }
  return { update, issues }
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_freight_satchels')
      .select('id, name, max_weight_g, max_length_mm, max_width_mm, max_height_mm, cost_ex_gst, sell_ex_gst, sort_order, is_active')
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ satchels: data || [] })
  }

  if (req.method === 'POST') {
    const { update, issues } = cleanBody(req.body || {})
    for (const f of ['name', 'max_weight_g', 'sell_ex_gst']) {
      if (!(f in update)) issues.push(`${f} required`)
    }
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    const { data, error } = await c.from('b2b_freight_satchels').insert(update).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, id: data.id })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { update, issues } = cleanBody(req.body || {})
    if (issues.length) return res.status(400).json({ error: 'Validation failed', issues })
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' })
    const { error } = await c.from('b2b_freight_satchels').update(update).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await c.from('b2b_freight_satchels').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
