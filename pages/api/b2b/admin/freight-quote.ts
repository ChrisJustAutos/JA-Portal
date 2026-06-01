// pages/api/b2b/admin/freight-quote.ts
// Admin tool: quote live MachShip freight for an arbitrary set of catalogue
// items shipped to a chosen destination — without a distributor cart. Backs
// the "Test freight costs" panel on the admin test-order builder so staff can
// see real carrier rates (markup applied, same as the distributor sees at
// checkout) before placing a test order.
//
// POST { items:[{catalogueId, qty}], distributorId?, postcode?, suburb? }
//   Destination resolution: explicit postcode+suburb win; otherwise the
//   chosen distributor's ship address is used.
// → mirrors /api/b2b/freight-quote response shape: { mode, rates, blocked?, zone? }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import {
  getFreightQuote,
  getLiveQuote,
  type LiveQuoteCartItem,
} from '../../../../lib/b2b-freight'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 30 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const body = (req.body && typeof req.body === 'object') ? req.body : {}

  const items: Array<{ catalogueId: string; qty: number }> = Array.isArray(body.items)
    ? body.items.map((i: any) => ({ catalogueId: String(i.catalogueId || ''), qty: Math.max(1, Math.floor(Number(i.qty) || 0)) })).filter((i: any) => i.catalogueId && i.qty > 0)
    : []
  if (items.length === 0) return res.status(400).json({ error: 'At least one item required' })

  const c = sb()

  // ── Resolve destination ──
  let postcode = String(body.postcode || '').trim()
  let suburb   = String(body.suburb || '').trim()
  const distributorId = String(body.distributorId || '').trim()
  if ((!postcode || !suburb) && distributorId) {
    const { data: dist } = await c
      .from('b2b_distributors')
      .select('ship_suburb, ship_postcode')
      .eq('id', distributorId)
      .maybeSingle()
    if (dist) {
      if (!postcode) postcode = String((dist as any).ship_postcode || '').trim()
      if (!suburb)   suburb   = String((dist as any).ship_suburb   || '').trim()
    }
  }
  if (!postcode) return res.status(400).json({ error: 'Destination postcode required (enter one, or pick a distributor with a ship address)' })

  // ── Load catalogue freight dims for the chosen items ──
  const ids = items.map(i => i.catalogueId)
  const { data: catRows, error: catErr } = await c
    .from('b2b_catalogue')
    .select('id, sku, name, freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging, manual_handling_fee_ex_gst, inbound_freight_cost_ex_gst')
    .in('id', ids)
  if (catErr) return res.status(500).json({ error: catErr.message })
  const catById = new Map((catRows || []).map((r: any) => [r.id, r]))

  const liveItems: LiveQuoteCartItem[] = items.map(it => {
    const cat: any = catById.get(it.catalogueId) || {}
    return {
      sku:               cat.sku || '',
      name:              cat.name || cat.sku || '(item)',
      qty:               it.qty,
      freight_weight_g:  cat.freight_weight_g ?? null,
      freight_length_mm: cat.freight_length_mm ?? null,
      freight_width_mm:  cat.freight_width_mm ?? null,
      freight_height_mm: cat.freight_height_mm ?? null,
      freight_packaging: cat.freight_packaging ?? null,
      manual_handling_fee_ex_gst:  cat.manual_handling_fee_ex_gst ?? null,
      inbound_freight_cost_ex_gst: cat.inbound_freight_cost_ex_gst ?? null,
    }
  })

  // ── Try live MachShip first, then static-zone fallback ──
  const live = await getLiveQuote(liveItems, { suburb, postcode })

  if (live.mode === 'live') {
    return res.status(200).json({
      postcode, suburb: suburb || null, mode: 'live',
      rates: live.rates.map(r => ({
        id: r.id, label: r.label, price_ex_gst: r.price_ex_gst, transit_days: r.transit_days,
        source: 'machship' as const, eta_utc: r.eta_utc,
        base_price_ex_gst: r.base_price_ex_gst, markup_pct: r.markup_pct,
      })),
    })
  }

  if (live.mode === 'blocked') {
    return res.status(200).json({
      postcode, suburb: suburb || null, mode: 'blocked', rates: [],
      blocked: { reason: live.reason, missing: live.missing },
    })
  }

  // live.mode === 'unavailable' → fall back to static postcode zones.
  const stat = await getFreightQuote(postcode)
  if (!stat) {
    return res.status(200).json({
      postcode, suburb: suburb || null, mode: 'no_zone', rates: [],
      unavailable_reason: live.reason,
    })
  }
  return res.status(200).json({
    postcode, suburb: suburb || null, mode: 'static',
    rates: stat.rates.map(r => ({
      id: r.id, label: r.label, price_ex_gst: Number(r.price_ex_gst),
      transit_days: r.transit_days, source: 'static' as const,
    })),
    zone: stat.zone,
    unavailable_reason: live.reason,
  })
})
