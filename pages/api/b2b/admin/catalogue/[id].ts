// pages/api/b2b/admin/catalogue/[id].ts
// PATCH /api/b2b/admin/catalogue/{id}
//
// Editable fields:
//   - trade_price_ex_gst                  number, >= 0
//   - b2b_visible                         boolean
//   - description                         string | null
//   - primary_image_url                   string | null
//   - model_id                            uuid | null
//   - product_type_id                     uuid | null
//   - barcode                             string | null
//   - max_order_qty                       int >= 1 | null
//   - freight_length_mm/width_mm/height_mm int >= 0 | null
//   - freight_weight_g                    int >= 0 | null
//   - freight_packaging                   'box' | 'pallet' | 'other' | null
//   - is_special_order                    boolean
//   - is_drop_ship                        boolean
//   - call_for_availability_below_qty     int >= 0 | null
//   - call_for_availability_when_zero     boolean
//   - instructions_url                    string | null
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
  'model_id',
  'product_type_id',
  'barcode',
  'max_order_qty',
  'freight_length_mm',
  'freight_width_mm',
  'freight_height_mm',
  'freight_weight_g',
  'freight_packaging',
  'is_special_order',
  'is_drop_ship',
  'call_for_availability_below_qty',
  'call_for_availability_when_zero',
  'instructions_url',
] as const

const NULLABLE_STRING_FIELDS = ['description', 'primary_image_url', 'barcode', 'instructions_url'] as const
const NULLABLE_INT_FIELDS = [
  'max_order_qty',
  'freight_length_mm', 'freight_width_mm', 'freight_height_mm', 'freight_weight_g',
  'call_for_availability_below_qty',
] as const
const BOOLEAN_FIELDS = ['b2b_visible', 'is_special_order', 'is_drop_ship', 'call_for_availability_when_zero'] as const
const PACKAGING_VALUES = ['box', 'pallet', 'other'] as const

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH')
    return res.status(405).json({ error: 'PATCH only' })
  }

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing id' })

  const body = (req.body && typeof req.body === 'object') ? req.body : {}

  // Build update object from allow-list. Unknown fields are ignored.
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
  for (const k of BOOLEAN_FIELDS) {
    if (k in update && typeof update[k] !== 'boolean') {
      return res.status(400).json({ error: `${k} must be boolean` })
    }
  }
  for (const k of NULLABLE_STRING_FIELDS) {
    if (k in update && update[k] !== null && typeof update[k] !== 'string') {
      return res.status(400).json({ error: `${k} must be string or null` })
    }
    // Coerce empty strings to null so the column stays clean
    if (k in update && update[k] === '') update[k] = null
  }
  if ('model_id' in update && update.model_id !== null && typeof update.model_id !== 'string') {
    return res.status(400).json({ error: 'model_id must be uuid string or null' })
  }
  if ('product_type_id' in update && update.product_type_id !== null && typeof update.product_type_id !== 'string') {
    return res.status(400).json({ error: 'product_type_id must be uuid string or null' })
  }
  for (const k of NULLABLE_INT_FIELDS) {
    if (k in update) {
      const raw = update[k]
      if (raw === null || raw === '') {
        update[k] = null
      } else {
        const v = Number(raw)
        if (!Number.isInteger(v) || v < 0) {
          return res.status(400).json({ error: `${k} must be a non-negative integer or null` })
        }
        if (k === 'max_order_qty' && v < 1) {
          return res.status(400).json({ error: 'max_order_qty must be >= 1 or null' })
        }
        update[k] = v
      }
    }
  }
  if ('freight_packaging' in update) {
    const v = update.freight_packaging
    if (v === null || v === '') {
      update.freight_packaging = null
    } else if (typeof v !== 'string' || !(PACKAGING_VALUES as readonly string[]).includes(v)) {
      return res.status(400).json({ error: `freight_packaging must be one of ${PACKAGING_VALUES.join(', ')} or null` })
    }
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
