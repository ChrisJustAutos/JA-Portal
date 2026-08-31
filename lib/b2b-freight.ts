// lib/b2b-freight.ts
// Postcode → zone matching and rate lookup for the B2B checkout PLUS
// the live MachShip quote path. Two quoting strategies live in this
// file:
//   1. getFreightQuote(postcode) — static zone/rate lookup used as the
//      fallback whenever live quoting is unavailable.
//   2. getLiveQuote(items, dest) — calls MachShip /apiv2/routes/
//      returnRoutes with the cart contents and the destination, applies
//      the admin-configured markup, returns the list of carrier+service
//      options. Blocks (returns mode: 'blocked') if any item lacks
//      weight or outer dimensions — that's the design call recorded in
//      memory: missing dims should stop checkout, not silently fall
//      back to static rates.
//
// Backs /api/b2b/freight-quote and /api/b2b/cart.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  getRoutes,
  MachShipApiError,
  MachShipNotConfiguredError,
  type RouteOption,
  type MachShipItem,
} from './b2b-machship'
import { packItems, packCandidates, type FreightBox, type PalletSpec, type PackMode, type PackResult, type PackedUnit, type PackCandidateKey } from './b2b-cartonizer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface PostcodeRange {
  start: string
  end: string
}

export interface FreightZone {
  id: string
  name: string
  postcode_ranges: PostcodeRange[]
  sort_order: number
  is_active: boolean
}

export interface FreightRate {
  id: string
  zone_id: string
  label: string
  price_ex_gst: number
  transit_days: number | null
  sort_order: number
  is_active: boolean
}

export interface FreightQuote {
  zone: { id: string; name: string }
  rates: Array<{ id: string; label: string; price_ex_gst: number; transit_days: number | null }>
}

// Australian postcodes are 4 digits. Comparing as strings only works when
// both strings are exactly 4 chars; pad on the way in to be safe and to
// match input from forms where users might leave off a leading 0.
function normalisePostcode(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length > 4) return null
  return digits.padStart(4, '0')
}

export function postcodeMatches(postcode: string, ranges: PostcodeRange[]): boolean {
  const pc = normalisePostcode(postcode)
  if (!pc) return false
  for (const r of ranges) {
    const start = normalisePostcode(r.start)
    const end   = normalisePostcode(r.end || r.start)
    if (!start || !end) continue
    // Lexical comparison works because all values are 4-char zero-padded.
    if (pc >= start && pc <= end) return true
  }
  return false
}

/**
 * Resolve the freight quote for a given postcode. Picks the FIRST matching
 * active zone in sort_order, then returns its active rates.
 *
 * Returns null when no zone matches — callers should treat this as
 * "no rates available, ask office for a manual quote" or similar.
 */
export async function getFreightQuote(postcode: string): Promise<FreightQuote | null> {
  const c = sb()
  const { data: zones, error: zErr } = await c
    .from('b2b_freight_zones')
    .select('id, name, postcode_ranges, sort_order, is_active')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (zErr) throw new Error('freight-zones load failed: ' + zErr.message)
  if (!zones || zones.length === 0) return null

  const matched = (zones as any[]).find(z =>
    postcodeMatches(postcode, Array.isArray(z.postcode_ranges) ? z.postcode_ranges : [])
  )
  if (!matched) return null

  const { data: rates, error: rErr } = await c
    .from('b2b_freight_rates')
    .select('id, label, price_ex_gst, transit_days, sort_order')
    .eq('zone_id', matched.id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (rErr) throw new Error('freight-rates load failed: ' + rErr.message)

  return {
    zone: { id: matched.id, name: matched.name },
    rates: (rates || []).map((r: any) => ({
      id: r.id,
      label: r.label,
      price_ex_gst: Number(r.price_ex_gst),
      transit_days: r.transit_days,
    })),
  }
}

/**
 * Parse a comma-separated postcode-range string ("4000-4179, 4500-4999, 4600")
 * into a clean PostcodeRange[]. Single postcodes (e.g. "4600") become
 * { start: "4600", end: "4600" }. Throws on parse failure with a
 * human-readable message — caller (admin endpoint) returns 400.
 */
export function parsePostcodeRanges(input: string): PostcodeRange[] {
  const out: PostcodeRange[] = []
  const parts = String(input || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const part of parts) {
    const m = part.match(/^(\d{1,4})\s*[-–]\s*(\d{1,4})$/)
    if (m) {
      const start = m[1].padStart(4, '0')
      const end   = m[2].padStart(4, '0')
      if (start > end) throw new Error(`Range "${part}": start > end`)
      out.push({ start, end })
      continue
    }
    if (/^\d{1,4}$/.test(part)) {
      const pc = part.padStart(4, '0')
      out.push({ start: pc, end: pc })
      continue
    }
    throw new Error(`Could not parse postcode segment: "${part}"`)
  }
  return out
}

export function formatPostcodeRanges(ranges: PostcodeRange[] | null | undefined): string {
  if (!Array.isArray(ranges)) return ''
  return ranges.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(', ')
}

// ── Live MachShip quoting ─────────────────────────────────────────

export interface LiveQuoteCartItem {
  sku: string
  name: string
  qty: number
  // Catalogue freight columns. nulls trigger the missing-dims block.
  freight_weight_g:  number | null
  freight_length_mm: number | null
  freight_width_mm:  number | null
  freight_height_mm: number | null
  freight_packaging: 'box' | 'pallet' | 'other' | 'unboxed' | null
  // Manual handling: a tickbox that flags the item to MachShip so the carrier's
  // quote/booking price adjusts (no fixed portal fee).
  manual_handling?: boolean | null
  // Per-unit inbound freight surcharge (ex GST) added on top of the
  // carrier-quoted freight, charged to the distributor, applied PER UNIT × qty.
  inbound_freight_cost_ex_gst?: number | null
}

export interface LiveQuoteDestination {
  suburb: string
  postcode: string
}

// One option to show the distributor at checkout.
export interface LiveQuoteRate {
  // Synthetic id — the cart selects by this. Format:
  // `ms:<carrierId>:<serviceId>` so we can decode it back to MachShip
  // ids without a database round-trip.
  id: string
  label: string                     // "Toll IPEC — Road Express"
  carrier_name: string
  service_name: string
  price_ex_gst: number              // sell price ex GST, markup already applied
  base_price_ex_gst: number         // MachShip's pre-markup total — kept for audit
  markup_pct: number                // % we applied
  transit_days: number | null
  eta_utc: string | null            // ISO; provider-reported best-effort
  // The full bag we'll persist on the order at checkout so book-freight
  // can rebuild the request without re-quoting.
  // WHICH packing produced this price. One order can ship several legitimate
  // ways and only the carrier knows which is cheapest, so every plan is priced
  // and the winner is kept per carrier/service — see getLiveQuote.
  pack_key:   PackCandidateKey
  pack_label: string
  machship: {
    carrierId:                number
    carrierServiceId:         number
    companyCarrierAccountId?: number
    routeSnapshot:            RouteOption
    // The units this price was quoted on. Persisted into the order's chosen
    // quote at checkout so booking and the pick list ship exactly what was
    // priced instead of re-packing and drifting.
    packPlanUnits:            PackedUnit[]
  }
}

export type LiveQuoteResult =
  | { mode: 'live'; rates: LiveQuoteRate[] }
  | { mode: 'blocked'; reason: string; missing: Array<{ sku: string; name: string; missing_fields: string[] }> }
  | { mode: 'unavailable'; reason: string }

interface FreightSettings {
  freight_markup_percent: number
  machship_from_suburb:   string | null
  machship_from_postcode: string | null
  freight_pallet_length_mm:     number | null
  freight_pallet_width_mm:      number | null
  freight_pallet_max_height_mm: number | null
  freight_pallet_max_weight_g:  number | null
  freight_pallet_threshold_g:   number | null
}

async function loadFreightSettings(): Promise<FreightSettings | null> {
  const c = sb()
  const { data, error } = await c
    .from('b2b_settings')
    .select('freight_markup_percent, machship_from_suburb, machship_from_postcode, freight_pallet_length_mm, freight_pallet_width_mm, freight_pallet_max_height_mm, freight_pallet_max_weight_g, freight_pallet_threshold_g')
    .eq('id', 'singleton')
    .maybeSingle()
  if (error) throw new Error('freight settings load failed: ' + error.message)
  return (data as any) || null
}

// ── Tiered freight markup (migration 208) ─────────────────────────
// A flat percentage charged the same 20% on a $2,800 consignment as on a $60
// one. Bands are read against what the CARRIER charges us, ex GST, and the
// bound is INCLUSIVE: $500 exactly is in the "up to $500" band.

export interface MarkupTier {
  up_to_ex_gst: number | null   // null = the open-ended top band
  markup_percent: number
}

async function loadMarkupTiers(): Promise<MarkupTier[]> {
  const c = sb()
  const { data } = await c
    .from('b2b_freight_markup_tiers')
    .select('up_to_ex_gst, markup_percent')
    .eq('is_active', true)
  const rows = (data || []).map((r: any) => ({
    up_to_ex_gst: r.up_to_ex_gst == null ? null : Number(r.up_to_ex_gst),
    markup_percent: Number(r.markup_percent),
  }))
  // Cheapest band first, open-ended last, whatever order the DB returned.
  rows.sort((a, b) => {
    if (a.up_to_ex_gst == null) return 1
    if (b.up_to_ex_gst == null) return -1
    return a.up_to_ex_gst - b.up_to_ex_gst
  })
  return rows
}

/**
 * The markup percent for a carrier price. First band whose (inclusive) bound
 * the price fits, else the open-ended band, else `fallback` — which is the
 * legacy flat b2b_settings.freight_markup_percent, so an empty tier table
 * prices exactly as it did before this existed.
 *
 * NOTE the deliberate consequence of a descending scale on a per-consignment
 * basis: the bands are CLIFFS, not a sliding scale. A $500 carrier price earns
 * $100 of markup and a $501 one earns $50.10. That is what was asked for
 * (Chris 2026-08-27); a smooth version would have to mark up each band's slice
 * separately, the way income tax does.
 */
export function resolveMarkupPct(baseExGst: number, tiers: MarkupTier[], fallback: number): number {
  if (!tiers || tiers.length === 0) return fallback
  for (const t of tiers) {
    if (t.up_to_ex_gst == null) return t.markup_percent
    if (baseExGst <= t.up_to_ex_gst) return t.markup_percent
  }
  // Bands configured but none open-ended and the price is above them all.
  return fallback
}

// The admin-configured standard cartons used by the cartonizer.
async function loadFreightBoxes(): Promise<FreightBox[]> {
  const c = sb()
  const { data } = await c
    .from('b2b_freight_boxes')
    .select('name, length_mm, width_mm, height_mm, max_weight_g')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  return (data || []) as FreightBox[]
}

export interface PackForMachShipItem {
  sku: string
  name: string
  qty: number
  weight_g: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  packaging: 'box' | 'pallet' | 'other' | 'unboxed' | null
  manual_handling?: boolean | null
}

// Pack items into MachShip shipping units (cartons/pallets) using the configured
// boxes + pallet spec. Falls back to one-carton-per-line when no boxes are set so
// quoting/booking never breaks. Shared by getLiveQuote and the booking path so a
// booked consignment matches its quote. manualHandling is flagged on every unit
// when ANY item needs it (the carrier handles the whole consignment).
// The raw packed units (with per-box contents) for a set of order lines, using
// the SAME configured boxes + pallet spec as quoting/booking. Returns null when
// no usable box config exists (callers fall back to one-carton-per-line).
// Shared by packForMachShip and the pick-list PDF so the printed box plan is
// exactly the plan freight will book.
export async function packOrderUnits(
  items: PackForMachShipItem[],
  opts: { packMode?: PackMode; palletId?: string | null } = {},
): Promise<PackResult | null> {
  const [boxes, pallets] = await Promise.all([loadFreightBoxes(), loadFreightPallets()])
  return packItems(
    items.map(it => ({
      sku: it.sku, name: it.name, qty: it.qty,
      weight_g: it.weight_g, length_mm: it.length_mm, width_mm: it.width_mm, height_mm: it.height_mm,
      packaging: it.packaging,
    })),
    boxes, pallets, { mode: opts.packMode, palletId: opts.palletId },
  )
}

// The configured pallet options. Reads b2b_freight_pallets (migration 206);
// falls back to the legacy single b2b_settings.freight_pallet_* spec when that
// table is empty, so freight stays quotable if the table is ever cleared or a
// deploy lands ahead of the migration. The palletise-over-weight threshold is
// an order-level setting either way, so it is stamped onto every row.
async function loadFreightPallets(): Promise<PalletSpec[]> {
  const c = sb()
  const settings = await loadFreightSettings()
  const threshold = settings?.freight_pallet_threshold_g ?? null

  const { data } = await c
    .from('b2b_freight_pallets')
    .select('id, name, length_mm, width_mm, max_height_mm, max_weight_g')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  if (data && data.length) {
    return data.map((p: any) => ({
      id: p.id, name: p.name,
      length_mm: p.length_mm, width_mm: p.width_mm,
      max_height_mm: p.max_height_mm, max_weight_g: p.max_weight_g,
      threshold_g: threshold,
    }))
  }

  const legacy: PalletSpec = {
    id: null, name: 'Pallet',
    length_mm:     settings?.freight_pallet_length_mm ?? null,
    width_mm:      settings?.freight_pallet_width_mm ?? null,
    max_height_mm: settings?.freight_pallet_max_height_mm ?? null,
    max_weight_g:  settings?.freight_pallet_max_weight_g ?? null,
    threshold_g:   threshold,
  }
  return legacy.length_mm && legacy.width_mm && legacy.max_weight_g ? [legacy] : []
}

/**
 * The units an order should actually ship as, in priority order:
 *   1. freight_pack_plan  — the admin's MANUAL override from "Combine
 *      consignments". Always wins; that is the point of it.
 *   2. freight_chosen_quote.pack_plan_units — the packing the chosen rate was
 *      PRICED on. Since 2026-08-27 a quote compares several plans (pallets vs
 *      part-pallet vs all parcels), so re-packing at booking time could pick a
 *      different plan than the money was collected for.
 * null means nothing stored — callers re-pack, which is correct for orders
 * quoted before this existed and for static/satchel freight.
 */
export function orderPlanUnits(order: any): PackedUnit[] | null {
  return parsePackPlanUnits(order?.freight_pack_plan)
      ?? parsePackPlanUnits(order?.freight_chosen_quote?.pack_plan_units)
}

// Validate a stored freight_pack_plan (jsonb from b2b_orders) back into
// PackedUnits. The plan is the admin's manual override from the "Combine
// consignments" tool — one entry per physical consignment, quantity 1 each.
// Returns null on anything malformed so callers fall back to auto packing.
export function parsePackPlanUnits(raw: any): PackedUnit[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const units: PackedUnit[] = []
  for (const u of raw) {
    const w = Number(u?.weight_g), l = Number(u?.length_mm), wd = Number(u?.width_mm), h = Number(u?.height_mm)
    if (!u || typeof u.name !== 'string' || !(w > 0) || !(l > 0) || !(wd > 0) || !(h > 0)) return null
    units.push({
      itemType: u.itemType === 'Pallet' ? 'Pallet' : 'Carton',
      name: u.name, ownPackaging: u.ownPackaging === true,
      quantity: Math.max(1, Math.floor(Number(u.quantity) || 1)),
      weight_g: w, length_mm: l, width_mm: wd, height_mm: h,
      contents: Array.isArray(u.contents)
        ? u.contents.map((cl: any) => ({ sku: String(cl?.sku ?? ''), name: String(cl?.name ?? ''), qty: Number(cl?.qty) || 0 }))
        : undefined,
      // Carry a pallet's stacked-box plan through a saved override, or the pick
      // list loses its boxes the moment anyone edits the plan.
      boxes: Array.isArray(u.boxes)
        ? u.boxes.map((b: any) => ({
            name: String(b?.name ?? ''), ownPackaging: b?.ownPackaging === true,
            weight_g: Number(b?.weight_g) || 0,
            length_mm: Number(b?.length_mm) || 0, width_mm: Number(b?.width_mm) || 0, height_mm: Number(b?.height_mm) || 0,
            contents: Array.isArray(b?.contents)
              ? b.contents.map((cl: any) => ({ sku: String(cl?.sku ?? ''), name: String(cl?.name ?? ''), qty: Number(cl?.qty) || 0 }))
              : [],
          }))
        : undefined,
    })
  }
  return units
}

// Every plan worth pricing for these items, each with the MachShip payload to
// quote it and the PackedUnits to persist if it wins. Mirrors packForMachShip's
// unit->MachShipItem mapping so a candidate's price and its booking match.
export interface MachShipCandidate {
  key: PackCandidateKey
  label: string
  units: PackedUnit[]
  machshipItems: MachShipItem[]
}

export async function packCandidatesForMachShip(
  items: PackForMachShipItem[],
  opts: { packMode?: PackMode } = {},
): Promise<MachShipCandidate[]> {
  const anyManualHandling = items.some(i => i.manual_handling)
  const [boxes, pallets] = await Promise.all([loadFreightBoxes(), loadFreightPallets()])
  const cands = packCandidates(
    items.map(it => ({
      sku: it.sku, name: it.name, qty: it.qty,
      weight_g: it.weight_g, length_mm: it.length_mm, width_mm: it.width_mm, height_mm: it.height_mm,
      packaging: it.packaging,
    })),
    boxes, pallets, { mode: opts.packMode },
  )
  return cands.map(c => ({
    key: c.key,
    label: c.label,
    units: c.result.units,
    machshipItems: c.result.units.map(u => ({
      itemType: u.itemType as any,
      name:     u.name,
      quantity: u.quantity,
      weight:   round3(u.weight_g / 1000),
      length:   round1(u.length_mm / 10),
      width:    round1(u.width_mm / 10),
      height:   round1(u.height_mm / 10),
      ...(anyManualHandling ? { manualHandling: true } : {}),
    })),
  }))
}

export async function packForMachShip(
  items: PackForMachShipItem[],
  opts: { packMode?: PackMode; planUnits?: PackedUnit[] | null } = {},
): Promise<MachShipItem[]> {
  const anyManualHandling = items.some(i => i.manual_handling)
  // Manual consignment plan (admin combined boxes) wins over the cartonizer.
  if (opts.planUnits && opts.planUnits.length > 0) {
    return opts.planUnits.map(u => ({
      itemType: u.itemType as any,
      name:     u.name,
      quantity: u.quantity,
      weight:   round3(u.weight_g / 1000),
      length:   round1(u.length_mm / 10),
      width:    round1(u.width_mm / 10),
      height:   round1(u.height_mm / 10),
      ...(anyManualHandling ? { manualHandling: true } : {}),
    }))
  }
  const packed = await packOrderUnits(items, opts)
  if (packed) {
    return packed.units.map(u => ({
      itemType: u.itemType as any,
      name:     u.name,
      quantity: u.quantity,
      weight:   round3(u.weight_g / 1000),
      length:   round1(u.length_mm / 10),
      width:    round1(u.width_mm / 10),
      height:   round1(u.height_mm / 10),
      ...(anyManualHandling ? { manualHandling: true } : {}),
    }))
  }
  // Fallback: one carton per line (pre-cartonizer behaviour).
  return items.map(it => ({
    itemType: packagingForMachShip(it.packaging),
    name:     it.name.slice(0, 80) || it.sku,
    sku:      it.sku,
    quantity: it.qty,
    weight:   round3(Number(it.weight_g || 0) / 1000),
    length:   round1(Number(it.length_mm || 0) / 10),
    width:    round1(Number(it.width_mm || 0) / 10),
    height:   round1(Number(it.height_mm || 0) / 10),
    ...(it.manual_handling ? { manualHandling: true } : {}),
  }))
}

export async function getLiveQuote(
  items: LiveQuoteCartItem[],
  dest: LiveQuoteDestination,
  opts: { packMode?: PackMode } = {},
): Promise<LiveQuoteResult> {
  if (items.length === 0) {
    return { mode: 'unavailable', reason: 'Cart is empty' }
  }
  if (!dest.postcode || !dest.suburb) {
    return { mode: 'unavailable', reason: 'Destination postcode/suburb missing' }
  }

  // Block on any item lacking weight or all three dimensions. Admins
  // can fix this on the catalogue page — the missing-dims badge there
  // calls out exactly which products need measuring.
  const missing: Array<{ sku: string; name: string; missing_fields: string[] }> = []
  for (const it of items) {
    const lack: string[] = []
    if (it.freight_weight_g  == null || it.freight_weight_g  <= 0) lack.push('weight')
    if (it.freight_length_mm == null || it.freight_length_mm <= 0) lack.push('length')
    if (it.freight_width_mm  == null || it.freight_width_mm  <= 0) lack.push('width')
    if (it.freight_height_mm == null || it.freight_height_mm <= 0) lack.push('height')
    if (lack.length > 0) missing.push({ sku: it.sku, name: it.name, missing_fields: lack })
  }
  if (missing.length > 0) {
    return {
      mode: 'blocked',
      reason: `Live freight quote unavailable: ${missing.length} item${missing.length === 1 ? '' : 's'} missing dimensions or weight`,
      missing,
    }
  }

  const settings = await loadFreightSettings()
  if (!settings) {
    return { mode: 'unavailable', reason: 'b2b_settings singleton missing' }
  }
  const flatMarkup = Number(settings.freight_markup_percent ?? 20)
  const markupTiers = await loadMarkupTiers()
  // Sender suburb/postcode are required even for a routes call.
  if (!settings.machship_from_suburb || !settings.machship_from_postcode) {
    return { mode: 'unavailable', reason: 'MachShip sender address not configured in B2B Settings' }
  }

  // Pack the items EVERY sensible way and price them all: two pallets, one
  // pallet with the neat boxes as parcels, or all parcels. Geometry cannot tell
  // which is cheapest — de-palletising cuts declared cube but multiplies
  // per-item handling — so the carrier decides. An explicit packMode collapses
  // this to a single candidate (see packCandidates).
  const candidates = await packCandidatesForMachShip(items.map(it => ({
    sku: it.sku, name: it.name, qty: it.qty,
    weight_g: it.freight_weight_g, length_mm: it.freight_length_mm,
    width_mm: it.freight_width_mm, height_mm: it.freight_height_mm,
    packaging: it.freight_packaging, manual_handling: it.manual_handling,
  })), { packMode: opts.packMode })
  if (candidates.length === 0) {
    return { mode: 'unavailable', reason: 'Nothing to pack' }
  }

  const from = { suburb: settings.machship_from_suburb, postcode: settings.machship_from_postcode }
  const to   = { suburb: dest.suburb,                   postcode: dest.postcode }
  const quoted = await Promise.all(candidates.map(async c => {
    try {
      const r = await getRoutes({ fromLocation: from, toLocation: to, items: c.machshipItems })
      return { cand: c, routes: r.routes || [], err: null as any }
    } catch (e: any) {
      // One candidate failing must not lose the others — a hybrid plan the
      // carrier will not accept should cost us that option, not the quote.
      return { cand: c, routes: [] as RouteOption[], err: e }
    }
  }))

  const usable = quoted.filter(q => q.routes.length > 0)
  if (usable.length === 0) {
    const e = quoted.find(q => q.err)?.err
    if (e instanceof MachShipNotConfiguredError) return { mode: 'unavailable', reason: e.message }
    if (e instanceof MachShipApiError)            return { mode: 'unavailable', reason: e.message }
    if (e) return { mode: 'unavailable', reason: `MachShip getRoutes failed: ${e?.message || e}` }
    return { mode: 'unavailable', reason: 'No MachShip routes available for this destination' }
  }

  // Carrier eligibility, applied BEFORE the cheapest-per-carrier collapse.
  //
  // A carrier that cannot physically take this shape of consignment must never
  // reach the rate list at all: the cart auto-selects the cheapest rate, so
  // merely showing it is enough for it to be booked. Hi-Trans will not carry
  // loose/individual items - pallets only (Chris, 2026-08-31) - and before this
  // there was no carrier filtering anywhere, so a box-only plan could be
  // pre-selected onto it. Rules live in b2b_freight_carrier_rules and are data,
  // so a carrier can be restricted or killed without a deploy.
  const carrierRules = await loadCarrierRules()
  const dropped: string[] = []

  const best = new Map<string, { route: RouteOption; cand: MachShipCandidate; base: number }>()
  for (const q of usable) {
    const allPallets = q.cand.machshipItems.length > 0 &&
      q.cand.machshipItems.every(it => it.itemType === 'Pallet' || it.itemType === 'Skid')
    for (const r of q.routes) {
      const verdict = carrierAllowed(carrierRules, r.carrier, allPallets)
      if (!verdict.allowed) {
        dropped.push(`${r.carrier.name} (${verdict.reason})`)
        continue
      }
      const key = `${r.carrier.id}:${r.carrierService.id}`
      const base = Number(r.consignmentTotal?.totalSellPrice || 0)
      const cur = best.get(key)
      if (!cur || base < cur.base) best.set(key, { route: r, cand: q.cand, base })
    }
  }
  if (dropped.length) {
    console.log('[b2b-freight] carrier rules excluded:', Array.from(new Set(dropped)).join('; '))
  }
  if (best.size === 0) {
    // Every route was ruled out. Say so plainly rather than reporting "no
    // routes", which would send someone hunting a MachShip or address fault.
    return {
      mode: 'unavailable',
      reason: `Every carrier MachShip offered is excluded by a carrier rule (${Array.from(new Set(dropped)).join('; ')}). `
        + 'Check b2b_freight_carrier_rules.',
    }
  }

  // Inbound-freight per-unit surcharge, charged to the distributor. Summed
  // across the cart (× qty) and added on top of the marked-up carrier price —
  // cost recovery, so no extra markup. (Manual handling is NOT a fixed fee — it
  // flags the item to MachShip above so the carrier price already reflects it.)
  const surchargeExGst = round2(items.reduce((sum, it) => {
    const inbound = Number(it.inbound_freight_cost_ex_gst || 0)
    return sum + inbound * Number(it.qty || 0)
  }, 0))

  const rates: LiveQuoteRate[] = Array.from(best.values()).map(({ route: r, cand, base }) => {
    // Markup is per RATE, not per quote: the band depends on this carrier's
    // price, so a $480 service and a $520 one on the same order are marked up
    // differently. markup_pct travels with the rate and is what gets stored.
    const markup = resolveMarkupPct(round2(base), markupTiers, flatMarkup)
    const marked = round2(round2(base * (1 + markup / 100)) + surchargeExGst)
    const eta    = r.despatchOptions?.[0]?.etaUtc || r.despatchOptions?.[0]?.etaLocal || null
    const days   = r.despatchOptions?.[0]?.totalBusinessDays ?? r.despatchOptions?.[0]?.totalDays ?? null
    return {
      id:                `ms:${r.carrier.id}:${r.carrierService.id}`,
      label:             `${r.carrier.name} — ${r.carrierService.name}`,
      carrier_name:      r.carrier.name,
      service_name:      r.carrierService.name,
      price_ex_gst:      marked,
      base_price_ex_gst: round2(base),
      markup_pct:        markup,
      transit_days:      days,
      eta_utc:           eta,
      pack_key:          cand.key,
      pack_label:        cand.label,
      machship: {
        carrierId:               r.carrier.id,
        carrierServiceId:        r.carrierService.id,
        companyCarrierAccountId: r.companyCarrierAccountId,
        routeSnapshot:           r,
        packPlanUnits:           cand.units,
      },
    }
  })

  // Cheapest first so the cart's existing "auto-select cheapest" logic
  // does the right thing without changes.
  rates.sort((a, b) => a.price_ex_gst - b.price_ex_gst)
  return { mode: 'live', rates }
}

// ── Flat-rate satchels (e.g. AusPost prepaid) ─────────────────────
// A satchel is a fixed freight price anywhere in Australia, gated by total
// order weight. Offered ALONGSIDE the carrier/static rates so the cart's
// "cheapest wins" picks it for light orders. Satchel orders ship manually
// (no MachShip consignment) — see lib/b2b-freight-book / the order page.

export interface SatchelRate {
  id: string             // synthetic: `satchel:<uuid>`
  satchel_id: string
  label: string
  price_ex_gst: number   // sell ex GST (what the distributor pays)
  cost_ex_gst: number    // our cost ex GST (for margin reporting)
  transit_days: number | null
}

export interface SatchelEligItem {
  qty: number
  weight_g: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  packaging: 'box' | 'pallet' | 'other' | 'unboxed' | null
}

// Satchels are flexible bags, but they still have a finite capacity — weight
// alone isn't enough (10 light parts can be under 5kg yet not physically fit).
// So when a satchel has all three dimensions set we apply a real size check:
//   1. every item, rotated, must fit inside the satchel (longest dim can't
//      exceed the satchel's longest), and
//   2. the COMBINED volume of all items (× qty) must fit the satchel's volume,
//      derated by a fill factor (bags don't pack perfectly).
// A satchel with no dims set falls back to weight-only. Missing item dims fail
// the check when the satchel has dimensions (we can't verify the fit).
const SATCHEL_FILL = 0.80

function itemsFitSatchel(items: SatchelEligItem[], s: { max_length_mm: number | null; max_width_mm: number | null; max_height_mm: number | null }): boolean {
  const L = s.max_length_mm, W = s.max_width_mm, H = s.max_height_mm
  const hasDims = (L != null && L > 0) && (W != null && W > 0) && (H != null && H > 0)
  if (!hasDims) return true   // weight-only satchel
  const sortedCap = [L!, W!, H!].sort((a, b) => a - b)
  const satchelVol = L! * W! * H!
  let totalVol = 0
  for (const it of items) {
    if (it.length_mm == null || it.width_mm == null || it.height_mm == null) return false
    const d = [it.length_mm, it.width_mm, it.height_mm].sort((a, b) => a - b)
    if (d[0] > sortedCap[0] || d[1] > sortedCap[1] || d[2] > sortedCap[2]) return false   // one item too big for the bag
    totalVol += (it.length_mm * it.width_mm * it.height_mm) * Math.max(0, Number(it.qty || 0))
  }
  if (totalVol > satchelVol * SATCHEL_FILL) return false   // everything won't fit together
  return true
}

// Return the satchels an order qualifies for, cheapest first. Empty when: no
// active satchels, any item is pallet packaging, the admin forced a pallet pack,
// any item is missing weight (can't trust a flat rate without it), or the order
// is too heavy / too big for every satchel.
export async function getSatchelRates(
  items: SatchelEligItem[],
  opts: { packMode?: PackMode } = {},
): Promise<SatchelRate[]> {
  if (!items.length) return []
  if (opts.packMode === 'pallet') return []
  if (items.some(i => i.packaging === 'pallet')) return []
  let totalWeightG = 0
  for (const it of items) {
    const w = Number(it.weight_g || 0)
    if (w <= 0) return []   // unknown weight → don't offer a flat satchel
    totalWeightG += w * Math.max(0, Number(it.qty || 0))
  }
  if (totalWeightG <= 0) return []

  const c = sb()
  const { data } = await c
    .from('b2b_freight_satchels')
    .select('id, name, max_weight_g, max_length_mm, max_width_mm, max_height_mm, cost_ex_gst, sell_ex_gst, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  const rows = (data || []) as any[]

  const out: SatchelRate[] = []
  for (const s of rows) {
    const maxW = Number(s.max_weight_g || 0)
    if (maxW <= 0 || totalWeightG > maxW) continue
    if (!itemsFitSatchel(items, s)) continue
    out.push({
      id:           `satchel:${s.id}`,
      satchel_id:   s.id,
      label:        s.name,
      price_ex_gst: round2(Number(s.sell_ex_gst || 0)),
      cost_ex_gst:  round2(Number(s.cost_ex_gst || 0)),
      transit_days: null,
    })
  }
  out.sort((a, b) => a.price_ex_gst - b.price_ex_gst)
  return out
}

// ── Drop-ship freight (per product, per destination zone) ─────────
// Drop-ship items ship direct from the supplier, so they're excluded from the
// warehouse (MachShip/satchel) quote and instead carry their own freight price
// by destination zone (reusing b2b_freight_zones). Single figure billed to the
// customer, stored ex-GST.

export interface DropshipFreightItem {
  catalogue_id: string
  sku: string
  name: string
  qty: number
  is_drop_ship: boolean
}

export interface DropshipFreightResult {
  total_ex_gst: number
  zone: { id: string; name: string } | null
  lines: Array<{ catalogue_id: string; sku: string; qty: number; unit_ex_gst: number; line_ex_gst: number }>
  // Drop-ship items we couldn't price for the destination (no zone match, or no
  // rate set for the matched zone) — callers should block checkout, like missing dims.
  missing: Array<{ sku: string; name: string; reason: string }>
}

export async function getDropshipFreight(items: DropshipFreightItem[], postcode: string): Promise<DropshipFreightResult> {
  const ds = items.filter(i => i.is_drop_ship && Number(i.qty) > 0)
  if (ds.length === 0) return { total_ex_gst: 0, zone: null, lines: [], missing: [] }

  const c = sb()
  const { data: zones } = await c
    .from('b2b_freight_zones')
    .select('id, name, postcode_ranges, sort_order, is_active')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  const matched = (zones || []).find((z: any) =>
    postcodeMatches(postcode, Array.isArray(z.postcode_ranges) ? z.postcode_ranges : [])
  )
  if (!matched) {
    return {
      total_ex_gst: 0, zone: null, lines: [],
      missing: ds.map(i => ({ sku: i.sku, name: i.name, reason: 'no freight zone covers the destination postcode' })),
    }
  }

  const ids = Array.from(new Set(ds.map(i => i.catalogue_id)))
  const { data: rateRows } = await c
    .from('b2b_dropship_freight_rates')
    .select('catalogue_id, price_ex_gst')
    .eq('zone_id', (matched as any).id)
    .in('catalogue_id', ids)
  const byId = new Map((rateRows || []).map((r: any) => [r.catalogue_id, Number(r.price_ex_gst)]))

  const lines: DropshipFreightResult['lines'] = []
  const missing: DropshipFreightResult['missing'] = []
  let total = 0
  for (const i of ds) {
    if (!byId.has(i.catalogue_id)) {
      missing.push({ sku: i.sku, name: i.name, reason: `no drop-ship freight set for zone "${(matched as any).name}"` })
      continue
    }
    const unit = byId.get(i.catalogue_id)!
    const line = round2(unit * Number(i.qty))
    total += line
    lines.push({ catalogue_id: i.catalogue_id, sku: i.sku, qty: Number(i.qty), unit_ex_gst: round2(unit), line_ex_gst: line })
  }
  return { total_ex_gst: round2(total), zone: { id: (matched as any).id, name: (matched as any).name }, lines, missing }
}

function packagingForMachShip(p: LiveQuoteCartItem['freight_packaging']): 'Carton' | 'Pallet' | 'Skid' {
  if (p === 'pallet') return 'Pallet'
  // 'box', 'other' (already boxed) and 'unboxed' (wrapped) all fall to Carton —
  // MachShip's catch-all small package type that every carrier they aggregate
  // supports. ('unboxed' still ships at its own dims; the cartonizer handles that.)
  return 'Carton'
}

function round1(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
function round3(n: number): number { return Math.round(n * 1000) / 1000 }

// ── Carrier eligibility rules ──────────────────────────────────────────────

export interface CarrierRule {
  carrier_name_match: string
  machship_carrier_id: number | null
  pallets_only: boolean
  blocked: boolean
}

/** Cached briefly — quoting runs several times per cart load. */
let _rulesCache: { at: number; rules: CarrierRule[] } | null = null

export async function loadCarrierRules(): Promise<CarrierRule[]> {
  if (_rulesCache && Date.now() - _rulesCache.at < 60_000) return _rulesCache.rules
  try {
    const { data } = await sb().from('b2b_freight_carrier_rules')
      .select('carrier_name_match, machship_carrier_id, pallets_only, blocked')
      .eq('is_active', true)
    const rules = (data || []) as CarrierRule[]
    _rulesCache = { at: Date.now(), rules }
    return rules
  } catch (e: any) {
    // Fail OPEN on a rules-table problem: losing every carrier would stop
    // checkout dead, which is worse than briefly offering one we would rather
    // not. The log line is the signal.
    console.error('[b2b-freight] carrier rules unreadable, quoting unfiltered:', e?.message || e)
    return []
  }
}

/** Does a rule refer to this carrier? Id wins when set, else name substring. */
function ruleMatches(rule: CarrierRule, carrier: { id: number; name: string }): boolean {
  if (rule.machship_carrier_id != null) return rule.machship_carrier_id === carrier.id
  const needle = String(rule.carrier_name_match || '').trim().toLowerCase()
  return needle.length > 0 && String(carrier.name || '').toLowerCase().includes(needle)
}

export function carrierAllowed(
  rules: CarrierRule[],
  carrier: { id: number; name: string },
  allPallets: boolean,
): { allowed: true } | { allowed: false; reason: string } {
  for (const rule of rules) {
    if (!ruleMatches(rule, carrier)) continue
    if (rule.blocked) return { allowed: false, reason: 'blocked' }
    if (rule.pallets_only && !allPallets) {
      return { allowed: false, reason: 'pallets only, this plan has loose items' }
    }
  }
  return { allowed: true }
}
