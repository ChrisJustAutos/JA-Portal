// pages/api/b2b/stripe/webhook.ts
//
// Stripe webhook endpoint. Receives checkout.session.completed events,
// marks the corresponding b2b_orders row as paid, and triggers the MYOB
// invoice writeback.
//
// Stripe webhook setup:
//   1. In Stripe Dashboard → Developers → Webhooks → Add endpoint
//   2. URL: https://ja-portal.vercel.app/api/b2b/stripe/webhook
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
import { writeOrderToMyob } from '../../../../lib/b2b-myob-invoice'

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
    .select('id, status, order_number, stripe_checkout_session_id, myob_invoice_uid')
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

  // 5. Mark order paid (only if not already)
  const nowIso = new Date().toISOString()
  if (order.status !== 'paid') {
    const { error: updErr } = await c
      .from('b2b_orders')
      .update({
        status: 'paid',
        paid_at: nowIso,
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq('id', orderId)
    if (updErr) {
      console.error('webhook: order update failed', updErr)
      // Return 500 so Stripe retries
      return res.status(500).json({ error: updErr.message })
    }

    await c.from('b2b_order_events').insert({
      order_id: orderId,
      event_type: 'payment_succeeded',
      from_status: 'pending_payment',
      to_status: 'paid',
      actor_type: 'stripe_webhook',
      actor_id: null,
      notes: `Stripe ${eventId}; PaymentIntent ${paymentIntentId || 'n/a'}`,
      metadata: {
        stripe_event_id: eventId,
        stripe_session_id: stripeSessionId,
        stripe_payment_intent_id: paymentIntentId,
        amount_total: session.amount_total,
      },
    })
  }

  // 6. Trigger MYOB writeback. Wrapped in try/catch so MYOB failure doesn't
  // 500 the webhook (Stripe would keep retrying for 3 days, won't help).
  try {
    const myob = await writeOrderToMyob(orderId)
    await c.from('b2b_order_events').insert({
      order_id: orderId,
      event_type: 'myob_invoice_created',
      to_status: 'paid',
      actor_type: 'system',
      actor_id: null,
      notes: `MYOB invoice ${myob.myob_invoice_number || myob.myob_invoice_uid} (${myob.status})`,
      metadata: {
        myob_invoice_uid: myob.myob_invoice_uid,
        myob_invoice_number: myob.myob_invoice_number,
        write_status: myob.status,
      },
    })
  } catch (e: any) {
    const errMsg = e?.message || String(e)
    console.error(`webhook: MYOB write failed for order ${orderId}:`, errMsg)
    // Don't fail the webhook — record the error and let staff retry manually
    await c.from('b2b_orders')
      .update({ myob_write_error: errMsg.substring(0, 1000) })
      .eq('id', orderId)
    await c.from('b2b_order_events').insert({
      order_id: orderId,
      event_type: 'myob_write_failed',
      to_status: 'paid',
      actor_type: 'system',
      actor_id: null,
      notes: errMsg.substring(0, 500),
      metadata: { error: errMsg },
    })
  }

  // 7. Optional Slack notification (best-effort, fire-and-forget)
  try {
    const { data: settings } = await c
      .from('b2b_settings')
      .select('slack_new_order_webhook_url')
      .eq('id', 'singleton')
      .maybeSingle()
    if (settings?.slack_new_order_webhook_url) {
      const { data: detail } = await c
        .from('b2b_orders')
        .select(`
          order_number, total_inc, distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name )
        `)
        .eq('id', orderId)
        .maybeSingle()
      const dist: any = Array.isArray(detail?.distributor) ? detail!.distributor[0] : detail?.distributor
      await fetch(settings.slack_new_order_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `:moneybag: New B2B order *${detail?.order_number}* — ${dist?.display_name || 'unknown'} — $${Number(detail?.total_inc || 0).toFixed(2)} AUD`,
        }),
      }).catch(err => console.error('Slack notify failed:', err))
    }
  } catch (e) {
    console.error('Slack notify error (non-fatal):', e)
  }

  return res.status(200).json({ received: true, order_id: orderId, status: 'paid' })
}
