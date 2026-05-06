// pages/api/b2b/admin/catalogue/[id].ts
// PATCH /api/b2b/admin/catalogue/{id}
//
// Editable fields:
//   - trade_price_ex_gst   number, >= 0
//   - b2b_visible          boolean
//   - description          string | null
//   - primary_image_url    string | null
//   - category_id          uuid | null
//
// MYOB-canonical fields (sku, name, rrp_ex_gst, is_taxable) are NOT editable
// here — they get refreshed from MYOB on every sync.
//
// Permission: edit:b2b_catalogue (admin / manager).

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

const EDITABLE_FIELDS = [
  'trade_price_ex_gst',
  'b2b_visible',
  'description',
  'primary_image_url',
  'category_id',
] as const

type EditableField = typeof EDITABLE_FIELDS[number]

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH')
    return res.status(405).json({ error: 'PATCH only' })
  }

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing id' })

  const body = (req.body && typeof req.body === 'object') ? req.body : {}

  // Build update object from allow-list. Reject unknown fields silently
  // rather than erroring, but log so we notice if the UI sends something new.
  const update: Record<string, any> = {}
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      update[key] = body[key]
    }
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No editable fields supplied' })
  }

  // Validation
  if ('trade_price_ex_gst' in update) {
    const v = Number(update.trade_price_ex_gst)
    if (!isFinite(v) || v < 0) {
      return res.status(400).json({ error: 'trade_price_ex_gst must be a number >= 0' })
    }
    update.trade_price_ex_gst = v
  }
  if ('b2b_visible' in update) {
    if (typeof update.b2b_visible !== 'boolean') {
      return res.status(400).json({ error: 'b2b_visible must be boolean' })
    }
  }
  if ('description' in update && update.description !== null && typeof update.description !== 'string') {
    return res.status(400).json({ error: 'description must be string or null' })
  }
  if ('primary_image_url' in update && update.primary_image_url !== null && typeof update.primary_image_url !== 'string') {
    return res.status(400).json({ error: 'primary_image_url must be string or null' })
  }
  if ('category_id' in update && update.category_id !== null && typeof update.category_id !== 'string') {
    return res.status(400).json({ error: 'category_id must be uuid string or null' })
  }

  const c = sb()
  const { data, error } = await c
    .from('b2b_catalogue')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return res.status(500).json({ error: error.message })
  }
  if (!data) {
    return res.status(404).json({ error: 'Catalogue item not found' })
  }

  return res.status(200).json({ item: data })
})
