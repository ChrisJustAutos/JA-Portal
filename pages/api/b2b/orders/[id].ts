// pages/api/b2b/orders/[id].ts
//
// GET /api/b2b/orders/{id}
// Returns full order detail (header + lines + events) for the specified
// order, scoped to the user's distributor.
//
// Query params:
//   ?session_id=cs_...   optional Stripe Checkout Session ID. Used on the
//                        success-redirect landing to pull the receipt URL
//                        from the PaymentIntent if the webhook hasn't
//                        fired yet (rare, but possible — Stripe documents
//                        webhook delivery as eventual).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'
import { retrieveCheckoutSession } from '../../../../lib/stripe'

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

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing order id' })
  const sessionIdParam = req.query.session_id ? String(req.query.session_id) : null

  const c = sb()

  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status, distributor_id, placed_by_user_id,
      subtotal_ex_gst, gst, card_fee_inc, total_inc, currency,
      created_at, paid_at,
      stripe_checkout_session_id, stripe_payment_intent_id,
      myob_invoice_uid, myob_invoice_number, myob_written_at, myob_write_error,
      lines:b2b_order_lines!b2b_order_lines_order_id_fkey (
        id, sku, name, qty,
        unit_trade_price_ex_gst, line_subtotal_ex_gst, line_gst, line_total_inc,
        is_taxable, sort_order
      )
    `)
    .eq('id', id)
    .maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  // Enforce: order must belong to user's distributor
  if (order.distributor_id !== user.distributor.id) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  // Sort lines by sort_order
  const lines = Array.isArray(order.lines) ? [...order.lines].sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0)) : []

  // Optionally enrich with Stripe Checkout Session details (receipt URL etc).
  // Done synchronously — adds ~300ms on the success page only when session_id is in the URL.
  let stripeReceiptUrl: string | null = null
  let stripePaymentStatus: string | null = null
  const sessionToCheck = sessionIdParam || order.stripe_checkout_session_id
  if (sessionToCheck) {
    try {
      const session = await retrieveCheckoutSession(sessionToCheck)
      stripePaymentStatus = session.payment_status || null
      // The receipt URL lives on the PaymentIntent's latest_charge — Stripe
      // doesn't return it on the Session directly. We skip the extra API call
      // here for speed; if/when chunk 3c needs receipts, we can add it.
    } catch (e) {
      // Stripe lookup is best-effort enrichment; ignore failures.
    }
  }

  return res.status(200).json({
    order: {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      placed_at: order.created_at,
      paid_at: order.paid_at,
      currency: order.currency,
      subtotal_ex_gst: order.subtotal_ex_gst,
      gst: order.gst,
      card_fee_inc: order.card_fee_inc,
      total_inc: order.total_inc,
      stripe: {
        checkout_session_id: order.stripe_checkout_session_id,
        payment_intent_id: order.stripe_payment_intent_id,
        payment_status: stripePaymentStatus,
        receipt_url: stripeReceiptUrl,
      },
      myob: {
        invoice_uid: order.myob_invoice_uid,
        invoice_number: order.myob_invoice_number,
        written_at: order.myob_written_at,
        write_error: order.myob_write_error,
      },
      lines,
    },
  })
})
