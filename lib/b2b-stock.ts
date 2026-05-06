// lib/b2b-stock.ts
//
// Live stock lookup for the B2B catalogue, with a 5-minute server-side
// cache stored on b2b_catalogue (qty_available, is_inventoried, stock_cached_at).
//
// Strategy: when ANY queried UID is stale, refresh ALL JAWS inventory in
// one paginated MYOB call. With ~94 items this is cheap (~2 s) and keeps
// the catalogue page consistent — either everyone gets fresh stock, or
// everyone gets cached. Avoids partial refresh complexity.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'

const STOCK_TTL_MS = 5 * 60 * 1000  // 5 minutes
const PAGE_SIZE = 400               // MYOB caps $top at 400

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface StockInfo {
  qtyAvailable: number          // current QuantityAvailable from MYOB
  isInventoried: boolean         // false = unlimited (services, etc.)
  cachedAt: string               // ISO
}

export type StockMap = Record<string, StockInfo>

// Three-state UI helper. Used by both the API and the frontend.
export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock'

export function stockState(info: StockInfo | null | undefined): StockState {
  if (!info) return 'out_of_stock'
  if (!info.isInventoried) return 'in_stock'  // unlimited
  if (info.qtyAvailable >= 5)  return 'in_stock'
  if (info.qtyAvailable >= 1)  return 'low_stock'
  return 'out_of_stock'
}

// ── Public API ─────────────────────────────────────────────────────────
/**
 * Returns a stock map for the requested item UIDs. If any are stale (or
 * missing a cache entry), triggers a full JAWS inventory refresh first.
 */
export async function getStockForItems(uids: string[]): Promise<StockMap> {
  if (uids.length === 0) return {}

  const c = sb()
  const cutoff = new Date(Date.now() - STOCK_TTL_MS).toISOString()

  // 1. Look up current cache state for the requested UIDs
  const { data: rows, error } = await c
    .from('b2b_catalogue')
    .select('myob_item_uid, qty_available, is_inventoried, stock_cached_at')
    .in('myob_item_uid', uids)
  if (error) throw new Error(`Stock cache lookup failed: ${error.message}`)

  const fresh: StockMap = {}
  let needsRefresh = false
  for (const r of (rows || [])) {
    const uid = r.myob_item_uid
    if (!uid) continue
    if (!r.stock_cached_at || r.stock_cached_at < cutoff) {
      needsRefresh = true
    } else {
      fresh[uid] = {
        qtyAvailable:  Number(r.qty_available || 0),
        isInventoried: r.is_inventoried !== false,
        cachedAt:      r.stock_cached_at,
      }
    }
  }
  // Any requested UID not in rows at all → also needs refresh (might be a
  // catalogue row that hasn't had its first stock fetch yet)
  const haveCacheRows = new Set((rows || []).map((r: any) => r.myob_item_uid))
  for (const uid of uids) {
    if (!haveCacheRows.has(uid)) needsRefresh = true
  }

  if (!needsRefresh) return fresh

  // 2. Refresh all JAWS inventory and re-query
  await refreshAllStock()

  const { data: refreshed, error: rErr } = await c
    .from('b2b_catalogue')
    .select('myob_item_uid, qty_available, is_inventoried, stock_cached_at')
    .in('myob_item_uid', uids)
  if (rErr) throw new Error(`Stock cache re-read failed: ${rErr.message}`)

  const out: StockMap = {}
  for (const r of (refreshed || [])) {
    if (!r.myob_item_uid) continue
    out[r.myob_item_uid] = {
      qtyAvailable:  Number(r.qty_available || 0),
      isInventoried: r.is_inventoried !== false,
      cachedAt:      r.stock_cached_at || new Date().toISOString(),
    }
  }
  return out
}

/**
 * Forces a fresh fetch of all JAWS inventory and updates b2b_catalogue
 * stock columns for any UID that has a matching catalogue row.
 *
 * Items in MYOB that aren't in our catalogue are ignored. This is a
 * one-way write — never modifies the catalogue's editable fields
 * (price, visibility, description, image).
 */
export async function refreshAllStock(): Promise<{ scanned: number; updated: number }> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  // Fetch all inventory items, paginated. Active filter applied client-side
  // since OData $filter on Inventory.Item has been flaky for us before.
  const allItems: any[] = []
  let skip = 0
  while (true) {
    const result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Inventory/Item`, {
      query: { '$top': PAGE_SIZE, '$skip': skip },
    })
    if (result.status !== 200) {
      throw new Error(`MYOB inventory fetch failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
    }
    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    allItems.push(...items)
    if (items.length < PAGE_SIZE) break
    skip += PAGE_SIZE
  }

  // Build update payload keyed by UID. We trust QuantityAvailable as the
  // canonical "what can we sell right now" number; falls back to
  // QuantityOnHand for non-tracked items (where Available may be null).
  const cachedAt = new Date().toISOString()
  const c = sb()
  let updated = 0

  for (const it of allItems) {
    const uid = it.UID
    if (!uid) continue
    const isInv = it.IsInventoried !== false
    const qty = isInv
      ? Number(it.QuantityAvailable ?? it.QuantityOnHand ?? 0)
      : 0  // for non-inventoried items, qty doesn't matter — flagged as unlimited

    // Upsert ONLY when a matching catalogue row exists. Cheaper to do it
    // as an UPDATE-by-uid (no row created if it doesn't already exist).
    const { error, count } = await c
      .from('b2b_catalogue')
      .update({
        qty_available: qty,
        is_inventoried: isInv,
        stock_cached_at: cachedAt,
      }, { count: 'exact' })
      .eq('myob_item_uid', uid)
      .select('id', { head: true, count: 'exact' })

    if (!error && count && count > 0) updated++
  }

  return { scanned: allItems.length, updated }
}
