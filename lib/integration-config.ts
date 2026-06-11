// lib/integration-config.ts
// SERVER-ONLY. Integration credential resolution: integration_settings DB row
// first (set via Settings → Connections → Integrations), then the Vercel env
// var of the same name. Cached ~30s per instance so every SMS/email doesn't
// pay a DB round-trip; the admin API invalidates on save (same-instance) and
// the TTL covers other instances.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// The keys the self-service UI manages. Anything else stays env-only.
export const INTEGRATION_KEYS = [
  // ClickSend (SMS)
  'CLICKSEND_USERNAME', 'CLICKSEND_API_KEY', 'CLICKSEND_FROM',
  // Resend (transactional + campaign mail-outs)
  'RESEND_API_KEY', 'RESEND_FROM', 'RESEND_CAMPAIGN_FROM', 'RESEND_REPLY_TO', 'RESEND_WEBHOOK_SECRET',
  // Website lead intake shared token
  'CRM_INTAKE_TOKEN',
] as const
export type IntegrationKey = typeof INTEGRATION_KEYS[number]

// Keys whose values are secrets — masked in the admin API, never echoed fully.
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'CLICKSEND_API_KEY', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET',
])

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

let cache: { at: number; map: Record<string, string> } | null = null
const TTL_MS = 30_000

async function loadMap(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map
  try {
    const { data } = await sb().from('integration_settings').select('key, value')
    const map: Record<string, string> = {}
    for (const row of data || []) if (row.value != null && row.value !== '') map[row.key] = row.value
    cache = { at: Date.now(), map }
    return map
  } catch {
    return cache?.map || {}
  }
}

export function invalidateIntegrationCache() { cache = null }

/** DB value → env var → ''. */
export async function getIntegration(key: IntegrationKey | string): Promise<string> {
  const map = await loadMap()
  return (map[key] ?? process.env[key] ?? '').trim()
}

/** Resolve several keys in one cache pass. */
export async function getIntegrations<K extends string>(keys: readonly K[]): Promise<Record<K, string>> {
  const map = await loadMap()
  const out = {} as Record<K, string>
  for (const k of keys) out[k] = (map[k] ?? process.env[k] ?? '').trim()
  return out
}

/** Where the effective value comes from (admin UI display). */
export async function integrationSources(): Promise<Record<string, { source: 'db' | 'env' | null; preview: string }>> {
  invalidateIntegrationCache()
  const map = await loadMap()
  const out: Record<string, { source: 'db' | 'env' | null; preview: string }> = {}
  for (const key of INTEGRATION_KEYS) {
    const dbVal = map[key]
    const envVal = (process.env[key] || '').trim()
    const val = dbVal || envVal
    const source: 'db' | 'env' | null = dbVal ? 'db' : envVal ? 'env' : null
    const preview = !val ? ''
      : SECRET_KEYS.has(key) ? `••••${val.slice(-4)}`
      : val
    out[key] = { source, preview }
  }
  return out
}
