// lib/myob-accounts-cache.ts
// Local snapshot of the MYOB chart of accounts (per company file).
// Backs the keyword-match tier of the AP line resolver — see
// lib/ap-line-resolver.ts. Refreshed lazily when the snapshot is older
// than CACHE_TTL_HOURS or when the caller explicitly forces a refresh.
//
// Scope: only Expense + CostOfSales accounts (the postable buckets for
// AP bills). Header rows are kept so the UI can show parent context if
// needed but are filtered out for matching.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { searchAccounts, CompanyFileLabel, MyobAccountLite } from './ap-myob-lookup'

// How long a snapshot is considered fresh. 24h is plenty — chart of
// accounts barely changes day-to-day; the lazy-refresh on stale read
// keeps things up to date without a separate cron.
const CACHE_TTL_HOURS = 24

// Account types we sync. The resolver only suggests postable accounts.
const SYNC_TYPES = ['Expense', 'CostOfSales']

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface CachedAccount {
  uid: string
  displayId: string
  name: string
  type: string
  parentName: string | null
  isHeader: boolean
}

interface SyncResult {
  companyFile: CompanyFileLabel
  fetched: number
  upserted: number
  skipped: number
  durationMs: number
}

/**
 * Pull every Expense + CostOfSales account from MYOB and upsert into
 * myob_accounts_cache. Loud failure if MYOB rejects the call.
 *
 * Called lazily by getCachedAccounts when the cache is stale, and can
 * be invoked directly by an admin endpoint if the user wants to force
 * a refresh after creating a new account in MYOB.
 */
export async function syncAccountsCache(label: CompanyFileLabel): Promise<SyncResult> {
  const startMs = Date.now()
  // searchAccounts caps at 100 per call; the chart of accounts is typically
  // < 200 rows so a single pull-by-type with empty query is sufficient.
  // We pull each type separately — searchAccounts allows a types[] filter
  // but the underlying $top cap is the same.
  const all: MyobAccountLite[] = []
  for (const t of SYNC_TYPES) {
    const batch = await searchAccounts(label, '', 100, [t])
    all.push(...batch)
  }

  const c = sb()
  let upserted = 0
  let skipped = 0
  const nowIso = new Date().toISOString()

  if (all.length > 0) {
    const rows = all.map(a => ({
      myob_company_file: label,
      uid:               a.uid,
      display_id:        a.displayId || '',
      name:              a.name || '',
      type:              a.type || '',
      parent_name:       a.parentName,
      is_header:         a.isHeader,
      last_synced_at:    nowIso,
    }))
    const { error } = await c
      .from('myob_accounts_cache')
      .upsert(rows, { onConflict: 'myob_company_file,uid' })
    if (error) throw new Error(`accounts cache upsert failed: ${error.message}`)
    upserted = rows.length
  } else {
    skipped = 1
  }

  return {
    companyFile: label,
    fetched: all.length,
    upserted,
    skipped,
    durationMs: Date.now() - startMs,
  }
}

/**
 * Read cached accounts. Triggers a lazy refresh if the snapshot is older
 * than CACHE_TTL_HOURS (or empty). Returns header rows excluded by
 * default — pass `includeHeaders: true` to get the full tree.
 */
export async function getCachedAccounts(
  label: CompanyFileLabel,
  opts: { includeHeaders?: boolean; forceRefresh?: boolean } = {},
): Promise<CachedAccount[]> {
  const c = sb()

  let needsRefresh = !!opts.forceRefresh
  if (!needsRefresh) {
    // Check the most-recent sync timestamp for this file.
    const { data: latest } = await c
      .from('myob_accounts_cache')
      .select('last_synced_at')
      .eq('myob_company_file', label)
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) {
      needsRefresh = true
    } else {
      const ageMs = Date.now() - new Date(latest.last_synced_at).getTime()
      if (ageMs > CACHE_TTL_HOURS * 3600 * 1000) needsRefresh = true
    }
  }

  if (needsRefresh) {
    try {
      await syncAccountsCache(label)
    } catch (e: any) {
      // Don't block the caller on a refresh failure — return whatever
      // stale data we have. The resolver treats keyword-match as a soft
      // suggestion, so missing it is better than crashing the triage pass.
      console.error(`[accounts-cache] lazy refresh for ${label} failed: ${e?.message}`)
    }
  }

  let q = c
    .from('myob_accounts_cache')
    .select('uid, display_id, name, type, parent_name, is_header')
    .eq('myob_company_file', label)
  if (!opts.includeHeaders) q = q.eq('is_header', false)

  const { data, error } = await q
  if (error) throw new Error(`accounts cache read failed: ${error.message}`)
  return (data || []).map(r => ({
    uid:        r.uid,
    displayId:  r.display_id,
    name:       r.name,
    type:       r.type,
    parentName: r.parent_name,
    isHeader:   r.is_header,
  }))
}
