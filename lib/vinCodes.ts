// lib/vinCodes.ts
// Supabase-backed VIN prefix → model code mapping. Cached in-memory for 60s.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

export interface VinRule {
  id: number
  vin_prefix: string
  model_code: string
  friendly_name: string | null
  notes: string | null
}

export interface VinRulesSnapshot {
  rules: VinRule[]
  // Rules indexed by prefix for fast lookup. Longest prefix wins when multiple match.
  prefixMap: Record<string, VinRule>
  // Prefixes sorted longest-first — iterate in this order to find best match
  sortedPrefixes: string[]
  fetchedAt: number
}

let _cache: VinRulesSnapshot | null = null
const CACHE_TTL_MS = 60 * 1000

export async function getVinRules(force = false): Promise<VinRulesSnapshot> {
  const now = Date.now()
  if (!force && _cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) return _cache

  const sb = getClient()
  const { data, error } = await sb.from('vin_model_codes').select('id, vin_prefix, model_code, friendly_name, notes')
  if (error) throw error

  const rules: VinRule[] = data || []
  const prefixMap: Record<string, VinRule> = {}
  rules.forEach(r => { prefixMap[r.vin_prefix] = r })
  // Longest prefixes first — allows a 5-char rule to override a 4-char rule for the same VIN
  const sortedPrefixes = rules.map(r => r.vin_prefix).sort((a, b) => b.length - a.length)

  _cache = { rules, prefixMap, sortedPrefixes, fetchedAt: now }
  return _cache
}

export function invalidateVinCache() { _cache = null }

// Resolve a single VIN (or Customer PO field value) to its model code.
// Returns null if no rule matches — caller decides how to display.
export function lookupVinModel(vinOrPo: string, snapshot: VinRulesSnapshot): VinRule | null {
  if (!vinOrPo) return null
  const v = vinOrPo.trim().toUpperCase()
  // VINs are 17 chars — but we also tolerate shorter strings in case the field
  // contains a partial VIN. Minimum practical prefix length is 4 chars.
  if (v.length < 4) return null
  for (const prefix of snapshot.sortedPrefixes) {
    if (v.startsWith(prefix.toUpperCase())) return snapshot.prefixMap[prefix]
  }
  return null
}

// Classify a string as "is this a VIN?" — used by admin UI to separate
// VINs-we-haven't-mapped-yet from non-VIN junk (customer names, "STK" codes, phone refs, etc).
// Heuristic: 17-char alphanumeric-only → almost certainly a VIN.
//            Shorter but all-uppercase-alphanumeric → probably a VIN fragment.
//            Contains spaces, lowercase, or special chars → probably not a VIN.
export function looksLikeVin(s: string): boolean {
  if (!s) return false
  const v = s.trim()
  if (v.length < 8) return false
  // A real VIN is 17 characters, all uppercase letters + digits, no I/O/Q.
  // We accept 8-17 char uppercase+digit as "might be a VIN".
  return /^[A-Z0-9]{8,17}$/.test(v)
}
