// pages/api/b2b/admin/product-types/[id].ts
//
// PATCH  → update name / sort_order / is_active
// DELETE → remove the product type. Catalogue items that referenced it are
//          un-linked automatically (FK is on delete set null).
//
// Permission: edit:b2b_distributors.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing id' })

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const update: Record<string, any> = {}

    if ('name' in body) {
      const v = String(body.name || '').trim()
      if (!v) return res.status(400).json({ error: 'name cannot be empty' })
      if (v.length > 80) return res.status(400).json({ error: 'name max 80 characters' })
      update.name = v
    }
    if ('sort_order' in body) {
      const v = Number(body.sort_order)
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'sort_order must be a number' })
      update.sort_order = v
    }
    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be boolean' })
      update.is_active = body.is_active
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No editable fields supplied' })
    }

    const { data, error } = await c.from('b2b_product_types').update(update).eq('id', id).select().single()
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A product type with that name already exists' })
      return res.status(500).json({ error: error.message })
    }
    if (!data) return res.status(404).json({ error: 'Product type not found' })
    return res.status(200).json({ product_type: data })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('b2b_product_types').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
