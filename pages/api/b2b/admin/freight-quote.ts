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
  getSatchelRates,
  getDropshipFreight,
  type LiveQuoteCartItem,
  type DropshipFreightItem,
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
    .select('id, sku, name, is_drop_ship, freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging, manual_handling, inbound_freight_cost_ex_gst')
    .in('id', ids)
  if (catErr) return res.status(500).json({ error: catErr.message })
  const catById = new Map((catRows || []).map((r: any) => [r.id, r]))

  // Stock items feed MachShip/satchel; drop-ship items are priced separately by zone.
  const liveItems: LiveQuoteCartItem[] = items
    .filter(it => (catById.get(it.catalogueId) as any)?.is_drop_ship !== true)
    .map(it => {
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
        manual_handling:             cat.manual_handling === true,
        inbound_freight_cost_ex_gst: cat.inbound_freight_cost_ex_gst ?? null,
      }
    })
  const dsItems: DropshipFreightItem[] = items
    .filter(it => (catById.get(it.catalogueId) as any)?.is_drop_ship === true)
    .map(it => {
      const cat: any = catById.get(it.catalogueId) || {}
      return { catalogue_id: it.catalogueId, sku: cat.sku || '', name: cat.name || cat.sku || '(item)', qty: it.qty, is_drop_ship: true }
    })
  const dropship = await getDropshipFreight(dsItems, postcode)
  if (dropship.missing.length > 0) {
    return res.status(200).json({
      postcode, suburb: suburb || null, mode: 'blocked', rates: [],
      blocked: { reason: `Drop-ship freight not set for ${dropship.missing.length} item(s) to this destination`, missing: dropship.missing.map(m => ({ sku: m.sku, name: m.name, missing_fields: [m.reason] })) },
    })
  }
  const dsFreight = dropship.total_ex_gst

  // ── Quote: live MachShip, then static fallback, plus flat-rate satchels ──
  const pm = String(body.packMode || '').trim()
  const packMode = (pm === 'pallet' || pm === 'cartons' || pm === 'auto') ? pm as any : undefined
  const [live, satchels] = await Promise.all([
    getLiveQuote(liveItems, { suburb, postcode }, { packMode }),
    getSatchelRates(liveItems.map(it => ({
      qty: it.qty, weight_g: it.freight_weight_g, length_mm: it.freight_length_mm,
      width_mm: it.freight_width_mm, height_mm: it.freight_height_mm, packaging: it.freight_packaging,
    })), { packMode }),
  ])
  const satchelRates = satchels.map(s => ({
    id: s.id, label: s.label, price_ex_gst: s.price_ex_gst, transit_days: s.transit_days,
    source: 'satchel' as const,
  }))

  type Rate = { id: string; label: string; price_ex_gst: number; transit_days: number | null; source: 'machship' | 'static' | 'satchel' | 'dropship'; eta_utc?: string | null; base_price_ex_gst?: number; markup_pct?: number }
  let baseRates: Rate[] = []
  let baseMode: 'live' | 'static' | 'blocked' | 'no_zone'
  let zone: { id: string; name: string } | null = null
  let unavailableReason: string | null = null
  if (live.mode === 'live') {
    baseMode = 'live'
    baseRates = live.rates.map(r => ({
      id: r.id, label: r.label, price_ex_gst: r.price_ex_gst, transit_days: r.transit_days,
      source: 'machship' as const, eta_utc: r.eta_utc,
      base_price_ex_gst: r.base_price_ex_gst, markup_pct: r.markup_pct,
    }))
  } else if (live.mode === 'blocked') {
    baseMode = 'blocked'
  } else {
    unavailableReason = live.reason
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

  // Fold drop-ship freight into every stock rate (single freight figure).
  const r2 = (n: number) => Math.round(n * 100) / 100
  let combined: Rate[] = [...baseRates, ...satchelRates]
  if (dsFreight > 0) combined = combined.map(r => ({ ...r, price_ex_gst: r2(r.price_ex_gst + dsFreight) }))
  combined.sort((a, b) => a.price_ex_gst - b.price_ex_gst)

  // Only drop-ship items → offer the drop-ship freight as the single option.
  if (combined.length === 0 && dsFreight > 0 && liveItems.length === 0) {
    return res.status(200).json({
      postcode, suburb: suburb || null, mode: 'static',
      rates: [{ id: 'dropship', label: `Shipping${dropship.zone ? ` — ${dropship.zone.name}` : ''}`, price_ex_gst: dsFreight, transit_days: null, source: 'dropship' as const }],
      zone, dropship_freight_ex_gst: dsFreight,
    })
  }

  if (combined.length > 0) {
    return res.status(200).json({
      postcode, suburb: suburb || null,
      mode: baseMode === 'live' ? 'live' : 'static',
      rates: combined, zone,
      dropship_freight_ex_gst: dsFreight > 0 ? dsFreight : undefined,
      ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
    })
  }
  if (baseMode === 'blocked') {
    return res.status(200).json({
      postcode, suburb: suburb || null, mode: 'blocked', rates: [],
      blocked: { reason: (live as any).reason, missing: (live as any).missing },
    })
  }
  return res.status(200).json({
    postcode, suburb: suburb || null, mode: 'no_zone', rates: [],
    unavailable_reason: unavailableReason,
  })
})
