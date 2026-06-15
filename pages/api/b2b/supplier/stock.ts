// pages/api/b2b/supplier/stock.ts
// GET — the signed-in supplier's products with current on-hand quantities,
// plus the shared colour thresholds. If the cached stock is stale (>5 min)
// it triggers a full MYOB refresh first so suppliers always see live-ish
// numbers without staff having to press anything.
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withSupplierAuth } from '../../../../lib/b2bSupplierAuth'
import { refreshAllStock } from '../../../../lib/b2b-stock'

export const config = { maxDuration: 60 }

const STALE_MS = 5 * 60 * 1000

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const SELECT = 'id, sku, name, qty_on_hand, is_inventoried, stock_cached_at, primary_image_url, stock_red_below, stock_amber_below'

export default withSupplierAuth(async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const c = sb()
  const uids = user.supplier.myobSupplierUids || []
  if (uids.length === 0) {
    return res.status(200).json({ supplier: { name: user.supplier.name }, items: [], thresholds: { red_below: 5, amber_below: null }, updated_at: null })
  }

  const read = () => c.from('b2b_catalogue').select(SELECT).in('myob_supplier_uid', uids).order('sku', { ascending: true })

  let { data, error } = await read()
  if (error) return res.status(500).json({ error: error.message })

  // Refresh from MYOB when the freshest cached row is stale (or never cached).
  const newest = (data || []).reduce<number>((acc, r: any) => Math.max(acc, r.stock_cached_at ? new Date(r.stock_cached_at).getTime() : 0), 0)
  if ((data || []).length > 0 && Date.now() - newest > STALE_MS) {
    try { await refreshAllStock(); ({ data, error } = await read()) } catch (e) { console.error('supplier stock refresh failed (serving cache):', e) }
  }

  const { data: cfg } = await c.from('b2b_stock_overview_config').select('red_below, amber_below').eq('id', 'singleton').maybeSingle()
  const updated = (data || []).reduce<string | null>((acc, r: any) => (!acc || (r.stock_cached_at && r.stock_cached_at > acc) ? (r.stock_cached_at || acc) : acc), null)

  return res.status(200).json({
    supplier: { name: user.supplier.name },
    items: data || [],
    thresholds: { red_below: cfg?.red_below ?? 5, amber_below: cfg?.amber_below ?? null },
    updated_at: updated,
  })
})
