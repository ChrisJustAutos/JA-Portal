// pages/api/b2b/admin/orders/[id]/refund.ts
//
// POST /api/b2b/admin/orders/{id}/refund
//   body: {
//     amount?: number              // optional — omit for full refund
//     lines?: [{ line_id, qty }]   // item-selection refund (mutually exclusive with amount)
//     reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer'
//     notes?: string
//   }
//
// Calls Stripe Refunds API, updates `refunded_total` (and `refunded_at`
// + status if fully refunded), inserts an event row. Item-selection refunds
// also bump each line's refunded_qty so the same unit can't be refunded twice.
//
// Permission: admin:b2b   (more restrictive than other order actions —
// refunds move money so we keep them admin-only).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { createRefund } from '../../../../../../lib/stripe'
import { writeRefundCreditNoteToMyob, deleteMyobSaleOrder } from '../../../../../../lib/accounting/post-b2b-doc'
import type { RefundLineSelection } from '../../../../../../lib/b2b-myob-invoice'
import { claimOrderStage, releaseOrderStage } from '../../../../../../lib/b2b-claims'
import { lineMoney } from '../../../../../../lib/b2b-pricing'

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

function round2(n: number): number { return Math.round(n * 100) / 100 }

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

  // Item-selection refund: specific lines (and quantities) instead of a raw
  // dollar amount — the refund amount is DERIVED from the selection, so the
  // two inputs are mutually exclusive.
  const reqLines: Array<{ line_id: string; qty: number }> | null =
    Array.isArray(body.lines) && body.lines.length > 0 ? body.lines : null
  if (reqLines && refundAmount !== null) {
    return res.status(400).json({ error: 'Provide either amount or lines, not both' })
  }

  const c = sb()

  // Load order
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, total_inc, refunded_total, stripe_payment_intent_id, paid_at, distributor_id, myob_invoice_uid, myob_sale_invoice_uid')
    .eq('id', id)
    .maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  // Serialize refunds per order — two concurrent refunds both reading the old
  // refunded_total would under-record the cash out (lost update).
  if (!(await claimOrderStage(c, id, 'refunding_at'))) {
    return res.status(409).json({ error: 'Another refund for this order is already in progress — check the order events and retry shortly.' })
  }
  try {

  if (!order.stripe_payment_intent_id) {
    return res.status(400).json({ error: 'No Stripe payment intent — order has not been paid' })
  }
  if (!order.paid_at) {
    return res.status(400).json({ error: 'Order has not been paid' })
  }

  // Resolve an item selection into per-line refund amounts. Validated against
  // each line's refunded_qty (units already refunded this way) — the order-level
  // remaining cap below still applies to the derived total.
  let lineSelection: RefundLineSelection[] | null = null
  const priorRefundedQty = new Map<string, number>()   // line_id → refunded_qty before this refund
  if (reqLines) {
    const { data: orderLines, error: lnErr } = await c
      .from('b2b_order_lines')
      .select('id, sku, name, qty, refunded_qty, unit_trade_price_ex_gst, line_subtotal_ex_gst, line_gst, line_total_inc, is_taxable, myob_item_uid')
      .eq('order_id', id)
    if (lnErr) return res.status(500).json({ error: lnErr.message })
    const byId = new Map((orderLines || []).map(l => [String(l.id), l]))

    const seen = new Set<string>()
    lineSelection = []
    for (const sel of reqLines) {
      const lineId = String(sel?.line_id || '')
      const line = byId.get(lineId)
      if (!line) return res.status(400).json({ error: `Line ${lineId} is not on this order` })
      if (seen.has(lineId)) return res.status(400).json({ error: `Line ${line.sku}: listed more than once` })
      seen.add(lineId)
      const selQty = Number(sel?.qty)
      if (!Number.isInteger(selQty) || selQty <= 0) {
        return res.status(400).json({ error: `Line ${line.sku}: qty must be a positive integer` })
      }
      const refundable = Number(line.qty) - Number(line.refunded_qty || 0)
      if (selQty > refundable) {
        return res.status(400).json({ error: `Line ${line.sku}: only ${refundable} of ${line.qty} units still refundable` })
      }
      // Whole untouched line → use the stored (checkout-rounded) values exactly;
      // partial quantities re-derive from the unit price with per-line rounding.
      let ex: number, gst: number, inc: number
      if (selQty === Number(line.qty) && Number(line.refunded_qty || 0) === 0) {
        ex  = round2(Number(line.line_subtotal_ex_gst || 0))
        gst = line.is_taxable !== false ? round2(Number(line.line_gst || 0)) : 0
        inc = round2(Number(line.line_total_inc || 0))
      } else {
        // Same inc-anchored construction as checkout (lib/b2b-pricing), so a
        // partial refund of N units returns exactly N x the advertised inc
        // price rather than a cent under it.
        const m = lineMoney(Number(line.unit_trade_price_ex_gst || 0), selQty, line.is_taxable !== false)
        ex = m.ex; gst = m.gst; inc = m.inc
      }
      priorRefundedQty.set(lineId, Number(line.refunded_qty || 0))
      lineSelection.push({
        line_id: lineId,
        sku: line.sku,
        name: line.name,
        qty: selQty,
        unit_ex: Number(line.unit_trade_price_ex_gst || 0),
        ex, gst, inc,
        is_taxable: line.is_taxable,
        myob_item_uid: line.myob_item_uid || null,
      })
    }
    refundAmount = round2(lineSelection.reduce((s, l) => s + l.inc, 0))
    if (!(refundAmount > 0)) {
      return res.status(400).json({ error: 'Selected lines total zero — nothing to refund' })
    }
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

  // Item-selection refunds: bump each line's refunded_qty so those units can't
  // be selected again. Best-effort per line — cash truth is Stripe +
  // refunded_total; concurrency is already serialized by the claim.
  if (lineSelection) {
    for (const s of lineSelection) {
      const { error: lqErr } = await c
        .from('b2b_order_lines')
        .update({ refunded_qty: (priorRefundedQty.get(s.line_id) || 0) + s.qty })
        .eq('id', s.line_id)
      if (lqErr) console.error(`refund: refunded_qty update failed for line ${s.line_id} (${s.sku}): ${lqErr.message}`)
    }
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
      ...(lineSelection ? { lines: lineSelection.map(s => ({ line_id: s.line_id, sku: s.sku, qty: s.qty, inc: s.inc })) } : {}),
    },
  })

  // ─── MYOB credit note (best-effort) ────────────────────────────────
  // Stripe is the source of truth for cash. If MYOB write fails, we still
  // return success on the refund — the staff can manually create the
  // credit note in MYOB or retry. The failure is logged as its own event.
  let creditNote: { uid: string; number: string; amount: number; shape: string } | null = null
  let creditNoteError: string | null = null
  if (!order.myob_sale_invoice_uid) {
    // Pre-shipment: the sale exists in MYOB only as a Sale.ORDER (no GL
    // impact) — a credit note here would post a credit with no matching sale.
    // On a FULL refund, delete the open Sale.Order so it can't still be
    // picked/shipped; on a partial, leave it and just record the event.
    try {
      if (fullyRefunded && order.myob_invoice_uid) {
        const del = await deleteMyobSaleOrder(id)
        await c.from('b2b_order_events').insert({
          order_id: id, event_type: del.deleted ? 'myob_order_deleted' : 'myob_order_delete_skipped',
          from_status: update.status || order.status, to_status: update.status || order.status,
          actor_type: 'system', actor_id: null,
          notes: del.deleted ? 'Open MYOB Sale.Order deleted after full pre-shipment refund (no credit note — no GL sale existed)' : `MYOB Sale.Order left in place: ${del.reason}`,
          metadata: { stripe_refund_id: refund.id },
        })
      } else {
        await c.from('b2b_order_events').insert({
          order_id: id, event_type: 'myob_credit_note_skipped',
          from_status: update.status || order.status, to_status: update.status || order.status,
          actor_type: 'system', actor_id: null,
          notes: 'No MYOB credit note: order not yet invoiced (pre-shipment). Reduce the eventual invoice or cancel the order instead.',
          metadata: { amount: finalAmount, stripe_refund_id: refund.id },
        })
      }
    } catch (e: any) {
      creditNoteError = e?.message || String(e)
      await c.from('b2b_order_events').insert({
        order_id: id, event_type: 'myob_order_delete_failed',
        from_status: update.status || order.status, to_status: update.status || order.status,
        actor_type: 'system', actor_id: null,
        notes: `MYOB Sale.Order delete failed after full refund — remove it in MYOB by hand: ${creditNoteError?.substring(0, 300)}`,
        metadata: { stripe_refund_id: refund.id },
      })
    }
  } else {
  try {
    const cn = await writeRefundCreditNoteToMyob(id, finalAmount, {
      stripeRefundId: refund.id,
      reason,
      lineSelection: lineSelection || undefined,
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
      notes: `MYOB credit note ${cn.credit_note_number} created (${cn.shape === 'mirror_full' ? 'full mirror of original lines' : cn.shape === 'mirror_lines' ? 'mirror of selected lines' : 'single line'})`,
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
  } finally {
    await releaseOrderStage(c, id, 'refunding_at')
  }
})
