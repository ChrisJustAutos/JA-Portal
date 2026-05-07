// pages/api/b2b/admin/freight-zones.ts
// Admin CRUD for B2B freight zones + their rates.
//
//   GET    /api/b2b/admin/freight-zones                  → list with rates nested
//   POST   /api/b2b/admin/freight-zones                  → create zone (with optional rates[])
//   PATCH  /api/b2b/admin/freight-zones?id=<uuid>        → update zone fields
//   DELETE /api/b2b/admin/freight-zones?id=<uuid>        → delete zone (cascades rates)
//
// Rate management lives in /api/b2b/admin/freight-rates.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { parsePostcodeRanges, type PostcodeRange } from '../../../../lib/b2b-freight'

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

function coerceRanges(input: any): PostcodeRange[] {
  // Accept either a parsed array (from API callers that already structured it)
  // or a string like "4000-4179, 4500" which we parse for them.
  if (typeof input === 'string') return parsePostcodeRanges(input)
  if (Array.isArray(input)) {
    const out: PostcodeRange[] = []
    for (const r of input) {
      if (!r || typeof r !== 'object') continue
      const start = String(r.start || '').padStart(4, '0')
      const end   = String(r.end   || start).padStart(4, '0')
      if (!/^\d{4}$/.test(start) || !/^\d{4}$/.test(end)) {
        throw new Error(`Invalid postcode range: ${JSON.stringify(r)}`)
      }
      if (start > end) throw new Error(`Range start > end: ${start}-${end}`)
      out.push({ start, end })
    }
    return out
  }
  return []
}

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data: zones, error: zErr } = await c
      .from('b2b_freight_zones')
      .select('*')
      .order('sort_order', { ascending: true })
    if (zErr) return res.status(500).json({ error: zErr.message })

    const { data: rates } = await c
      .from('b2b_freight_rates')
      .select('*')
      .order('sort_order', { ascending: true })

    const grouped = (zones || []).map(z => ({
      ...z,
      rates: (rates || []).filter(r => r.zone_id === z.id),
    }))
    return res.status(200).json({ zones: grouped })
  }

  if (req.method === 'POST') {
    const body = (req.body || {}) as Record<string, any>
    const name = String(body.name || '').trim().slice(0, 80)
    if (!name) return res.status(400).json({ error: 'name required' })

    let ranges: PostcodeRange[]
    try { ranges = coerceRanges(body.postcode_ranges) }
    catch (e: any) { return res.status(400).json({ error: e.message }) }

    const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0
    const isActive  = body.is_active !== false

    const { data: zone, error } = await c.from('b2b_freight_zones').insert({
      name,
      postcode_ranges: ranges,
      sort_order: sortOrder,
      is_active: isActive,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })

    // Optional inline rate creation on POST
    if (Array.isArray(body.rates) && body.rates.length > 0) {
      const rateRows = body.rates.map((r: any, i: number) => ({
        zone_id:      zone.id,
        label:        String(r.label || '').trim().slice(0, 80),
        price_ex_gst: Number(r.price_ex_gst) || 0,
        transit_days: r.transit_days != null ? Number(r.transit_days) : null,
        sort_order:   Number.isFinite(Number(r.sort_order)) ? Number(r.sort_order) : i,
        is_active:    r.is_active !== false,
      })).filter((r: any) => !!r.label)
      if (rateRows.length > 0) {
        await c.from('b2b_freight_rates').insert(rateRows)
      }
    }

    return res.status(201).json({ zone })
  }

  const id = String(req.query.id || '').trim()
  if (!id || !UUID_REGEX.test(id)) {
    return res.status(400).json({ error: 'id query param required (UUID)' })
  }

  if (req.method === 'PATCH') {
    const body = (req.body || {}) as Record<string, any>
    const update: Record<string, any> = {}
    if ('name' in body)        update.name = String(body.name || '').trim().slice(0, 80)
    if ('sort_order' in body)  update.sort_order = Number(body.sort_order) || 0
    if ('is_active' in body)   update.is_active = body.is_active !== false
    if ('postcode_ranges' in body) {
      try { update.postcode_ranges = coerceRanges(body.postcode_ranges) }
      catch (e: any) { return res.status(400).json({ error: e.message }) }
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No patchable fields supplied' })
    }
    const { data, error } = await c.from('b2b_freight_zones').update(update).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ zone: data })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('b2b_freight_zones').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
