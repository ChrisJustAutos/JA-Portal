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

// ── In-flight order commitments ────────────────────────────────────────
// A B2B order is "in-flight" when it's been placed but the MYOB invoice
// hasn't been written yet (so MYOB QtyAvailable still reflects the
// pre-order amount). We deduct in-flight commitments from the MYOB qty
// to compute the true "available to commit right now" number — keeping
// two distributors from both grabbing the last 10 of something during
// the gap between checkout-start and MYOB-invoice-written.
//
// Definition: myob_invoice_uid IS NULL AND status NOT IN ('cancelled','refunded').
// Once myob_invoice_uid is populated, MYOB has decremented stock and our
// stock cache will catch up on the next refresh.

/**
 * Returns a map of catalogue_id → qty currently committed to in-flight
 * orders. Defaults to 0 for any catalogue id not present.
 */
export async function getCommittedQtyByCatalogue(
  catalogueIds: string[],
): Promise<Record<string, number>> {
  if (catalogueIds.length === 0) return {}
  const c = sb()
  const { data, error } = await c
    .from('b2b_order_lines')
    .select(`
      catalogue_id, qty,
      order:b2b_orders!b2b_order_lines_order_id_fkey ( status, myob_invoice_uid )
    `)
    .in('catalogue_id', catalogueIds)
  if (error) throw new Error(`Committed qty lookup failed: ${error.message}`)

  const out: Record<string, number> = {}
  for (const row of (data || []) as any[]) {
    const order = Array.isArray(row.order) ? row.order[0] : row.order
    if (!order) continue
    if (order.myob_invoice_uid) continue                  // already deducted in MYOB
    if (order.status === 'cancelled' || order.status === 'refunded') continue
    out[row.catalogue_id] = (out[row.catalogue_id] || 0) + Number(row.qty || 0)
  }
  return out
}

/**
 * For a stock entry + its committed quantity, returns the qty a
 * distributor can commit to a new order. Returns null for non-inventoried
 * (no cap).
 */
export function availableQty(
  info: StockInfo | null | undefined,
  committed: number,
): number | null {
  if (!info) return 0
  if (!info.isInventoried) return null
  return Math.max(0, info.qtyAvailable - (committed || 0))
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
  const refreshStart = Date.now()
  await refreshAllStock()
  console.log(`[b2b-stock] cache miss → refreshAllStock took ${Date.now() - refreshStart}ms`)

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
 *
 * Two phases:
 *   1. Paginated MYOB Inventory.Item fetch
 *   2. ONE bulk UPDATE via the b2b_bulk_update_stock SQL function
 */
export async function refreshAllStock(): Promise<{ scanned: number; updated: number }> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  // Phase 1: paginated MYOB fetch
  const fetchStart = Date.now()
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
  const fetchMs = Date.now() - fetchStart

  // Build the update payload. We trust QuantityAvailable as the canonical
  // "what can we sell right now" number; falls back to QuantityOnHand
  // for non-tracked items (where Available may be null).
  const cachedAt = new Date().toISOString()
  const updates: { uid: string; qty: number; is_inventoried: boolean; cached_at: string }[] = []
  for (const it of allItems) {
    const uid = it.UID
    if (!uid) continue
    const isInv = it.IsInventoried !== false
    const qty = isInv
      ? Number(it.QuantityAvailable ?? it.QuantityOnHand ?? 0)
      : 0
    updates.push({ uid, qty, is_inventoried: isInv, cached_at: cachedAt })
  }

  // Phase 2: one-shot bulk UPDATE via the SQL function. Replaces what was
  // previously ~N sequential UPDATE round trips (a major part of the
  // first-load cliff on /b2b/catalogue).
  const writeStart = Date.now()
  let updated = 0
  if (updates.length > 0) {
    const c = sb()
    const { data, error } = await c.rpc('b2b_bulk_update_stock', { updates })
    if (error) throw new Error(`Stock bulk update failed: ${error.message}`)
    updated = typeof data === 'number' ? data : 0
  }
  const writeMs = Date.now() - writeStart

  console.log(`[b2b-stock] refreshAllStock: ${allItems.length} from MYOB in ${fetchMs}ms, ${updated} rows updated in ${writeMs}ms`)
  return { scanned: allItems.length, updated }
}
