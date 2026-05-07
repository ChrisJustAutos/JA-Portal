// pages/api/b2b/admin/freight-rates.ts
// Admin CRUD for individual freight rates within a zone. Zones live in
// /api/b2b/admin/freight-zones; rates live here.
//
//   POST   /api/b2b/admin/freight-rates                  → create rate (body needs zone_id)
//   PATCH  /api/b2b/admin/freight-rates?id=<uuid>        → update rate
//   DELETE /api/b2b/admin/freight-rates?id=<uuid>        → delete rate

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PATCHABLE = new Set([
  'label', 'price_ex_gst', 'transit_days', 'sort_order', 'is_active',
])

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'POST') {
    const body = (req.body || {}) as Record<string, any>
    const zoneId = String(body.zone_id || '').trim()
    if (!UUID_REGEX.test(zoneId)) return res.status(400).json({ error: 'zone_id must be a UUID' })
    const label = String(body.label || '').trim().slice(0, 80)
    if (!label) return res.status(400).json({ error: 'label required' })
    const price = Number(body.price_ex_gst)
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'price_ex_gst must be >= 0' })

    const { data, error } = await c.from('b2b_freight_rates').insert({
      zone_id: zoneId,
      label,
      price_ex_gst: price,
      transit_days: body.transit_days != null ? Number(body.transit_days) : null,
      sort_order:   Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
      is_active:    body.is_active !== false,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ rate: data })
  }

  const id = String(req.query.id || '').trim()
  if (!id || !UUID_REGEX.test(id)) {
    return res.status(400).json({ error: 'id query param required (UUID)' })
  }

  if (req.method === 'PATCH') {
    const body = (req.body || {}) as Record<string, any>
    const update: Record<string, any> = {}
    for (const k of Object.keys(body)) {
      if (PATCHABLE.has(k)) update[k] = body[k]
    }
    if ('price_ex_gst' in update) {
      const n = Number(update.price_ex_gst)
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'price_ex_gst must be >= 0' })
      update.price_ex_gst = n
    }
    if ('transit_days' in update && update.transit_days != null) {
      update.transit_days = Number(update.transit_days)
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No patchable fields supplied' })
    }
    const { data, error } = await c.from('b2b_freight_rates').update(update).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ rate: data })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('b2b_freight_rates').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
