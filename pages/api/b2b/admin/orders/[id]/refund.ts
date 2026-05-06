// pages/api/b2b/admin/orders/[id]/refund.ts
//
// POST /api/b2b/admin/orders/{id}/refund
//   body: {
//     amount?: number              // optional — omit for full refund
//     reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer'
//     notes?: string
//   }
//
// Calls Stripe Refunds API, updates `refunded_total` (and `refunded_at`
// + status if fully refunded), inserts an event row.
//
// Permission: admin:b2b   (more restrictive than other order actions —
// refunds move money so we keep them admin-only).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { createRefund } from '../../../../../../lib/stripe'
import { writeRefundCreditNoteToMyob } from '../../../../../../lib/b2b-myob-invoice'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer']

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing order id' })

  let body: any = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  } catch {
    return res.status(400).json({ error: 'Bad JSON body' })
  }

  const reason: string | undefined = body.reason && VALID_REASONS.includes(body.reason) ? body.reason : undefined
  const notes: string | null       = body.notes ? String(body.notes).substring(0, 500) : null

  // Validate amount (optional — null = full refund)
  let refundAmount: number | null = null
  if (body.amount !== undefined && body.amount !== null) {
    const n = Number(body.amount)
    if (!isFinite(n) || n <= 0) {
      return res.status(400).json({ error: 'Refund amount must be a positive number' })
    }
    refundAmount = Math.round(n * 100) / 100
  }

  const c = sb()

  // Load order
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, total_inc, refunded_total, stripe_payment_intent_id, paid_at, distributor_id')
    .eq('id', id)
    .maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  if (!order.stripe_payment_intent_id) {
    return res.status(400).json({ error: 'No Stripe payment intent — order has not been paid' })
  }
  if (!order.paid_at) {
    return res.status(400).json({ error: 'Order has not been paid' })
  }

  const totalInc        = Number(order.total_inc || 0)
  const alreadyRefunded = Number(order.refunded_total || 0)
  const remaining       = Math.max(0, totalInc - alreadyRefunded)

  if (remaining <= 0.005) {
    return res.status(409).json({ error: 'Order is already fully refunded' })
  }

  const finalAmount = refundAmount === null ? remaining : refundAmount
  if (finalAmount > remaining + 0.005) {
    return res.status(400).json({
      error: `Refund of $${finalAmount.toFixed(2)} exceeds the remaining refundable amount $${remaining.toFixed(2)}`,
    })
  }

  // Issue refund via Stripe
  let refund
  try {
    refund = await createRefund({
      payment_intent: order.stripe_payment_intent_id,
      amount: Math.round(finalAmount * 100),
      reason: reason as any,
      metadata: {
        order_id: order.id,
        actor_user_id: user.id,
      },
    })
  } catch (e: any) {
    // Log a failed-refund event so the attempt is auditable
    await c.from('b2b_order_events').insert({
      order_id: id,
      event_type: 'refund_failed',
      from_status: order.status,
      to_status: order.status,
      actor_type: 'staff',
      actor_id: user.id,
      notes: notes ? `${notes} • ${e?.message}` : (e?.message || 'Stripe refund failed'),
      metadata: { attempted_amount: finalAmount, reason },
    })
    return res.status(502).json({ error: `Stripe refund failed: ${e?.message || String(e)}` })
  }

  // Update order: increment refunded_total. If now fully refunded, set
  // refunded_at + status='refunded' (unless order is already shipped, in
  // which case we keep the operational status — partial refund of a
  // shipped order shouldn't unship it).
  const newRefundedTotal = Math.round((alreadyRefunded + finalAmount) * 100) / 100
  const fullyRefunded = newRefundedTotal >= totalInc - 0.005

  const update: Record<string, any> = {
    refunded_total: newRefundedTotal,
    updated_at: new Date().toISOString(),
  }
  if (fullyRefunded) {
    update.refunded_at = new Date().toISOString()
    // Only change status to 'refunded' if order hasn't shipped yet.
    if (!['shipped', 'delivered'].includes(order.status)) {
      update.status = 'refunded'
    }
  }

  const { data: updated, error: upErr } = await c
    .from('b2b_orders')
    .update(update)
    .eq('id', id)
    .select()
    .single()
  if (upErr) {
    // The Stripe refund succeeded but our DB update failed. Log it loudly.
    return res.status(500).json({
      error: `Refund succeeded in Stripe (${refund.id}) but DB update failed: ${upErr.message}. Manual reconciliation needed.`,
      refund_id: refund.id,
    })
  }

  // Audit event for the Stripe refund itself
  await c.from('b2b_order_events').insert({
    order_id: id,
    event_type: fullyRefunded ? 'refunded_full' : 'refunded_partial',
    from_status: order.status,
    to_status: update.status || order.status,
    actor_type: 'staff',
    actor_id: user.id,
    notes,
    metadata: {
      stripe_refund_id: refund.id,
      stripe_refund_status: refund.status,
      amount: finalAmount,
      reason,
      fully_refunded: fullyRefunded,
    },
  })

  // ─── MYOB credit note (best-effort) ────────────────────────────────
  // Stripe is the source of truth for cash. If MYOB write fails, we still
  // return success on the refund — the staff can manually create the
  // credit note in MYOB or retry. The failure is logged as its own event.
  let creditNote: { uid: string; number: string; amount: number; shape: string } | null = null
  let creditNoteError: string | null = null
  try {
    const cn = await writeRefundCreditNoteToMyob(id, finalAmount, {
      stripeRefundId: refund.id,
      reason,
    })
    creditNote = {
      uid: cn.credit_note_uid,
      number: cn.credit_note_number,
      amount: cn.amount,
      shape: cn.shape,
    }
    await c.from('b2b_order_events').insert({
      order_id: id,
      event_type: 'myob_credit_note_written',
      from_status: update.status || order.status,
      to_status:   update.status || order.status,
      actor_type: 'system',
      actor_id: null,
      notes: `MYOB credit note ${cn.credit_note_number} created (${cn.shape === 'mirror_full' ? 'full mirror of original lines' : 'single line'})`,
      metadata: {
        myob_credit_note_uid: cn.credit_note_uid,
        myob_credit_note_number: cn.credit_note_number,
        amount: cn.amount,
        shape: cn.shape,
        stripe_refund_id: refund.id,
      },
    })
  } catch (e: any) {
    creditNoteError = e?.message || String(e)
    await c.from('b2b_order_events').insert({
      order_id: id,
      event_type: 'myob_credit_note_failed',
      from_status: update.status || order.status,
      to_status:   update.status || order.status,
      actor_type: 'system',
      actor_id: null,
      notes: `MYOB credit note creation failed: ${creditNoteError?.substring(0, 400)}`,
      metadata: {
        amount: finalAmount,
        stripe_refund_id: refund.id,
      },
    })
  }

  return res.status(200).json({
    ok: true,
    refund: {
      id: refund.id,
      amount: finalAmount,
      status: refund.status,
      reason,
    },
    myob_credit_note: creditNote,
    myob_credit_note_error: creditNoteError,
    order: updated,
  })
})
