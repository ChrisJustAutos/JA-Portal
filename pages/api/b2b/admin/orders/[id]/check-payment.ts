// POST /api/b2b/admin/orders/{id}/check-payment
//
// "Check payment" — ask Stripe directly whether the money has actually cleared,
// instead of waiting on a webhook that may never arrive.
//
// Why this exists: a card or PayTo order settles at checkout, but BECS Direct
// Debit only completes the MANDATE at checkout — the funds land 2–4 business
// days later, and the only thing that marks the order settled is Stripe's
// `checkout.session.async_payment_succeeded` webhook. If that webhook is
// missed, dropped, or fired while a deploy was rolling, the order sits
// "Paid — bank, unsettled" forever: Ship Now keeps warning about credit risk
// and the MYOB customer payment is never receipted. There was no way to ask.
//
// Deliberately mirrors the webhook's effects exactly (pages/api/b2b/stripe/
// webhook.ts, async_payment_succeeded) so it doesn't become a second, subtly
// different definition of "settled":
//   · stamp payment_settled_at (guarded on it being null, so re-pressing is safe
//     and whichever of the two arrives first wins)
//   · write a payment_settled event naming this route as the source
//   · receipt the customer payment in MYOB if the sale invoice already exists
//
// Read-only when nothing has changed: an order that is genuinely still
// clearing reports back what Stripe said and writes nothing.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { retrievePaymentIntent, retrieveCheckoutSession } from '../../../../../../lib/stripe'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Stripe PaymentIntent statuses that mean the money is ours. 'processing' is
// specifically NOT one of them — that is a BECS debit still in flight, which is
// the whole state this button exists to distinguish from cleared.
const CLEARED = new Set(['succeeded'])
const FAILED = new Set(['canceled', 'requires_payment_method'])

/**
 * Receipt the settled payment in MYOB and log it. Never throws — the Stripe
 * settlement is the fact being recorded here, and it stands whether or not
 * MYOB is reachable; the b2b-payment-check cron retries what fails.
 */
async function applyMyobPayment(c: SupabaseClient, orderId: string): Promise<{ uid: string | null; note: string | null }> {
  try {
    const { applyCustomerPaymentInMyob } = await import('../../../../../../lib/accounting/post-b2b-doc')
    const pay = await applyCustomerPaymentInMyob(orderId)
    if (pay.status === 'created' && pay.myob_payment_uid) {
      await c.from('b2b_order_events').insert({
        order_id: orderId, event_type: 'myob_payment_applied',
        actor_type: 'system', actor_id: null,
        notes: `Customer payment → Undeposited Funds, applied to the MYOB ${pay.appliedTo || 'order'} (${pay.myob_payment_uid})`,
        metadata: { myob_payment_uid: pay.myob_payment_uid, applied_to: pay.appliedTo || 'order', source: 'check-payment-button' },
      })
      return { uid: pay.myob_payment_uid, note: null }
    }
    if (pay.status === 'already_applied') return { uid: pay.myob_payment_uid, note: null }
    if (pay.status === 'invoice_already_paid') return { uid: null, note: 'The MYOB document is already fully paid — nothing to apply.' }
    return { uid: null, note: `MYOB payment not applied (${pay.status}).` }
  } catch (e: any) {
    console.error('check-payment: MYOB payment failed:', e?.message || e)
    return { uid: null, note: `Settled, but the MYOB payment failed: ${e?.message || e}` }
  }
}

export default withAuth('edit:b2b_orders', async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const orderId = String(req.query.id || '').trim()
  if (!orderId) return res.status(400).json({ error: 'Missing order id' })
  const c = sb()

  const { data: order, error: oErr } = await c.from('b2b_orders')
    .select('id, order_number, status, total_inc, payment_method, paid_at, payment_settled_at, stripe_payment_intent_id, stripe_checkout_session_id, myob_sale_invoice_uid, myob_payment_uid')
    .eq('id', orderId).maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  // Already recorded as cleared. If the money never reached MYOB, this button
  // is the repair — apply it now, rather than reporting "nothing to do" and
  // leaving the operator without any way to trigger it (JAWSB2B0059).
  if (order.payment_settled_at) {
    const when = new Date(order.payment_settled_at).toLocaleString('en-AU')
    if (order.myob_payment_uid) {
      return res.status(200).json({
        ok: true, changed: false, settled: true, myob_payment_uid: order.myob_payment_uid,
        message: `Already recorded as cleared on ${when}, and receipted in MYOB.`,
      })
    }
    const repair = await applyMyobPayment(c, orderId)
    return res.status(200).json({
      ok: true, changed: !!repair.uid, settled: true, myob_payment_uid: repair.uid,
      message: `Cleared on ${when}. ${repair.uid ? 'Customer payment receipted in MYOB.' : (repair.note || 'MYOB payment not applied.')}`,
    })
  }

  // Find the PaymentIntent. Orders placed before stripe_payment_intent_id was
  // stored only have the checkout session, which carries the intent.
  let piId = order.stripe_payment_intent_id as string | null
  let sessionStatus: string | null = null
  try {
    if (!piId && order.stripe_checkout_session_id) {
      const s: any = await retrieveCheckoutSession(String(order.stripe_checkout_session_id))
      sessionStatus = s?.payment_status || s?.status || null
      piId = typeof s?.payment_intent === 'string' ? s.payment_intent : (s?.payment_intent?.id || null)
      if (piId) {
        // Backfill it so the next check (and refunds) don't need the round trip.
        await c.from('b2b_orders').update({ stripe_payment_intent_id: piId }).eq('id', orderId).is('stripe_payment_intent_id', null)
      }
    }
  } catch (e: any) {
    return res.status(502).json({ error: `Stripe checkout session lookup failed: ${e?.message || e}` })
  }

  if (!piId) {
    return res.status(400).json({
      error: order.status === 'pending_payment'
        ? 'This checkout was never completed, so there is no payment to check.'
        : 'No Stripe payment is recorded against this order — nothing to check.',
      stripe_payment_status: sessionStatus,
    })
  }

  let pi
  try {
    pi = await retrievePaymentIntent(piId)
  } catch (e: any) {
    return res.status(502).json({ error: `Stripe lookup failed: ${e?.message || e}` })
  }

  const method = order.payment_method || 'card'
  const label = method === 'becs' ? 'Bank Direct Debit' : method === 'payto' ? 'PayTo' : 'Card'

  if (!CLEARED.has(pi.status)) {
    const stillGoing = !FAILED.has(pi.status)
    return res.status(200).json({
      ok: true, changed: false, settled: false,
      stripe_status: pi.status,
      message: stillGoing
        ? `Stripe says this ${label} payment is "${pi.status}" — not cleared yet. Bank debits normally take 2–4 business days.`
        : `Stripe says this ${label} payment is "${pi.status}" — it has NOT cleared and will not. Chase the distributor before shipping.`,
    })
  }

  // Cleared. Same three effects as the webhook, in the same order.
  const settledIso = new Date().toISOString()
  const { data: updated, error: uErr } = await c.from('b2b_orders')
    .update({ payment_settled_at: settledIso })
    .eq('id', orderId).is('payment_settled_at', null)
    .select('id')
  if (uErr) return res.status(500).json({ error: `Stripe says cleared, but saving it failed: ${uErr.message}` })

  // Empty means the webhook landed in the meantime — not an error, just a race.
  const weStamped = (updated || []).length > 0
  if (weStamped) {
    try {
      await c.from('b2b_order_events').insert({
        order_id: orderId, event_type: 'payment_settled',
        actor_type: 'admin', actor_id: user?.id || null,
        notes: `${label} payment confirmed cleared by checking Stripe directly (intent ${pi.status}).`,
        metadata: { source: 'check-payment-button', stripe_payment_intent_id: piId, stripe_status: pi.status, amount_received: pi.amount_received },
      })
    } catch (e: any) { console.error('check-payment: event insert failed (non-fatal):', e?.message || e) }
  }

  // Receipt it in MYOB. Ungated: applyCustomerPaymentInMyob resolves the live
  // document itself and falls back to the open Sale Order when the invoice
  // doesn't exist yet, which MYOB carries onto the invoice at conversion.
  const applied = await applyMyobPayment(c, orderId)
  const myobPayment = applied.uid
  const myobNote = applied.note

  return res.status(200).json({
    ok: true, changed: weStamped, settled: true,
    stripe_status: pi.status,
    amount_received: pi.amount_received,
    myob_payment_uid: myobPayment,
    message: [
      weStamped
        ? `${label} payment has cleared — the order is now marked settled.`
        : `${label} payment has cleared (already recorded while this was checking).`,
      myobPayment ? 'Customer payment receipted in MYOB.' : myobNote,
    ].filter(Boolean).join(' '),
  })
})
