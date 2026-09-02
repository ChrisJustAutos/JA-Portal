// pages/api/b2b/cart.ts
//
// GET /api/b2b/cart  — returns the signed-in distributor user's cart with
// expanded line items (joined to b2b_catalogue for display) and computed totals.
//
// Cart is per-distributor-user (carts.distributor_user_id is unique).
// Auto-creates an empty cart on first GET so the UI always has a row to write to.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'
import { getStockForItems, stockState, getCommittedQtyByCatalogue, availableQty } from '../../../lib/b2b-stock'
import { applyPricing, effectiveQtyCap } from '../../../lib/b2b-pricing'
import { getLiveQuote, type LiveQuoteCartItem, type LiveQuoteRate } from '../../../lib/b2b-freight'
import { loadBundleChildren, bundleChildUnitPriceExGst } from '../../../lib/b2b-bundles'
import { resolveOverLimit, lineShipsFromSupplier } from '../../../lib/b2b-over-limit'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// The cart's ESTIMATE must come from the same place checkout charges from.
// These were hardcoded, so zeroing the surcharge in Settings would have left
// the cart still quoting 1.7% + 30c while checkout charged nothing (found
// 2026-08-31 while scheduling the surcharge to end).
import { surchargesEnded } from '../../../lib/b2b-payment'

const CARD_FEE_PCT_FALLBACK   = 0.017
const CARD_FEE_FIXED_FALLBACK = 0.30

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()

  // Get-or-create cart for this user
  const cart = await getOrCreateCart(c, user)

  // Pull line items joined to catalogue for display
  const { data: items, error: itemsErr } = await c
    .from('b2b_cart_items')
    .select(`
      id, qty, trade_price_ex_gst_at_add, added_at, updated_at,
      catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
        id, myob_item_uid, sku, name, primary_image_url,
        trade_price_ex_gst, is_taxable, b2b_visible,
        promo_price_ex_gst, promo_starts_at, promo_ends_at, volume_breaks,
        is_special_order, is_drop_ship, instructions_url,
        max_order_qty, min_order_qty, over_limit_qty, over_limit_action,
        call_for_availability_below_qty, call_for_availability_when_zero,
        freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging,
        manual_handling, inbound_freight_cost_ex_gst
      )
    `)
    .eq('cart_id', cart.id)
    .order('added_at', { ascending: true })

  if (itemsErr) return res.status(500).json({ error: itemsErr.message })

  // Pull live stock for everything in the cart, plus in-flight commitments
  // so we can show "X available right now" honestly (not just the MYOB
  // number, which doesn't yet account for orders pending invoice).
  const uids = (items || [])
    .map((i: any) => Array.isArray(i.catalogue) ? i.catalogue[0]?.myob_item_uid : i.catalogue?.myob_item_uid)
    .filter(Boolean) as string[]
  const catalogueIds = (items || [])
    .map((i: any) => (Array.isArray(i.catalogue) ? i.catalogue[0] : i.catalogue)?.id)
    .filter(Boolean) as string[]
  let stockMap: Record<string, any> = {}
  let committed: Record<string, number> = {}
  try {
    [stockMap, committed] = await Promise.all([
      getStockForItems(uids),
      getCommittedQtyByCatalogue(catalogueIds),
    ])
  } catch (e) {
    console.error('Cart stock fetch failed:', e)
  }

  const now = new Date()
  const baseLines = (items || []).map((it: any) => {
    const cat = Array.isArray(it.catalogue) ? it.catalogue[0] : it.catalogue
    const stock = cat?.myob_item_uid ? stockMap[cat.myob_item_uid] : null
    const cmt = cat?.id ? (committed[cat.id] || 0) : 0
    // available_qty = MYOB qty − in-flight commitments. Subtract THIS
    // line's own qty so distributors don't see their own qty held
    // against them.
    const availIncludingMine = availableQty(stock, Math.max(0, cmt - it.qty))
    const tradePrice = Number(cat?.trade_price_ex_gst ?? it.trade_price_ex_gst_at_add ?? 0)
    const breaks = Array.isArray(cat?.volume_breaks) ? cat.volume_breaks : []
    const px = applyPricing({
      trade_price_ex_gst: tradePrice,
      promo_price_ex_gst: cat?.promo_price_ex_gst != null ? Number(cat.promo_price_ex_gst) : null,
      promo_starts_at:    cat?.promo_starts_at ?? null,
      promo_ends_at:      cat?.promo_ends_at ?? null,
      volume_breaks:      breaks,
    }, it.qty, now)
    const unitPriceEx = px.unit_price_ex_gst
    const lineSubEx = unitPriceEx * it.qty
    const lineGst = (cat?.is_taxable !== false) ? lineSubEx * 0.10 : 0

    // "Call for availability" overrides the normal stock label
    const inv = stock ? stock.isInventoried : true
    const qtyAvail = availIncludingMine
    let callForAvail = false
    if (inv && cat) {
      if (cat.call_for_availability_when_zero && (qtyAvail ?? 0) <= 0) callForAvail = true
      const threshold = cat.call_for_availability_below_qty
      if (threshold != null && qtyAvail != null && qtyAvail <= threshold) callForAvail = true
    }

    const maxOrderQty = cat?.max_order_qty != null ? Number(cat.max_order_qty) : null
    const minOrderQty = cat?.min_order_qty != null ? Number(cat.min_order_qty) : null
    // Large-order handling. A supplier-shipped line (catalogue drop-ship OR
    // over-limit drop-ship) isn't bound by our stock, so it has no stock cap —
    // only the hard max-order-qty still applies. A 'quote' line over its
    // threshold blocks checkout until quoted.
    const overLimit = cat ? resolveOverLimit(cat, it.qty) : { triggered: false, action: null, threshold: null }
    const shipsFromSupplier = cat ? lineShipsFromSupplier(cat, it.qty) : false
    const needsQuote = overLimit.triggered && overLimit.action === 'quote'
    const effectiveCap = shipsFromSupplier
      ? (maxOrderQty != null ? maxOrderQty : null)
      : effectiveQtyCap(availIncludingMine, maxOrderQty)

    return {
      id: it.id,
      qty: it.qty,
      catalogue_id: cat?.id ?? null,
      sku: cat?.sku ?? '',
      name: cat?.name ?? '(item removed)',
      image_url: cat?.primary_image_url ?? null,
      unit_price_ex_gst: unitPriceEx,
      trade_price_ex_gst: tradePrice,
      promo_active: px.promo_active,
      volume_break_applied: px.volume_break_applied,
      volume_break_min_qty: px.volume_break_min_qty,
      is_taxable: cat?.is_taxable !== false,
      line_subtotal_ex_gst: lineSubEx,
      line_gst: lineGst,
      line_total_inc_gst: lineSubEx + lineGst,
      // Distributor-relevant warnings
      currently_visible: cat?.b2b_visible !== false,
      price_changed: cat ? Math.abs(Number(cat.trade_price_ex_gst) - Number(it.trade_price_ex_gst_at_add)) > 0.005 : false,
      stock_state: stockState(stock),
      stock_qty_available: stock ? (stock.isInventoried ? stock.qtyAvailable : null) : null,
      // True ceiling — null = unlimited / non-inventoried + no max-order-qty
      available_qty: availIncludingMine,
      max_order_qty: maxOrderQty,
      min_order_qty: minOrderQty,
      effective_cap: effectiveCap,
      call_for_availability: callForAvail,
      is_special_order: cat?.is_special_order === true,
      is_drop_ship: cat?.is_drop_ship === true,
      instructions_url: cat?.instructions_url ?? null,
      // Large-order handling (migration 125).
      over_limit_qty: overLimit.threshold,
      over_limit_action: overLimit.action,
      needs_quote: needsQuote,
      ships_from_supplier: shipsFromSupplier,
      is_bundle_component: false,
      bundle_parent_catalogue_id: null,
    }
  })

  // Expand "includes" bundles: each parent line gets its child products shown
  // as nested, non-editable sub-lines (derived from b2b_product_bundles, not
  // stored in the cart). 'included' children show at $0; 'added' children add
  // their trade price to the totals. Freight is unaffected — the parent's
  // dimensions cover the combined carton (the freight quote below is built
  // from the raw cart `items`, never from these derived lines).
  const lines: any[] = []
  try {
    const parentIds = baseLines.map((l: any) => l.catalogue_id).filter(Boolean) as string[]
    const bundleMap = await loadBundleChildren(c, parentIds)
    for (const base of baseLines) {
      lines.push(base)
      const children = base.catalogue_id ? bundleMap.get(base.catalogue_id) : null
      if (!children) continue
      for (const ch of children) {
        const qty = base.qty * ch.qty
        const unitEx = bundleChildUnitPriceExGst(ch)
        const taxable = ch.child.is_taxable !== false
        const subEx = unitEx * qty
        const gstAmt = taxable ? subEx * 0.10 : 0
        lines.push({
          id: `${base.id}:${ch.child_catalogue_id}`,
          qty,
          catalogue_id: ch.child_catalogue_id,
          sku: ch.child.sku ?? '',
          name: ch.child.name ?? '(item)',
          image_url: ch.child.primary_image_url ?? null,
          unit_price_ex_gst: unitEx,
          trade_price_ex_gst: Number(ch.child.trade_price_ex_gst || 0),
          promo_active: false,
          volume_break_applied: false,
          volume_break_min_qty: null,
          is_taxable: taxable,
          line_subtotal_ex_gst: subEx,
          line_gst: gstAmt,
          line_total_inc_gst: subEx + gstAmt,
          currently_visible: true,
          price_changed: false,
          stock_state: null,
          stock_qty_available: null,
          available_qty: null,
          max_order_qty: null,
          min_order_qty: null,
          effective_cap: null,
          call_for_availability: false,
          is_special_order: false,
          is_drop_ship: ch.child.is_drop_ship === true,
          instructions_url: null,
          // Bundle-component markers — the client renders these nested under the
          // parent with no qty editor / remove button.
          is_bundle_component: true,
          bundle_parent_catalogue_id: base.catalogue_id,
          bundle_price_mode: ch.price_mode,
        })
      }
    }
  } catch (e: any) {
    // Bundle expansion is display-only — never break the cart over it. Fall
    // back to the plain (un-expanded) lines.
    console.error('cart bundle expansion failed (non-fatal):', e?.message || e)
    lines.length = 0
    lines.push(...baseLines)
  }

  // Totals
  const subtotal_ex_gst = lines.reduce((s: number, l: any) => s + l.line_subtotal_ex_gst, 0)
  const gst             = lines.reduce((s: number, l: any) => s + l.line_gst, 0)
  const subtotal_inc_gst = subtotal_ex_gst + gst

  // Card fee — distributor pays a gross-up so Stripe takes its cut and the
  // payout to JAWS = subtotal_inc_gst.
  //   charged   = (subtotal_inc + fixed) / (1 - pct)
  //   card_fee  = charged - subtotal_inc
  // Rates come from b2b_settings, NOT constants, so this estimate always agrees
  // with what checkout actually charges - and the same end-date switches both
  // off together.
  const feeCfg = await loadB2bFeeSettings()
  const feePct   = feeCfg.pct
  const feeFixed = feeCfg.fixed
  const charged = (!feeCfg.ended && subtotal_inc_gst > 0)
    ? (subtotal_inc_gst + feeFixed) / (1 - feePct)
    : subtotal_inc_gst
  const card_fee_inc = Math.max(0, charged - subtotal_inc_gst)
  const total_inc = subtotal_inc_gst + card_fee_inc

  // Pull the distributor's shipping address so we can quote freight
  // for the cart in one round-trip. Both suburb and postcode are
  // needed for MachShip; we fall back to billing if shipping isn't
  // set. When neither is configured the UI hides the freight panel.
  type FreightPayload =
    | null
    | {
        postcode: string
        suburb:   string | null
        mode: 'live' | 'static' | 'blocked' | 'no_zone'
        rates: Array<{
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
        zone?: { id: string; name: string } | null
      }

  // Where is this cart actually going?
  //
  // A distributor can run several stores under one entity (migration 204), and
  // freight is priced on the destination postcode - so the quote has to follow
  // the SELECTED site, not the account's head-office address. The cart carries
  // the choice so the figure on screen is the figure they will be charged.
  const { data: addressRows } = await c
    .from('b2b_distributor_addresses')
    .select('id, label, line1, line2, suburb, state, postcode, contact_name, contact_phone, is_default, sort_order')
    .eq('distributor_id', user.distributor.id).eq('is_active', true)
    .order('sort_order', { ascending: true }).order('label', { ascending: true })
  const addresses = addressRows || []
  // Fall back to the default, then to whatever is first - never to nothing,
  // or a distributor mid-setup would see no freight at all.
  const chosen = addresses.find(a2 => a2.id === cart.ship_address_id)
    || addresses.find(a2 => a2.is_default)
    || addresses[0]
    || null

  let freight: FreightPayload = null
  try {
    const { data: dist } = await c
      .from('b2b_distributors')
      .select('ship_postcode, ship_suburb, bill_postcode, bill_suburb')
      .eq('id', user.distributor.id)
      .maybeSingle()
    const shipPostcode = chosen?.postcode || dist?.ship_postcode || dist?.bill_postcode || null
    const shipSuburb   = chosen?.suburb   || dist?.ship_suburb   || dist?.bill_suburb   || null
    if (shipPostcode) {
      // Build the live-quote input from cart items + their catalogue
      // freight columns. Empty cart → live returns 'unavailable' and
      // we fall through to static, mirroring the old behaviour.
      const liveItems: LiveQuoteCartItem[] = (items || []).filter((it: any) => {
        const cat = Array.isArray(it.catalogue) ? it.catalogue[0] : it.catalogue
        // Supplier-shipped lines (catalogue drop-ship or over-limit drop-ship)
        // aren't in the warehouse carrier quote.
        return cat && !lineShipsFromSupplier(cat, Number(it.qty || 0))
      }).map((it: any) => {
        const cat = Array.isArray(it.catalogue) ? it.catalogue[0] : it.catalogue
        return {
          sku:               cat?.sku || '',
          name:              cat?.name || cat?.sku || '(item)',
          qty:               Number(it.qty || 0),
          freight_weight_g:  cat?.freight_weight_g ?? null,
          freight_length_mm: cat?.freight_length_mm ?? null,
          freight_width_mm:  cat?.freight_width_mm ?? null,
          freight_height_mm: cat?.freight_height_mm ?? null,
          freight_packaging: cat?.freight_packaging ?? null,
          manual_handling:             cat?.manual_handling === true,
          inbound_freight_cost_ex_gst: cat?.inbound_freight_cost_ex_gst ?? null,
        }
      })

      const live = await getLiveQuote(liveItems, { postcode: shipPostcode, suburb: shipSuburb || '' })
      if (live.mode === 'live') {
        freight = {
          postcode: shipPostcode, suburb: shipSuburb, mode: 'live',
          rates: live.rates.map(r => ({
            id: r.id, label: r.label, price_ex_gst: r.price_ex_gst,
            transit_days: r.transit_days, source: 'machship' as const,
            machship: r.machship, eta_utc: r.eta_utc,
            base_price_ex_gst: r.base_price_ex_gst, markup_pct: r.markup_pct,
          })),
        }
      } else if (live.mode === 'blocked') {
        freight = {
          postcode: shipPostcode, suburb: shipSuburb, mode: 'blocked',
          rates: [], blocked: { reason: live.reason, missing: live.missing },
        }
      } else {
        // NO MANUAL FREIGHT PRICING (Chris 2026-09-02: "no manual freight
        // pricing only auto"). This used to fall back to hand-maintained
        // postcode zone rates when the live carrier quote was unavailable,
        // which is the worst moment to be guessing: the numbers were entered
        // by hand months earlier and nobody was told the cart had quietly
        // stopped using real rates. Now an unavailable live quote reads as
        // exactly that, and the office quotes it.
        freight = { postcode: shipPostcode, suburb: shipSuburb, mode: 'no_zone', rates: [] }
      }
    }
  } catch (e: any) {
    // Freight quote is informational — failing here shouldn't break the
    // whole cart load. UI will just hide the freight section.
    console.error('cart freight-quote failed (non-fatal):', e?.message)
  }

  // Orders at or above this (goods + GST + freight) cannot be paid at
  // checkout - the cart warns and the button becomes a submit-for-approval
  // (migration 218). Sent with every cart so the warning appears as the
  // total climbs, not as a surprise at the payment step.
  let manualApprovalThresholdInc: number | null = null
  try {
    const { data: sRow } = await c.from('b2b_settings').select('manual_approval_threshold_inc').eq('id', 'singleton').maybeSingle()
    if (sRow?.manual_approval_threshold_inc != null) manualApprovalThresholdInc = Number(sRow.manual_approval_threshold_inc)
  } catch { /* no warning rather than a broken cart */ }

  return res.status(200).json({
    manual_approval_threshold_inc: manualApprovalThresholdInc,
    cart_id: cart.id,
    // The delivery sites this distributor can pick from, and which one this
    // cart is quoting against.
    ship_addresses: addresses.map(a2 => ({
      id: a2.id, label: a2.label, line1: a2.line1, line2: a2.line2,
      suburb: a2.suburb, state: a2.state, postcode: a2.postcode,
      contact_name: a2.contact_name, contact_phone: a2.contact_phone,
      is_default: a2.is_default === true,
    })),
    ship_address_id: chosen?.id || null,
    distributor: {
      id: user.distributor.id,
      display_name: user.distributor.displayName,
    },
    lines,
    // Counts reflect the distributor's own (purchasable) lines — derived
    // bundle components don't inflate them.
    line_count: baseLines.length,
    item_count: baseLines.reduce((s: number, l: any) => s + l.qty, 0),
    freight,
    totals: {
      subtotal_ex_gst:  round2(subtotal_ex_gst),
      gst:              round2(gst),
      subtotal_inc_gst: round2(subtotal_inc_gst),
      card_fee_inc:     round2(card_fee_inc),
      total_inc:        round2(total_inc),
    },
    card_fee: {
      pct: feeCfg.ended ? 0 : feePct,
      fixed: feeCfg.ended ? 0 : feeFixed,
      note: feeCfg.ended
        ? 'No payment surcharge.'
        : `Estimated Stripe surcharge (${(feePct * 100).toFixed(1)}% + $${feeFixed.toFixed(2)}). Final amount confirmed at checkout.`,
    },
  })
})

async function getOrCreateCart(c: SupabaseClient, user: B2BUser): Promise<{ id: string; ship_address_id: string | null }> {
  const { data: existing, error: lookupErr } = await c
    .from('b2b_carts')
    .select('id, ship_address_id')
    .eq('distributor_user_id', user.id)
    .maybeSingle()
  if (lookupErr) throw new Error(`Cart lookup failed: ${lookupErr.message}`)
  if (existing) return { id: existing.id, ship_address_id: existing.ship_address_id ?? null }

  const { data: created, error: insertErr } = await c
    .from('b2b_carts')
    .insert({
      distributor_user_id: user.id,
      distributor_id: user.distributor.id,
    })
    .select('id')
    .single()
  if (insertErr) throw new Error(`Cart create failed: ${insertErr.message}`)
  return { id: created.id, ship_address_id: null }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Surcharge rates for the cart estimate, from the same b2b_settings row
 * checkout reads. Falls back to the previous constants if the row is missing,
 * so a settings problem cannot silently quote a zero fee and then charge one.
 */
async function loadB2bFeeSettings(): Promise<{ pct: number; fixed: number; ended: boolean }> {
  try {
    const { data } = await sb().from('b2b_settings')
      .select('card_fee_percent, card_fee_fixed, payment_surcharge_ends_on')
      .eq('id', 'singleton').maybeSingle()
    return {
      pct:   Number(data?.card_fee_percent ?? CARD_FEE_PCT_FALLBACK),
      fixed: Number(data?.card_fee_fixed   ?? CARD_FEE_FIXED_FALLBACK),
      ended: surchargesEnded((data as any)?.payment_surcharge_ends_on ?? null),
    }
  } catch {
    return { pct: CARD_FEE_PCT_FALLBACK, fixed: CARD_FEE_FIXED_FALLBACK, ended: false }
  }
}
