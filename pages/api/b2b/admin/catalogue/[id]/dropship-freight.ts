// pages/api/b2b/admin/catalogue/[id]/dropship-freight.ts
// Per-zone drop-ship freight for one catalogue item.
//   GET  → { zones: [{ id, name }], rates: { [zone_id]: price_ex_gst } }
//   PUT  { rates: { [zone_id]: number | null } }  → upsert (number) / clear (null/'')
// Prices are ex-GST (GST is added at checkout like all other freight). Reuses the
// existing b2b_freight_zones so zones are defined once in Settings → Freight Zones.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'

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
  if (!id) return res.status(400).json({ error: 'catalogue id required' })

  if (req.method === 'GET') {
    const [{ data: zones, error: zErr }, { data: rates, error: rErr }] = await Promise.all([
      c.from('b2b_freight_zones').select('id, name, sort_order, is_active').eq('is_active', true).order('sort_order', { ascending: true }),
      c.from('b2b_dropship_freight_rates').select('zone_id, price_ex_gst').eq('catalogue_id', id),
    ])
    if (zErr) return res.status(500).json({ error: zErr.message })
    if (rErr) return res.status(500).json({ error: rErr.message })
    const map: Record<string, number> = {}
    for (const r of (rates || []) as any[]) map[r.zone_id] = Number(r.price_ex_gst)
    return res.status(200).json({ zones: (zones || []).map((z: any) => ({ id: z.id, name: z.name })), rates: map })
  }

  if (req.method === 'PUT') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const rates = (body.rates && typeof body.rates === 'object') ? body.rates as Record<string, any> : {}
    const upserts: { catalogue_id: string; zone_id: string; price_ex_gst: number }[] = []
    const deletes: string[] = []
    for (const [zoneId, raw] of Object.entries(rates)) {
      if (raw == null || String(raw).trim() === '') { deletes.push(zoneId); continue }
      const v = Math.round(Number(raw) * 100) / 100
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `Invalid price for zone ${zoneId}` })
      upserts.push({ catalogue_id: id, zone_id: zoneId, price_ex_gst: v })
    }
    if (upserts.length) {
      const { error } = await c.from('b2b_dropship_freight_rates').upsert(upserts, { onConflict: 'catalogue_id,zone_id' })
      if (error) return res.status(500).json({ error: error.message })
    }
    if (deletes.length) {
      const { error } = await c.from('b2b_dropship_freight_rates').delete().eq('catalogue_id', id).in('zone_id', deletes)
      if (error) return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PUT')
  return res.status(405).json({ error: 'GET or PUT only' })
})
