// pages/api/b2b/admin/orders/[id]/mark-paid.ts
// Admin "mark paid" — runs the full post-payment pipeline without Stripe.
//
// Two cases are allowed, and only these two:
//   • TEST orders, the original purpose — so an admin can exercise the pipeline
//     end to end without money.
//   • BANK TRANSFER orders (payment_method 'bank_transfer', migration 218):
//     large orders that skipped checkout by design and are settled off-platform.
//     Recording the transfer here is what raises the drop-ship POs and sends
//     the distributor their confirmation.
//
// Everything else is still refused. A normal card/PayTo/BECS order must be
// finalised by Stripe, or the portal would show money received that never
// arrived.

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
  const { data: order } = await c.from('b2b_orders').select('id, is_test, status, payment_method').eq('id', id).maybeSingle()
  if (!order) return res.status(404).json({ error: 'Order not found' })
  const isBankTransfer = order.payment_method === 'bank_transfer'
  if (!order.is_test && !isBankTransfer) {
    return res.status(403).json({ error: 'Mark-paid is only allowed for test orders and bank-transfer orders.' })
  }
  if (order.status === 'awaiting_approval') {
    return res.status(400).json({ error: 'Approve this order first — it has not been released to the warehouse yet.' })
  }
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
