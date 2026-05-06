// pages/api/b2b/admin/orders/index.ts
//
// GET /api/b2b/admin/orders
//
// Query params:
//   ?status=paid              filter by status (or comma-separated list)
//   ?distributor_id=<uuid>    filter to single distributor
//   ?date_from=YYYY-MM-DD     placed after (inclusive)
//   ?date_to=YYYY-MM-DD       placed before (inclusive)
//   ?search=<text>            matches order_number or customer_po (ILIKE %term%)
//   ?limit=50                 default 50, max 200
//   ?offset=0                 pagination offset
//
// Permission: view:b2b (any role with B2B view access can see orders).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_STATUSES = [
  'pending_payment', 'paid', 'picking', 'packed',
  'shipped', 'delivered', 'cancelled', 'refunded',
]

export default withAuth('view:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()

  // Parse filters
  const statusParam = String(req.query.status || '').trim()
  const statuses: string[] = statusParam
    ? statusParam.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s))
    : []
  const distributorId = String(req.query.distributor_id || '').trim() || null
  const dateFrom = String(req.query.date_from || '').trim() || null
  const dateTo   = String(req.query.date_to   || '').trim() || null
  const search   = String(req.query.search    || '').trim() || null

  const limitRaw  = parseInt(String(req.query.limit  || '50'), 10)
  const offsetRaw = parseInt(String(req.query.offset || '0'),  10)
  const limit  = isFinite(limitRaw)  ? Math.max(1, Math.min(200, limitRaw))  : 50
  const offset = isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

  // Build query (separate count query for totals)
  let q = c.from('b2b_orders').select(`
    id, order_number, status, customer_po,
    subtotal_ex_gst, gst, card_fee_inc, total_inc, refunded_total, currency,
    created_at, paid_at, shipped_at, cancelled_at,
    myob_invoice_uid, myob_invoice_number, myob_write_error,
    distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( id, display_name )
  `, { count: 'exact' })

  if (statuses.length > 0) q = q.in('status', statuses)
  if (distributorId)       q = q.eq('distributor_id', distributorId)
  if (dateFrom)            q = q.gte('created_at', `${dateFrom}T00:00:00`)
  if (dateTo)              q = q.lte('created_at', `${dateTo}T23:59:59`)
  if (search) {
    // ILIKE on order_number OR customer_po. Supabase doesn't support OR
    // across columns directly here; use the .or() builder.
    const term = search.replace(/[,()]/g, '')
    q = q.or(`order_number.ilike.%${term}%,customer_po.ilike.%${term}%`)
  }

  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) return res.status(500).json({ error: error.message })

  // Aggregate totals across the FILTERED set (not just this page).
  // We re-issue a small aggregate query for the same filters.
  let totals = { count: count || 0, total_inc_sum: 0, paid_sum: 0 }
  try {
    let agg = c.from('b2b_orders').select('total_inc, status')
    if (statuses.length > 0) agg = agg.in('status', statuses)
    if (distributorId)       agg = agg.eq('distributor_id', distributorId)
    if (dateFrom)            agg = agg.gte('created_at', `${dateFrom}T00:00:00`)
    if (dateTo)              agg = agg.lte('created_at', `${dateTo}T23:59:59`)
    if (search) {
      const term = search.replace(/[,()]/g, '')
      agg = agg.or(`order_number.ilike.%${term}%,customer_po.ilike.%${term}%`)
    }
    const { data: aggRows } = await agg
    if (aggRows) {
      for (const r of aggRows) {
        const t = Number((r as any).total_inc || 0)
        totals.total_inc_sum += t
        if (['paid','picking','packed','shipped','delivered'].includes((r as any).status)) {
          totals.paid_sum += t
        }
      }
    }
  } catch { /* totals best-effort */ }

  // Per-status counts (for filter pill badges)
  const { data: statusRows } = await c
    .from('b2b_orders')
    .select('status')
  const statusCounts: Record<string, number> = {}
  for (const s of VALID_STATUSES) statusCounts[s] = 0
  if (statusRows) {
    for (const r of statusRows) statusCounts[(r as any).status] = (statusCounts[(r as any).status] || 0) + 1
  }
  statusCounts['_all'] = statusRows?.length || 0

  // Distributor list (for the filter select)
  const { data: dists } = await c
    .from('b2b_distributors')
    .select('id, display_name')
    .eq('is_active', true)
    .order('display_name')

  return res.status(200).json({
    orders: data || [],
    total_count: count || 0,
    page: { limit, offset },
    totals: {
      total_inc_sum: Math.round(totals.total_inc_sum * 100) / 100,
      paid_sum:      Math.round(totals.paid_sum      * 100) / 100,
    },
    status_counts: statusCounts,
    distributors: dists || [],
  })
})
