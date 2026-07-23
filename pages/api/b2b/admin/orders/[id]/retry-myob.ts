// pages/api/b2b/admin/orders/[id]/retry-myob.ts
//
// POST — re-run the post-payment pipeline for a PAID order whose MYOB write
// (or a later step) failed. The pipeline is idempotent: steps that already
// succeeded no-op on their flags, so this only re-attempts what's missing.
// Before this endpoint existed a failed MYOB write on a real order had NO
// recovery path (Stripe got its 200, mark-paid is test-only).
//
// Permission: admin:b2b

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { runPostPaymentPipeline } from '../../../../../../lib/b2b-order-pipeline'

export const config = { maxDuration: 120 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing order id' })

  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: order } = await c.from('b2b_orders')
    .select('id, status, paid_at, stripe_payment_intent_id, myob_write_error').eq('id', id).maybeSingle()
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (!order.paid_at || ['pending_payment', 'cancelled', 'refunded'].includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status} — the pipeline only runs for paid orders.` })
  }

  // Clear the stored error so a repeat failure is clearly from THIS attempt.
  await c.from('b2b_orders').update({ myob_write_error: null }).eq('id', id)
  await c.from('b2b_order_events').insert({
    order_id: id, event_type: 'pipeline_retry', actor_type: 'portal_staff', actor_id: user.id,
    notes: `Manual pipeline retry${order.myob_write_error ? ` (previous error: ${String(order.myob_write_error).slice(0, 200)})` : ''}`,
  })

  const result = await runPostPaymentPipeline(id, { paymentIntentId: order.stripe_payment_intent_id })
  const { data: after } = await c.from('b2b_orders')
    .select('myob_invoice_uid, myob_invoice_number, myob_write_error').eq('id', id).maybeSingle()
  return res.status(200).json({ ok: result.ok, pipeline: result, myob_invoice_uid: after?.myob_invoice_uid || null, myob_write_error: after?.myob_write_error || null })
})
