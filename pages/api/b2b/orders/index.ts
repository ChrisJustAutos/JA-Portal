// pages/api/b2b/orders/index.ts
//
// GET /api/b2b/orders
// Returns the signed-in distributor user's orders (most recent first).
//
// V1 scope: only orders for the user's own distributor — combined view
// across linked dist_groups members is deferred to chunk 3c.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '50'), 10) || 50))

  const c = sb()
  const { data, error } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status,
      subtotal_ex_gst, gst, card_fee_inc, total_inc, currency,
      placed_at, paid_at,
      myob_invoice_number, myob_write_error,
      placed_by_user_id
    `)
    .eq('distributor_id', user.distributor.id)
    .order('placed_at', { ascending: false })
    .limit(limit)
  if (error) return res.status(500).json({ error: error.message })

  // Hide pending_payment orders that are stale (>1 hour old, never paid).
  // These are abandoned checkouts and just clutter the user's order history.
  const cutoff = Date.now() - 60 * 60 * 1000
  const filtered = (data || []).filter((o: any) => {
    if (o.status !== 'pending_payment') return true
    const placed = o.placed_at ? new Date(o.placed_at).getTime() : 0
    return placed > cutoff
  })

  return res.status(200).json({
    orders: filtered,
    distributor: { id: user.distributor.id, display_name: user.distributor.displayName },
  })
})
