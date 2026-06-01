// pages/api/b2b/stripe/webhook.ts
//
// Stripe webhook endpoint. Receives checkout.session.completed events,
// marks the corresponding b2b_orders row as paid, and triggers the MYOB
// invoice writeback.
//
// Stripe webhook setup:
//   1. In Stripe Dashboard → Developers → Webhooks → Add endpoint
//   2. URL: https://justautos.app/api/b2b/stripe/webhook
//   3. Events to send: checkout.session.completed
//   4. Copy the signing secret (whsec_...) into Vercel env STRIPE_WEBHOOK_SECRET
//
// IDEMPOTENCY:
//   - Multiple deliveries of the same event are no-ops (we check status === 'paid')
//   - MYOB writeback is also idempotent (checks myob_invoice_uid)
//
// FAILURE MODE:
//   - If MYOB write fails, we still return 200 to Stripe (webhook retries
//     would not help — it's an internal/MYOB issue, not a Stripe one).
//     The error is saved to b2b_orders.myob_write_error and surfaced
//     in the staff dashboard for manual retry. Distributor still sees
//     "paid" status — they don't care about MYOB.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { verifyWebhookSignature, retrieveCheckoutSession } from '../../../../lib/stripe'
import { runPostPaymentPipeline } from '../../../../lib/b2b-order-pipeline'

// CRITICAL: disable Next's body parser — we need the raw body bytes for HMAC
export const config = {
  api: {
    bodyParser: false,
  },
}

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Read the raw request body as a string. Next streams the body on req.
async function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  // 1. Read raw body and verify signature
  let rawBody: string
  try {
    rawBody = await readRawBody(req)
  } catch (e: any) {
    console.error('webhook: failed to read body', e)
    return res.status(400).json({ error: 'Could not read body' })
  }

  const sigHeader = req.headers['stripe-signature'] as string | undefined
  const verified = verifyWebhookSignature(rawBody, sigHeader)
  if (!verified.ok) {
    console.error('webhook: signature verification failed:', verified.error)
    return res.status(400).json({ error: `Bad signature: ${verified.error}` })
  }

  const event = verified.event
  const eventType = event.type as string
  const eventId = event.id as string

  // 2. Route by event type. We currently only act on checkout.session.completed.
  // All other events get 200 OK (ignored, not an error).
  if (eventType !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: eventType })
  }

  const session = event.data?.object || {}
  const orderId = session.metadata?.order_id as string | undefined
  const stripeSessionId = session.id as string
  const paymentIntentId = (typeof session.payment_intent === 'string') ? session.payment_intent : null

  if (!orderId) {
    console.error('webhook: checkout.session.completed missing order_id metadata, session=', stripeSessionId)
    // Return 200 — re-delivery won't help. Log for ops investigation.
    return res.status(200).json({ received: true, error: 'no_order_id_in_metadata' })
  }

  const c = sb()

  // 3. Load order
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, order_number, stripe_checkout_session_id, myob_invoice_uid, admin_notified_at, dropship_po_raised_at, distributor_notified_at')
    .eq('id', orderId)
    .maybeSingle()
  if (oErr) {
    console.error('webhook: order load error', oErr)
    return res.status(500).json({ error: oErr.message })
  }
  if (!order) {
    console.error(`webhook: order ${orderId} not found (Stripe session ${stripeSessionId})`)
    return res.status(200).json({ received: true, error: 'order_not_found' })
  }

  // Sanity check: session id should match what we stored
  if (order.stripe_checkout_session_id && order.stripe_checkout_session_id !== stripeSessionId) {
    console.error(`webhook: session mismatch for order ${orderId}: stored=${order.stripe_checkout_session_id} event=${stripeSessionId}`)
    // Still proceed — different session for same order is suspicious but
    // shouldn't block the payment from being recorded if metadata is correct.
  }

  // 4. Idempotency: only fully no-op if BOTH paid AND MYOB invoice exists.
  // If paid but MYOB hasn't been written yet (writeback failed earlier),
  // fall through and retry the MYOB write.
  if (order.status === 'paid' && order.myob_invoice_uid) {
    return res.status(200).json({ received: true, already_paid: true, already_written: true, order_id: orderId })
  }

  // 5. Run the post-payment pipeline (mark paid → MYOB invoice → drop-ship POs
  // → admin + distributor emails → Slack). Extracted to lib/b2b-order-pipeline
  // so the admin "mark paid" test shortcut shares the exact same path. Steps are
  // best-effort + idempotent via the order's flag columns. Only a failed
  // mark-paid throws → 500 so Stripe retries.
  try {
    await runPostPaymentPipeline(orderId, { paymentIntentId, eventId })
  } catch (e: any) {
    console.error(`webhook: pipeline failed for order ${orderId}:`, e?.message || e)
    return res.status(500).json({ error: e?.message || 'pipeline failed' })
  }
  return res.status(200).json({ received: true, order_id: orderId, status: 'paid' })
}
