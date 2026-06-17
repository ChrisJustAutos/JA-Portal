// pages/api/b2b/checkout/start.ts
//
// POST /api/b2b/checkout/start
//   body: { customer_po?: string }
//
// Creates a b2b_orders row in 'pending_payment' status, snapshots cart
// lines into b2b_order_lines, then opens a Stripe Checkout Session.
// Returns the Stripe URL the client should redirect the browser to.
//
// Stale-cart protection: validates each line at checkout time:
//   - item still b2b_visible
//   - trade_price_ex_gst > 0
//   - if inventoried: qty <= qty_available (using cached stock)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'
import { getStockForItems, stockState, getCommittedQtyByCatalogue, availableQty } from '../../../../lib/b2b-stock'
import { applyPricing, effectiveQtyCap } from '../../../../lib/b2b-pricing'
import { createCheckoutSession, StripeLineItem } from '../../../../lib/stripe'
import { paytoSurchargeInc } from '../../../../lib/b2b-payment'
import { assertCheckoutConfigured } from '../../../../lib/b2b-settings'
import { getLiveQuote, getSatchelRates, getDropshipFreight, type LiveQuoteCartItem } from '../../../../lib/b2b-freight'
import { loadBundleChildren, bundleChildUnitPriceExGst } from '../../../../lib/b2b-bundles'
import { resolveOverLimit, lineShipsFromSupplier } from '../../../../lib/b2b-over-limit'

const GST_RATE = 0.10

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  // Parse PO from request body. Optional, max 20 chars (MYOB limit).
  // Also parse freight selection — either a static-zone rate id or a
  // live MachShip route. The two are mutually exclusive; freight_rate_id
  // is preserved for the static-fallback path.
  let customerPo: string | null = null
  let paymentMethod: 'card' | 'becs' | 'payto' = 'card'
  let chosenFreightRateId: string | null = null
  let chosenSatchelId: string | null = null
  let chosenMachShipRoute: {
    carrierId: number
    carrierServiceId: number
    companyCarrierAccountId?: number
  } | null = null
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (typeof body.customer_po === 'string') {
      customerPo = body.customer_po.trim().substring(0, 20) || null
    }
    if (body.payment_method === 'becs' || body.payment_method === 'payto') {
      paymentMethod = body.payment_method
    }
    if (typeof body.freight_rate_id === 'string' && body.freight_rate_id.trim()) {
      chosenFreightRateId = body.freight_rate_id.trim()
    }
    // Flat-rate satchel: the cart submits the bare uuid (it strips the
    // `satchel:` prefix from the synthetic rate id).
    if (typeof body.freight_satchel_id === 'string' && body.freight_satchel_id.trim()) {
      chosenSatchelId = body.freight_satchel_id.trim().replace(/^satchel:/, '')
    }
    const fr = body.freight_machship_route
    if (fr && typeof fr === 'object' && Number.isFinite(Number(fr.carrierId)) && Number.isFinite(Number(fr.carrierServiceId))) {
      chosenMachShipRoute = {
        carrierId:               Number(fr.carrierId),
        carrierServiceId:        Number(fr.carrierServiceId),
        companyCarrierAccountId: Number.isFinite(Number(fr.companyCarrierAccountId)) ? Number(fr.companyCarrierAccountId) : undefined,
      }
    }
  } catch {
    // Bad JSON in body — ignore, treat as no PO / no freight
  }
  // Purchase order is REQUIRED on every B2B order.
  if (!customerPo) {
    return res.status(400).json({ error: 'A purchase order number is required to place this order.' })
  }
  if ([chosenFreightRateId, chosenSatchelId, chosenMachShipRoute].filter(Boolean).length > 1) {
    return res.status(400).json({ error: 'Pick a single freight option (rate, satchel, or carrier route).' })
  }

  // Verify Stripe + MYOB are configured before we charge anyone.
  let cfg
  try {
    cfg = await assertCheckoutConfigured()
  } catch (e: any) {
    return res.status(503).json({
      error: 'Checkout temporarily unavailable. Please contact your account manager.',
      detail: e?.message,
    })
  }

  const c = sb()

  // 1. Load cart with lines + catalogue snapshots
  const { data: cart } = await c
    .from('b2b_carts')
    .select('id')
    .eq('distributor_user_id', user.id)
    .maybeSingle()
  if (!cart) return res.status(400).json({ error: 'Your cart is empty' })

  const { data: lines, error: linesErr } = await c
    .from('b2b_cart_items')
    .select(`
      id, qty,
      catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
        id, myob_item_uid, sku, name,
        trade_price_ex_gst, is_taxable, b2b_visible, is_drop_ship,
        promo_price_ex_gst, promo_starts_at, promo_ends_at, volume_breaks,
        max_order_qty, over_limit_qty, over_limit_action
      )
    `)
    .eq('cart_id', cart.id)
    .order('added_at', { ascending: true })
  if (linesErr) return res.status(500).json({ error: linesErr.message })
  if (!lines || lines.length === 0) return res.status(400).json({ error: 'Your cart is empty' })

  // 2. Validate each line + pull current stock + compute effective price
  type RawLine = {
    cartItemId: string
    catalogueId: string
    myobItemUid: string | null
    sku: string
    name: string
    qty: number
    unitPriceEx: number     // effective price (promo + volume break applied)
    tradePriceEx: number    // for reference / order_lines snapshot
    maxOrderQty: number | null
    isTaxable: boolean
    isDropShip: boolean
    // Set when this line is an auto-included bundle component (child of a
    // parent line). Null for normal parent / standalone lines. Persisted on
    // the order line + used to exclude the line from the freight parcel build.
    bundleParentCatalogueId: string | null
  }
  const validated: RawLine[] = []
  const issues: string[] = []
  const now = new Date()

  for (const ln of lines) {
    const cat: any = Array.isArray(ln.catalogue) ? ln.catalogue[0] : ln.catalogue
    if (!cat) {
      issues.push(`A cart item references a removed catalogue entry — please refresh your cart`)
      continue
    }
    if (!cat.b2b_visible) {
      issues.push(`"${cat.name}" is no longer available — please remove it from your cart`)
      continue
    }
    const tradePrice = Number(cat.trade_price_ex_gst || 0)
    if (tradePrice <= 0) {
      issues.push(`"${cat.name}" has no price set — please remove it from your cart`)
      continue
    }
    if (!cat.myob_item_uid) {
      issues.push(`"${cat.name}" is missing a MYOB link — please contact your account manager`)
      continue
    }
    if (ln.qty <= 0) continue
    const maxOrderQty = cat.max_order_qty != null ? Number(cat.max_order_qty) : null
    if (maxOrderQty != null && ln.qty > maxOrderQty) {
      issues.push(`"${cat.name}" — max ${maxOrderQty} per order (cart has ${ln.qty})`)
      continue
    }
    // Large-order handling. Over the soft threshold, a 'quote' item can't
    // self-checkout (blocks the whole order); a 'dropship' item is fulfilled
    // from the supplier for this order.
    const overLimit = resolveOverLimit(cat, ln.qty)
    if (overLimit.triggered && overLimit.action === 'quote') {
      issues.push(`"${cat.name}" — over ${overLimit.threshold} units needs a quote. Use “Request a quote” in your cart for this item.`)
      continue
    }
    const shipsFromSupplier = lineShipsFromSupplier(cat, ln.qty)
    const px = applyPricing({
      trade_price_ex_gst: tradePrice,
      promo_price_ex_gst: cat.promo_price_ex_gst != null ? Number(cat.promo_price_ex_gst) : null,
      promo_starts_at:    cat.promo_starts_at,
      promo_ends_at:      cat.promo_ends_at,
      volume_breaks:      Array.isArray(cat.volume_breaks) ? cat.volume_breaks : [],
    }, ln.qty, now)
    validated.push({
      cartItemId:   ln.id,
      catalogueId:  cat.id,
      myobItemUid:  cat.myob_item_uid,
      sku:          cat.sku,
      name:         cat.name,
      qty:          ln.qty,
      unitPriceEx:  px.unit_price_ex_gst,
      tradePriceEx: tradePrice,
      maxOrderQty,
      isTaxable:    cat.is_taxable !== false,
      isDropShip:   shipsFromSupplier,
      bundleParentCatalogueId: null,
    })
  }

  if (validated.length === 0) {
    return res.status(400).json({
      error: 'No valid items in your cart',
      details: issues,
    })
  }

  // Explode "includes" bundles: each parent line auto-adds its child products
  // as derived order lines (not stored in the cart). 'included' children post
  // at $0 (value baked into the parent); 'added' children charge their own
  // trade price. Children still get their own MYOB line so inventory
  // decrements. They're excluded from the freight quote — the parent carries
  // the combined-carton dims. One level only (children aren't re-exploded).
  try {
    const parentIds = validated.map(v => v.catalogueId)
    const bundleMap = await loadBundleChildren(c, parentIds)
    const components: RawLine[] = []
    for (const parent of validated) {
      const children = bundleMap.get(parent.catalogueId)
      if (!children || children.length === 0) continue
      for (const ch of children) {
        if (!ch.child.myob_item_uid) {
          issues.push(`"${parent.name}" includes "${ch.child.name || ch.child.sku || 'a part'}" which is missing a MYOB link — contact your account manager`)
          continue
        }
        components.push({
          cartItemId:   parent.cartItemId,   // provenance only; not a real cart row
          catalogueId:  ch.child_catalogue_id,
          myobItemUid:  ch.child.myob_item_uid,
          sku:          ch.child.sku || '',
          name:         ch.child.name || ch.child.sku || '(item)',
          qty:          parent.qty * ch.qty,
          unitPriceEx:  bundleChildUnitPriceExGst(ch),
          tradePriceEx: Number(ch.child.trade_price_ex_gst || 0),
          maxOrderQty:  null,
          isTaxable:    ch.child.is_taxable !== false,
          isDropShip:   ch.child.is_drop_ship === true,
          bundleParentCatalogueId: parent.catalogueId,
        })
      }
    }
    if (issues.length > 0) {
      return res.status(409).json({ error: 'Some items in your cart need attention', details: issues })
    }
    // Append components after their parents (sort_order keeps them grouped).
    validated.push(...components)
  } catch (e: any) {
    return res.status(500).json({ error: `Bundle expansion failed: ${e?.message || e}` })
  }

  // Stock check (cached + auto-refresh) — and deduct in-flight commitments
  // so two distributors can't both claim the last 10 units while one of
  // them already has them on a pending_payment order.
  let stockMap: Record<string, any> = {}
  let committed: Record<string, number> = {}
  try {
    [stockMap, committed] = await Promise.all([
      getStockForItems(validated.map(v => v.myobItemUid!).filter(Boolean) as string[]),
      getCommittedQtyByCatalogue(validated.map(v => v.catalogueId)),
    ])
  } catch (e) {
    return res.status(503).json({
      error: 'Live stock check failed — please try again in a moment',
    })
  }
  for (const v of validated) {
    // Drop-ship lines (incl. over-limit drop-ship) are fulfilled by the
    // supplier — they're not constrained by our warehouse stock.
    if (v.isDropShip) continue
    const s = stockMap[v.myobItemUid!]
    const avail = availableQty(s, committed[v.catalogueId] || 0)
    if (avail !== null && v.qty > avail) {
      if (avail === 0) {
        issues.push(`"${v.name}" is out of stock — please remove it`)
      } else {
        issues.push(`"${v.name}" — only ${avail} available, you have ${v.qty} in your cart`)
      }
    } else if (s && stockState(s) === 'out_of_stock') {
      issues.push(`"${v.name}" is out of stock — please remove it`)
    }
  }
  if (issues.length > 0) {
    return res.status(409).json({
      error: 'Some items in your cart need attention',
      details: issues,
    })
  }

  // 3. Compute totals
  let subtotalEx = 0
  let gst = 0
  for (const v of validated) {
    const lineEx = v.unitPriceEx * v.qty
    subtotalEx += lineEx
    if (v.isTaxable) gst += lineEx * GST_RATE
  }

  // Resolve freight rate (if any) and fold its ex-GST cost into the
  // subtotal. Freight is GST-applicable; we add the GST onto the running
  // total like any other line. If the selection is unknown / inactive
  // / no longer offered by MachShip, refuse the checkout — better than
  // silently posting without freight.
  let freightExGst = 0
  let freightLabel: string | null = null
  let freightZoneId: string | null = null
  let freightSatchelId: string | null = null
  // MachShip extras — populated only when chosenMachShipRoute is set.
  let freightMachShipCarrierId:     number | null = null
  let freightMachShipServiceId:     number | null = null
  let freightChosenQuoteSnapshot:   any            = null
  let freightQuoteMarkupPct:        number | null = null

  if (chosenFreightRateId) {
    const { data: rate, error: rErr } = await c
      .from('b2b_freight_rates')
      .select('id, label, price_ex_gst, is_active, zone_id, b2b_freight_zones!inner(id, name, is_active)')
      .eq('id', chosenFreightRateId)
      .maybeSingle()
    if (rErr) return res.status(500).json({ error: rErr.message })
    if (!rate || !rate.is_active) {
      return res.status(400).json({ error: 'Selected freight rate is not available — refresh the cart and pick again.' })
    }
    const zone: any = Array.isArray(rate.b2b_freight_zones) ? rate.b2b_freight_zones[0] : rate.b2b_freight_zones
    if (!zone || !zone.is_active) {
      return res.status(400).json({ error: 'Freight zone for the selected rate is no longer active.' })
    }
    freightExGst = round2(Number(rate.price_ex_gst) || 0)
    freightLabel = `${zone.name} — ${rate.label}`
    freightZoneId = zone.id
    subtotalEx += freightExGst
    gst += freightExGst * GST_RATE  // freight is taxable
  } else if (chosenSatchelId) {
    // Flat-rate satchel. Re-run the exact same eligibility gate the quote used
    // (active + weight under cap + items fit the satchel size) so a stale or
    // tampered selection can't slip through. The distributor pays the satchel's
    // sell price; ships manually (no MachShip consignment).
    const { data: sRows, error: sErr } = await c
      .from('b2b_cart_items')
      .select(`qty, catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey ( is_drop_ship, over_limit_qty, over_limit_action, freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging )`)
      .eq('cart_id', cart.id)
    if (sErr) return res.status(500).json({ error: sErr.message })
    const eligItems = (sRows || []).map((r: any) => {
      const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
      return {
        qty: Number(r.qty || 0),
        weight_g: cat?.freight_weight_g ?? null,
        length_mm: cat?.freight_length_mm ?? null,
        width_mm: cat?.freight_width_mm ?? null,
        height_mm: cat?.freight_height_mm ?? null,
        packaging: cat?.freight_packaging ?? null,
        // Supplier-shipped lines (incl. over-limit drop-ship) don't go in a satchel.
        is_drop_ship: cat ? lineShipsFromSupplier(cat, Number(r.qty || 0)) : false,
      }
    }).filter((i: any) => !i.is_drop_ship)
    const eligible = await getSatchelRates(eligItems)
    const match = eligible.find(e => e.satchel_id === chosenSatchelId)
    if (!match) {
      return res.status(400).json({ error: 'This order no longer fits the selected satchel — refresh the cart and pick again.' })
    }
    freightExGst = round2(match.price_ex_gst)
    freightLabel = match.label
    freightSatchelId = match.satchel_id
    freightChosenQuoteSnapshot = {
      type: 'satchel',
      satchel_id: match.satchel_id,
      name: match.label,
      sell_ex_gst: round2(match.price_ex_gst),
      cost_ex_gst: round2(match.cost_ex_gst),
    }
    subtotalEx += freightExGst
    gst += freightExGst * GST_RATE
  } else if (chosenMachShipRoute) {
    // Re-quote server-side so the distributor pays the live price the
    // server computes — not whatever the cart UI submitted. If the
    // carrier+service the user chose is no longer available, refuse.
    // We need the destination address + per-item freight dims, which
    // means a second cart lookup (the earlier `lines` query doesn't
    // include freight columns).
    const { data: dist } = await c
      .from('b2b_distributors')
      .select('ship_postcode, ship_suburb, bill_postcode, bill_suburb')
      .eq('id', user.distributor.id)
      .maybeSingle()
    const shipPostcode = dist?.ship_postcode || dist?.bill_postcode
    const shipSuburb   = dist?.ship_suburb   || dist?.bill_suburb || ''
    if (!shipPostcode) {
      return res.status(400).json({ error: 'Live freight needs a shipping address on file — contact your account manager.' })
    }

    const { data: liveRows, error: liErr } = await c
      .from('b2b_cart_items')
      .select(`
        qty,
        catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
          sku, name, is_drop_ship, over_limit_qty, over_limit_action,
          freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging,
          manual_handling, inbound_freight_cost_ex_gst
        )
      `)
      .eq('cart_id', cart.id)
    if (liErr) return res.status(500).json({ error: liErr.message })
    const liveItems: LiveQuoteCartItem[] = (liveRows || [])
      .map((r: any) => {
        const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
        return { r, cat }
      })
      // Supplier-shipped lines (incl. over-limit drop-ship) aren't in the
      // warehouse carrier quote — they're priced via drop-ship freight.
      .filter(({ r, cat }: any) => cat && !lineShipsFromSupplier(cat, Number(r.qty || 0)))
      .map(({ r, cat }: any) => ({
        sku:               cat?.sku || '',
        name:              cat?.name || cat?.sku || '(item)',
        qty:               Number(r.qty || 0),
        freight_weight_g:  cat?.freight_weight_g ?? null,
        freight_length_mm: cat?.freight_length_mm ?? null,
        freight_width_mm:  cat?.freight_width_mm ?? null,
        freight_height_mm: cat?.freight_height_mm ?? null,
        freight_packaging: cat?.freight_packaging ?? null,
        manual_handling:             cat?.manual_handling === true,
        inbound_freight_cost_ex_gst: cat?.inbound_freight_cost_ex_gst ?? null,
      }))

    const liveQuote = await getLiveQuote(liveItems, { postcode: shipPostcode, suburb: shipSuburb })
    if (liveQuote.mode === 'blocked') {
      return res.status(400).json({
        error: 'Freight quote unavailable — some products are missing dimensions. Refresh your cart and try again.',
        details: liveQuote.missing.map(m => `${m.sku} ${m.name} (needs ${m.missing_fields.join(', ')})`),
      })
    }
    if (liveQuote.mode !== 'live') {
      return res.status(503).json({ error: 'Live freight quoting is temporarily unavailable. Refresh your cart and pick a fallback rate, or contact your account manager.' })
    }
    const match = liveQuote.rates.find(r =>
      r.machship.carrierId        === chosenMachShipRoute!.carrierId &&
      r.machship.carrierServiceId === chosenMachShipRoute!.carrierServiceId
    )
    if (!match) {
      return res.status(400).json({ error: 'The freight option you chose is no longer offered — refresh your cart and pick again.' })
    }
    freightExGst              = round2(match.price_ex_gst)
    freightLabel              = match.label
    freightMachShipCarrierId  = match.machship.carrierId
    freightMachShipServiceId  = match.machship.carrierServiceId
    freightChosenQuoteSnapshot = {
      carrierId:               match.machship.carrierId,
      carrierServiceId:        match.machship.carrierServiceId,
      companyCarrierAccountId: match.machship.companyCarrierAccountId ?? null,
      label:                   match.label,
      price_ex_gst:            match.price_ex_gst,
      base_price_ex_gst:       match.base_price_ex_gst,
      markup_pct:              match.markup_pct,
      eta_utc:                 match.eta_utc,
      transit_days:            match.transit_days,
      route_snapshot:          match.machship.routeSnapshot,
    }
    freightQuoteMarkupPct = match.markup_pct
    subtotalEx += freightExGst
    gst += freightExGst * GST_RATE
  }

  // Drop-ship freight: supplier-shipped lines priced by destination zone, added
  // on top of the warehouse freight. Folded into the freight total so MYOB and
  // the invoice need no special handling; the breakdown is stored separately.
  let dropshipFreightExGst = 0
  const dsLines = validated.filter(v => v.isDropShip)
  if (dsLines.length > 0) {
    const { data: dsDist } = await c
      .from('b2b_distributors')
      .select('ship_postcode, bill_postcode')
      .eq('id', user.distributor.id)
      .maybeSingle()
    const dsPostcode = dsDist?.ship_postcode || dsDist?.bill_postcode || ''
    const ds = await getDropshipFreight(
      dsLines.map(v => ({ catalogue_id: v.catalogueId, sku: v.sku, name: v.name, qty: v.qty, is_drop_ship: true })),
      dsPostcode,
    )
    if (ds.missing.length > 0) {
      return res.status(400).json({
        error: 'Drop-ship freight isn’t set for some items to your delivery address — contact your account manager.',
        details: ds.missing.map(m => `${m.sku} ${m.name} (${m.reason})`),
      })
    }
    dropshipFreightExGst = ds.total_ex_gst
    if (dropshipFreightExGst > 0) {
      subtotalEx += dropshipFreightExGst
      gst += dropshipFreightExGst * GST_RATE
    }
  }
  const hasCarrierFreight = !!(chosenFreightRateId || chosenSatchelId || chosenMachShipRoute)
  const totalFreightExGst = round2(freightExGst + dropshipFreightExGst)
  const hasAnyFreight = hasCarrierFreight || dropshipFreightExGst > 0
  if (!freightLabel && dropshipFreightExGst > 0) freightLabel = 'Drop-ship freight'

  subtotalEx = round2(subtotalEx)
  gst = round2(gst)
  const subtotalInc = round2(subtotalEx + gst)
  // Payment surcharge by method: card grosses up the full card rate; PayTo
  // recovers its cheaper fee (1% + $0.30, capped $3.50).
  let cardFeeInc = 0
  if (paymentMethod === 'card' && subtotalInc > 0) {
    cardFeeInc = round2(Math.max(0, (subtotalInc + cfg.cardFeeFixed) / (1 - cfg.cardFeePct) - subtotalInc))
  } else if (paymentMethod === 'payto') {
    cardFeeInc = paytoSurchargeInc(subtotalInc)
  }
  const totalInc   = round2(subtotalInc + cardFeeInc)

  // 4. Insert order header (status pending_payment, no Stripe ID yet)
  const { data: order, error: orderErr } = await c
    .from('b2b_orders')
    .insert({
      distributor_id: user.distributor.id,
      placed_by_user_id: user.id,
      status: 'pending_payment',
      payment_method: paymentMethod,
      subtotal_ex_gst: subtotalEx,
      gst: gst,
      card_fee_inc: cardFeeInc,
      total_inc: totalInc,
      currency: 'AUD',
      myob_company_file: 'JAWS',
      customer_po: customerPo,
      freight_rate_id:               chosenFreightRateId,
      freight_satchel_id:            freightSatchelId,
      freight_zone_id:               freightZoneId,
      freight_method_label:          freightLabel,
      freight_cost_ex_gst:           hasAnyFreight ? totalFreightExGst : null,
      dropship_freight_ex_gst:       dropshipFreightExGst > 0 ? dropshipFreightExGst : null,
      freight_chosen_quote:          freightChosenQuoteSnapshot,
      freight_quote_markup_pct:      freightQuoteMarkupPct,
      machship_carrier_id:           freightMachShipCarrierId,
      machship_carrier_service_id:   freightMachShipServiceId,
      freight_service_label:         chosenMachShipRoute ? freightLabel : null,
    })
    .select('id, order_number')
    .single()
  if (orderErr) return res.status(500).json({ error: orderErr.message })

  // 5. Insert order lines (snapshots — won't change if catalogue updates)
  const orderLineRows = validated.map((v, i) => {
    const lineEx = round2(v.unitPriceEx * v.qty)
    const lineGst = v.isTaxable ? round2(lineEx * GST_RATE) : 0
    return {
      order_id: order.id,
      catalogue_id: v.catalogueId,
      myob_item_uid: v.myobItemUid,
      sku: v.sku,
      name: v.name,
      qty: v.qty,
      unit_trade_price_ex_gst: v.unitPriceEx,
      line_subtotal_ex_gst: lineEx,
      line_gst: lineGst,
      line_total_inc: round2(lineEx + lineGst),
      is_taxable: v.isTaxable,
      sort_order: i,
      bundle_parent_catalogue_id: v.bundleParentCatalogueId,
      is_drop_ship: v.isDropShip,
    }
  })
  const { error: olErr } = await c.from('b2b_order_lines').insert(orderLineRows)
  if (olErr) {
    await c.from('b2b_orders').delete().eq('id', order.id)
    return res.status(500).json({ error: `Order lines insert failed: ${olErr.message}` })
  }

  // 6. Build Stripe line_items (one per cart line + surcharge)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'
  // Skip $0 lines (e.g. "included" bundle components) — Stripe Checkout rejects
  // zero-amount line items. They're still recorded as order lines for MYOB.
  const stripeLineItems: StripeLineItem[] = validated.filter(v => v.unitPriceEx > 0).map(v => {
    const unitInc = v.isTaxable ? v.unitPriceEx * 1.10 : v.unitPriceEx
    return {
      price_data: {
        currency: 'aud',
        product_data: {
          name: v.name,
          description: `SKU: ${v.sku}`,
        },
        unit_amount: Math.round(unitInc * 100),
      },
      quantity: v.qty,
    }
  })

  if (hasAnyFreight && totalFreightExGst > 0) {
    const freightInc = round2(totalFreightExGst * 1.10)  // freight is GST-taxable
    stripeLineItems.push({
      price_data: {
        currency: 'aud',
        product_data: {
          name: 'Freight',
          description: freightLabel || 'Shipping',
        },
        unit_amount: Math.round(freightInc * 100),
      },
      quantity: 1,
    })
  }

  if (cardFeeInc > 0) {
    stripeLineItems.push({
      price_data: {
        currency: 'aud',
        product_data: {
          name: paymentMethod === 'payto' ? 'PayTo processing fee' : 'Card processing surcharge',
          description: 'Recovers Stripe transaction fees',
        },
        unit_amount: Math.round(cardFeeInc * 100),
      },
      quantity: 1,
    })
  }

  // 7. Create Stripe Checkout Session
  let session
  try {
    const pmTypes = paymentMethod === 'becs' ? ['au_becs_debit'] : paymentMethod === 'payto' ? ['payto'] : ['card']
    session = await createCheckoutSession({
      line_items: stripeLineItems,
      payment_method_types: pmTypes,
      customer_creation: paymentMethod === 'card' ? undefined : 'always',
      success_url: `${baseUrl}/b2b/orders/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/b2b/cart?cancelled=${order.id}`,
      customer_email: user.email,
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        b2b_user_id: user.id,
        distributor_id: user.distributor.id,
      },
      payment_intent_data: {
        description: `${order.order_number} — ${user.distributor.displayName}${customerPo ? ` — PO ${customerPo}` : ''}`,
        metadata: {
          order_id: order.id,
          order_number: order.order_number,
          customer_po: customerPo || '',
        },
      },
    })
  } catch (e: any) {
    await c.from('b2b_order_lines').delete().eq('order_id', order.id)
    await c.from('b2b_orders').delete().eq('id', order.id)
    return res.status(502).json({ error: `Stripe checkout failed: ${e?.message || String(e)}` })
  }

  // 8. Save Stripe session id and emit a status event
  await c.from('b2b_orders')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', order.id)
  await c.from('b2b_order_events').insert({
    order_id: order.id,
    event_type: 'checkout_started',
    to_status: 'pending_payment',
    actor_type: 'distributor_user',
    actor_id: null,
    notes: `Stripe session ${session.id} created${customerPo ? ` (PO: ${customerPo})` : ''}`,
    metadata: { stripe_session_id: session.id, total_inc: totalInc, customer_po: customerPo },
  })

  return res.status(200).json({
    order_id: order.id,
    order_number: order.order_number,
    checkout_url: session.url,
    stripe_session_id: session.id,
    customer_po: customerPo,
    totals: {
      subtotal_ex_gst: subtotalEx,
      gst: gst,
      subtotal_inc_gst: subtotalInc,
      card_fee_inc: cardFeeInc,
      total_inc: totalInc,
    },
  })
})
