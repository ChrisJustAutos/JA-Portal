// lib/b2b-bundles.ts
// SERVER-ONLY. "Includes" bundles: a parent catalogue product that
// automatically ships with one or more child products (e.g. every JA turbo
// includes a TGFK gasket/fitting kit).
//
// Children are NOT stored as cart lines — they're DERIVED from
// b2b_product_bundles wherever a cart/order is materialised (cart display,
// totals, checkout order-lines, MYOB). That keeps freight correct (the parent
// carries the combined carton; children never reach the cartonizer) and
// avoids the (cart_id, catalogue_id) collision when a child is ALSO bought on
// its own. See migrations/124_b2b_product_bundles.sql.

import { SupabaseClient } from '@supabase/supabase-js'

export type BundlePriceMode = 'included' | 'added'

export interface BundleChildCatalogue {
  id: string
  myob_item_uid: string | null
  sku: string | null
  name: string | null
  trade_price_ex_gst: number | null
  is_taxable: boolean | null
  b2b_visible: boolean | null
  primary_image_url: string | null
  is_drop_ship: boolean | null
}

export interface BundleChild {
  parent_catalogue_id: string
  child_catalogue_id: string
  qty: number
  price_mode: BundlePriceMode
  sort_order: number
  child: BundleChildCatalogue
}

/**
 * Load the bundle component definitions for a set of PARENT catalogue ids.
 * Returns a Map keyed by parent_catalogue_id → ordered children (empty Map when
 * none of the ids are bundle parents). Children whose catalogue row is gone are
 * skipped. Only b2b_visible children are returned by default — a hidden child
 * can't legally ride along — pass includeHidden to override (admin editor).
 */
export async function loadBundleChildren(
  c: SupabaseClient,
  parentIds: string[],
  opts: { includeHidden?: boolean } = {},
): Promise<Map<string, BundleChild[]>> {
  const out = new Map<string, BundleChild[]>()
  const ids = Array.from(new Set((parentIds || []).filter(Boolean)))
  if (ids.length === 0) return out

  const { data, error } = await c
    .from('b2b_product_bundles')
    .select(`
      parent_catalogue_id, child_catalogue_id, qty, price_mode, sort_order,
      child:b2b_catalogue!b2b_product_bundles_child_catalogue_id_fkey (
        id, myob_item_uid, sku, name, trade_price_ex_gst, is_taxable,
        b2b_visible, primary_image_url, is_drop_ship
      )
    `)
    .in('parent_catalogue_id', ids)
    .order('sort_order', { ascending: true })
  if (error) throw new Error('bundle children load failed: ' + error.message)

  for (const row of (data || []) as any[]) {
    const child: BundleChildCatalogue | null = Array.isArray(row.child) ? row.child[0] : row.child
    if (!child) continue
    if (!opts.includeHidden && child.b2b_visible === false) continue
    const entry: BundleChild = {
      parent_catalogue_id: row.parent_catalogue_id,
      child_catalogue_id:  row.child_catalogue_id,
      qty:                 Math.max(1, Number(row.qty || 1)),
      price_mode:          row.price_mode === 'added' ? 'added' : 'included',
      sort_order:          Number(row.sort_order || 0),
      child,
    }
    const list = out.get(row.parent_catalogue_id) || []
    list.push(entry)
    out.set(row.parent_catalogue_id, list)
  }
  return out
}

// The unit price of a bundle child for a given price_mode. 'included' children
// post at $0 (value baked into the parent); 'added' children charge their own
// trade price. (Bundle components don't get promo/volume-break pricing — they
// ride along at a flat figure for simplicity.)
export function bundleChildUnitPriceExGst(child: BundleChild): number {
  if (child.price_mode === 'included') return 0
  const p = Number(child.child.trade_price_ex_gst || 0)
  return p > 0 ? p : 0
}
