// pages/api/b2b/freight-quote.ts
//
// Distributor-facing quote endpoint. Called from the cart whenever
// the chosen shipping address changes — returns the available freight
// rates for the new destination without forcing a full cart reload.
//
//   POST /api/b2b/freight-quote
//     body: { postcode: string, suburb?: string }
//     → {
//         postcode, suburb,
//         mode:    'live' | 'static' | 'blocked' | 'no_zone',
//         rates:   FreightRate[]              // empty when mode is blocked/no_zone
//         blocked? { reason, missing[] }      // present iff mode === 'blocked'
//         zone?:   { id, name }               // present iff mode === 'static'
//       }
//
// Strategy: try MachShip live quoting first. If MachShip returns
// `blocked` (any cart item missing weight/dims), surface that to the
// UI — staff is expected to fill the missing values on the catalogue
// admin page before the distributor can check out. If MachShip is
// `unavailable` (not configured, network error, etc.) we fall back to
// the static postcode-zone rates so checkout still works.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'
import {
  getFreightQuote,
  getLiveQuote,
  type LiveQuoteCartItem,
  type LiveQuoteRate,
} from '../../../lib/b2b-freight'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface ResponseShape {
  postcode: string
  suburb:   string | null
  mode:     'live' | 'static' | 'blocked' | 'no_zone'
  rates:    Array<{
    id: string
    label: string
    price_ex_gst: number
    transit_days: number | null
    source: 'machship' | 'static'
    machship?: LiveQuoteRate['machship']
    eta_utc?: string | null
    base_price_ex_gst?: number
    markup_pct?: number
  }>
  blocked?: { reason: string; missing: Array<{ sku: string; name: string; missing_fields: string[] }> }
  zone?:    { id: string; name: string } | null
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const postcode = String(body.postcode || '').trim()
  const suburb   = body.suburb == null ? null : String(body.suburb).trim() || null
  if (!postcode) return res.status(400).json({ error: 'postcode required' })

  // Pull the distributor's cart items joined to catalogue. The freight
  // columns we need are nullable — that's intentional, and the live
  // quoter flags any missing ones via the 'blocked' mode below.
  const c = sb()
  const { data: cart, error: cartErr } = await c
    .from('b2b_carts')
    .select('id')
    .eq('distributor_user_id', user.id)
    .maybeSingle()
  if (cartErr) return res.status(500).json({ error: cartErr.message })

  const items: LiveQuoteCartItem[] = []
  if (cart?.id) {
    const { data: rows, error: itemsErr } = await c
      .from('b2b_cart_items')
      .select(`
        qty,
        catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
          sku, name,
          freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging,
          manual_handling_fee_ex_gst, inbound_freight_cost_ex_gst
        )
      `)
      .eq('cart_id', cart.id)
    if (itemsErr) return res.status(500).json({ error: itemsErr.message })
    for (const r of (rows || []) as any[]) {
      const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
      if (!cat) continue
      items.push({
        sku:               cat.sku || '',
        name:              cat.name || cat.sku || '(item)',
        qty:               Number(r.qty || 0),
        freight_weight_g:  cat.freight_weight_g ?? null,
        freight_length_mm: cat.freight_length_mm ?? null,
        freight_width_mm:  cat.freight_width_mm ?? null,
        freight_height_mm: cat.freight_height_mm ?? null,
        freight_packaging: cat.freight_packaging ?? null,
        manual_handling_fee_ex_gst:  cat.manual_handling_fee_ex_gst ?? null,
        inbound_freight_cost_ex_gst: cat.inbound_freight_cost_ex_gst ?? null,
      })
    }
  }

  // ── Try live MachShip first ──
  const dest = { suburb: suburb || '', postcode }
  const live = await getLiveQuote(items, dest)

  if (live.mode === 'live') {
    const out: ResponseShape = {
      postcode, suburb,
      mode: 'live',
      rates: live.rates.map(r => ({
        id: r.id,
        label: r.label,
        price_ex_gst: r.price_ex_gst,
        transit_days: r.transit_days,
        source: 'machship' as const,
        machship: r.machship,
        eta_utc: r.eta_utc,
        base_price_ex_gst: r.base_price_ex_gst,
        markup_pct: r.markup_pct,
      })),
    }
    return res.status(200).json(out)
  }

  if (live.mode === 'blocked') {
    const out: ResponseShape = {
      postcode, suburb,
      mode: 'blocked',
      rates: [],
      blocked: { reason: live.reason, missing: live.missing },
    }
    return res.status(200).json(out)
  }

  // ── Fall back to static postcode zones ──
  const stat = await getFreightQuote(postcode)
  if (!stat) {
    return res.status(200).json({
      postcode, suburb,
      mode: 'no_zone',
      rates: [],
    } as ResponseShape)
  }
  const out: ResponseShape = {
    postcode, suburb,
    mode: 'static',
    rates: stat.rates.map(r => ({
      id: r.id,
      label: r.label,
      price_ex_gst: Number(r.price_ex_gst),
      transit_days: r.transit_days,
      source: 'static' as const,
    })),
    zone: stat.zone,
  }
  return res.status(200).json(out)
})
