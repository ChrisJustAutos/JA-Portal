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
import { packItems, type FreightBox, type PalletSpec, type PackMode } from './b2b-cartonizer'

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
  freight_packaging: 'box' | 'pallet' | 'other' | null
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
  machship: {
    carrierId:                number
    carrierServiceId:         number
    companyCarrierAccountId?: number
    routeSnapshot:            RouteOption
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
  packaging: 'box' | 'pallet' | 'other' | null
  manual_handling?: boolean | null
}

// Pack items into MachShip shipping units (cartons/pallets) using the configured
// boxes + pallet spec. Falls back to one-carton-per-line when no boxes are set so
// quoting/booking never breaks. Shared by getLiveQuote and the booking path so a
// booked consignment matches its quote. manualHandling is flagged on every unit
// when ANY item needs it (the carrier handles the whole consignment).
export async function packForMachShip(
  items: PackForMachShipItem[],
  opts: { packMode?: PackMode } = {},
): Promise<MachShipItem[]> {
  const anyManualHandling = items.some(i => i.manual_handling)
  const [boxes, settings] = await Promise.all([loadFreightBoxes(), loadFreightSettings()])
  const pallet: PalletSpec = {
    length_mm:     settings?.freight_pallet_length_mm ?? null,
    width_mm:      settings?.freight_pallet_width_mm ?? null,
    max_height_mm: settings?.freight_pallet_max_height_mm ?? null,
    max_weight_g:  settings?.freight_pallet_max_weight_g ?? null,
    threshold_g:   settings?.freight_pallet_threshold_g ?? null,
  }
  const packed = packItems(
    items.map(it => ({
      sku: it.sku, name: it.name, qty: it.qty,
      weight_g: it.weight_g, length_mm: it.length_mm, width_mm: it.width_mm, height_mm: it.height_mm,
      packaging: it.packaging,
    })),
    boxes, pallet, { mode: opts.packMode },
  )
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
  const markup = Number(settings.freight_markup_percent ?? 20)
  // Sender suburb/postcode are required even for a routes call.
  if (!settings.machship_from_suburb || !settings.machship_from_postcode) {
    return { mode: 'unavailable', reason: 'MachShip sender address not configured in B2B Settings' }
  }

  // Pack the items into real shipping units (cartons/pallets). Shared with the
  // booking path so the consignment matches the quote.
  const machshipItems = await packForMachShip(items.map(it => ({
    sku: it.sku, name: it.name, qty: it.qty,
    weight_g: it.freight_weight_g, length_mm: it.freight_length_mm,
    width_mm: it.freight_width_mm, height_mm: it.freight_height_mm,
    packaging: it.freight_packaging, manual_handling: it.manual_handling,
  })), { packMode: opts.packMode })

  let routes: RouteOption[]
  try {
    const r = await getRoutes({
      fromLocation: { suburb: settings.machship_from_suburb, postcode: settings.machship_from_postcode },
      toLocation:   { suburb: dest.suburb,                   postcode: dest.postcode },
      items: machshipItems,
    })
    routes = r.routes || []
  } catch (e: any) {
    if (e instanceof MachShipNotConfiguredError) return { mode: 'unavailable', reason: e.message }
    if (e instanceof MachShipApiError)            return { mode: 'unavailable', reason: e.message }
    return { mode: 'unavailable', reason: `MachShip getRoutes failed: ${e?.message || e}` }
  }
  if (routes.length === 0) {
    return { mode: 'unavailable', reason: 'No MachShip routes available for this destination' }
  }

  // Inbound-freight per-unit surcharge, charged to the distributor. Summed
  // across the cart (× qty) and added on top of the marked-up carrier price —
  // cost recovery, so no extra markup. (Manual handling is NOT a fixed fee — it
  // flags the item to MachShip above so the carrier price already reflects it.)
  const surchargeExGst = round2(items.reduce((sum, it) => {
    const inbound = Number(it.inbound_freight_cost_ex_gst || 0)
    return sum + inbound * Number(it.qty || 0)
  }, 0))

  const markupMultiplier = 1 + (markup / 100)
  const rates: LiveQuoteRate[] = routes.map(r => {
    const base   = Number(r.consignmentTotal?.totalSellPrice || 0)
    const marked = round2(round2(base * markupMultiplier) + surchargeExGst)
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
      machship: {
        carrierId:               r.carrier.id,
        carrierServiceId:        r.carrierService.id,
        companyCarrierAccountId: r.companyCarrierAccountId,
        routeSnapshot:           r,
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
  packaging: 'box' | 'pallet' | 'other' | null
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

function packagingForMachShip(p: LiveQuoteCartItem['freight_packaging']): 'Carton' | 'Pallet' | 'Skid' {
  if (p === 'pallet') return 'Pallet'
  // 'box' and 'other' both fall to Carton — MachShip's catch-all small
  // package type that every carrier they aggregate supports.
  return 'Carton'
}

function round1(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
function round3(n: number): number { return Math.round(n * 1000) / 1000 }
