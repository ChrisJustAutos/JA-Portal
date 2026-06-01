// pages/api/b2b/admin/orders/[id]/mark-paid.ts
// Admin "mark paid" shortcut for TEST orders — runs the full post-payment
// pipeline without Stripe. Restricted to is_test orders in pending_payment so
// an admin can never accidentally finalize a real unpaid order.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { runPostPaymentPipeline } from '../../../../../../lib/b2b-order-pipeline'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 60 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()
  const { data: order } = await c.from('b2b_orders').select('id, is_test, status').eq('id', id).maybeSingle()
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (!order.is_test) return res.status(403).json({ error: 'Mark-paid is only allowed for test orders.' })
  if (order.status !== 'pending_payment' && order.status !== 'paid') {
    return res.status(400).json({ error: `Order is ${order.status} — cannot mark paid.` })
  }

  try {
    const r = await runPostPaymentPipeline(id, { paymentIntentId: null, eventId: `admin-mark-paid:${user.id}` })
    return res.status(200).json(r)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Pipeline failed' })
  }
})
