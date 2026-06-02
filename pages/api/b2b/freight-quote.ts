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
  getSatchelRates,
  getDropshipFreight,
  type LiveQuoteCartItem,
  type LiveQuoteRate,
  type DropshipFreightItem,
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
    source: 'machship' | 'static' | 'satchel' | 'dropship'
    machship?: LiveQuoteRate['machship']
    eta_utc?: string | null
    base_price_ex_gst?: number
    markup_pct?: number
  }>
  blocked?: { reason: string; missing: Array<{ sku: string; name: string; missing_fields: string[] }> }
  zone?:    { id: string; name: string } | null
  // Drop-ship freight (supplier-shipped items), already folded into the rate
  // prices above; surfaced separately for transparency.
  dropship_freight_ex_gst?: number
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

  // Stock (warehouse-shipped) items feed the MachShip/satchel quote; drop-ship
  // items are excluded from it and priced separately by zone.
  const items: LiveQuoteCartItem[] = []
  const dsItems: DropshipFreightItem[] = []
  if (cart?.id) {
    const { data: rows, error: itemsErr } = await c
      .from('b2b_cart_items')
      .select(`
        qty,
        catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
          id, sku, name, is_drop_ship,
          freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging,
          manual_handling, inbound_freight_cost_ex_gst
        )
      `)
      .eq('cart_id', cart.id)
    if (itemsErr) return res.status(500).json({ error: itemsErr.message })
    for (const r of (rows || []) as any[]) {
      const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
      if (!cat) continue
      const qty = Number(r.qty || 0)
      if (cat.is_drop_ship === true) {
        dsItems.push({ catalogue_id: cat.id, sku: cat.sku || '', name: cat.name || cat.sku || '(item)', qty, is_drop_ship: true })
        continue
      }
      items.push({
        sku:               cat.sku || '',
        name:              cat.name || cat.sku || '(item)',
        qty,
        freight_weight_g:  cat.freight_weight_g ?? null,
        freight_length_mm: cat.freight_length_mm ?? null,
        freight_width_mm:  cat.freight_width_mm ?? null,
        freight_height_mm: cat.freight_height_mm ?? null,
        freight_packaging: cat.freight_packaging ?? null,
        manual_handling:             cat.manual_handling === true,
        inbound_freight_cost_ex_gst: cat.inbound_freight_cost_ex_gst ?? null,
      })
    }
  }

  // Drop-ship freight (per zone). If a drop-ship item has no price for the
  // destination, block — same UX as a stock item missing dimensions.
  const dropship = await getDropshipFreight(dsItems, postcode)
  if (dropship.missing.length > 0) {
    return res.status(200).json({
      postcode, suburb, mode: 'blocked', rates: [],
      blocked: {
        reason: `Drop-ship freight isn’t set for ${dropship.missing.length} item${dropship.missing.length === 1 ? '' : 's'} to this destination`,
        missing: dropship.missing.map(m => ({ sku: m.sku, name: m.name, missing_fields: [m.reason] })),
      },
    } as ResponseShape)
  }
  const dsFreight = dropship.total_ex_gst

  // ── Quote: live MachShip, then static fallback, plus flat-rate satchels ──
  // Satchels are computed independently (weight-gated, flat anywhere) and merged
  // into whatever carrier/static rates we have — so a light order still gets the
  // cheap satchel even if live quoting is blocked on missing dimensions.
  const dest = { suburb: suburb || '', postcode }
  const [live, satchels] = await Promise.all([
    getLiveQuote(items, dest),
    getSatchelRates(items.map(it => ({
      qty: it.qty, weight_g: it.freight_weight_g, length_mm: it.freight_length_mm,
      width_mm: it.freight_width_mm, height_mm: it.freight_height_mm, packaging: it.freight_packaging,
    }))),
  ])
  const satchelRates: ResponseShape['rates'] = satchels.map(s => ({
    id: s.id, label: s.label, price_ex_gst: s.price_ex_gst, transit_days: s.transit_days,
    source: 'satchel' as const,
  }))

  // Assemble the carrier/static base.
  let baseRates: ResponseShape['rates'] = []
  let baseMode: 'live' | 'static' | 'blocked' | 'no_zone'
  let zone: { id: string; name: string } | null = null
  let blocked: ResponseShape['blocked'] | undefined
  if (live.mode === 'live') {
    baseMode = 'live'
    baseRates = live.rates.map(r => ({
      id: r.id, label: r.label, price_ex_gst: r.price_ex_gst, transit_days: r.transit_days,
      source: 'machship' as const, machship: r.machship, eta_utc: r.eta_utc,
      base_price_ex_gst: r.base_price_ex_gst, markup_pct: r.markup_pct,
    }))
  } else if (live.mode === 'blocked') {
    baseMode = 'blocked'
    blocked = { reason: live.reason, missing: live.missing }
  } else {
    const stat = await getFreightQuote(postcode)
    if (stat) {
      baseMode = 'static'
      zone = stat.zone
      baseRates = stat.rates.map(r => ({
        id: r.id, label: r.label, price_ex_gst: Number(r.price_ex_gst),
        transit_days: r.transit_days, source: 'static' as const,
      }))
    } else {
      baseMode = 'no_zone'
    }
  }

  // Fold drop-ship freight into every stock rate so the customer sees a single
  // freight figure (warehouse shipping + supplier shipping combined).
  const r2 = (n: number) => Math.round(n * 100) / 100
  let combined = [...baseRates, ...satchelRates]
  if (dsFreight > 0) combined = combined.map(r => ({ ...r, price_ex_gst: r2(r.price_ex_gst + dsFreight) }))
  combined.sort((a, b) => a.price_ex_gst - b.price_ex_gst)

  // Cart is all drop-ship (nothing ships from the warehouse) → offer the
  // drop-ship freight itself as the single shipping option.
  if (combined.length === 0 && dsFreight > 0 && items.length === 0) {
    return res.status(200).json({
      postcode, suburb, mode: 'static',
      rates: [{ id: 'dropship', label: `Shipping${dropship.zone ? ` — ${dropship.zone.name}` : ''}`, price_ex_gst: dsFreight, transit_days: null, source: 'dropship' as const }],
      zone, dropship_freight_ex_gst: dsFreight,
    } as ResponseShape)
  }

  // If satchels/rates rescued an otherwise blocked/zoneless cart, present a normal
  // pickable quote (flat rate → EST badge).
  if (combined.length > 0) {
    return res.status(200).json({
      postcode, suburb,
      mode: baseMode === 'live' ? 'live' : 'static',
      rates: combined,
      zone,
      dropship_freight_ex_gst: dsFreight > 0 ? dsFreight : undefined,
    } as ResponseShape)
  }

  if (baseMode === 'blocked') {
    return res.status(200).json({ postcode, suburb, mode: 'blocked', rates: [], blocked } as ResponseShape)
  }
  return res.status(200).json({ postcode, suburb, mode: 'no_zone', rates: [] } as ResponseShape)
})
