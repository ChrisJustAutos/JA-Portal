// lib/b2b-freight.ts
// Postcode → zone matching and rate lookup for the B2B checkout. Backs
// /api/b2b/freight-quote (read-only, called from cart) and the admin
// CRUD on /api/b2b/admin/freight-zones.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

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
