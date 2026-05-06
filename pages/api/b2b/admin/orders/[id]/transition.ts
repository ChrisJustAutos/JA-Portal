// pages/api/b2b/admin/orders/[id]/transition.ts
//
// POST /api/b2b/admin/orders/{id}/transition
//   body: {
//     to_status: 'picking' | 'packed' | 'shipped' | 'delivered' | 'cancelled' | 'paid' (undo)
//     notes?: string                  // optional staff note attached to the event
//     carrier?: string                // required when to_status='shipped' (or already set on order)
//     tracking_number?: string        // required when to_status='shipped' (or already set on order)
//   }
//
// Validates the transition is allowed from the current status, sets the
// matching timestamp column, persists the new status, and inserts an
// event row.
//
// Permission: edit:b2b_orders

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// What status transitions are staff allowed to perform manually?
// Stripe webhook handles pending_payment → paid; that's NOT in this map.
// Refund-driven `refunded` is set by /refund endpoint, not here.
const ALLOWED: Record<string, string[]> = {
  paid:      ['picking', 'cancelled'],
  picking:   ['packed', 'paid'],          // 'paid' = undo
  packed:    ['shipped', 'picking'],      // 'picking' = undo
  shipped:   ['delivered', 'packed'],     // 'packed' = undo
  delivered: ['shipped'],                 // 'shipped' = undo
  cancelled: [],                          // terminal (re-open requires manual DB intervention)
  refunded:  [],                          // terminal
  pending_payment: ['cancelled'],         // can abandon
}

const STATUS_TIMESTAMP_COLUMN: Record<string, string | null> = {
  paid:      'paid_at',
  picking:   'picked_at',
  packed:    'packed_at',
  shipped:   'shipped_at',
  delivered: 'delivered_at',
  cancelled: 'cancelled_at',
}

export default withAuth('edit:b2b_orders', async (req: NextApiRequest, res: NextApiResponse, user: any) => {
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

  const toStatus = String(body.to_status || '').trim()
  if (!toStatus || !STATUS_TIMESTAMP_COLUMN.hasOwnProperty(toStatus) && toStatus !== 'paid') {
    // 'paid' allowed as undo target but has no separate timestamp setter (paid_at preserved)
    // STATUS_TIMESTAMP_COLUMN already has 'paid' so this branch is unreachable, kept for clarity
  }
  if (!Object.keys(ALLOWED).flatMap(k => ALLOWED[k]).includes(toStatus) && toStatus !== 'paid') {
    return res.status(400).json({ error: `Invalid target status: ${toStatus}` })
  }

  const c = sb()

  // Load current state
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, paid_at, carrier, tracking_number, total_inc, refunded_total, stripe_payment_intent_id')
    .eq('id', id)
    .maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const fromStatus = order.status
  if (!ALLOWED[fromStatus] || !ALLOWED[fromStatus].includes(toStatus)) {
    return res.status(409).json({
      error: `Cannot transition from "${fromStatus}" to "${toStatus}".`,
      allowed: ALLOWED[fromStatus] || [],
    })
  }

  // Special validation per target
  const carrier        = body.carrier        ? String(body.carrier).trim().substring(0, 100)        : null
  const trackingNumber = body.tracking_number ? String(body.tracking_number).trim().substring(0, 100) : null

  if (toStatus === 'shipped') {
    const finalCarrier  = carrier        ?? order.carrier
    const finalTracking = trackingNumber ?? order.tracking_number
    if (!finalCarrier || !finalTracking) {
      return res.status(400).json({
        error: 'Carrier and tracking number are required to mark as shipped',
      })
    }
  }

  if (toStatus === 'cancelled') {
    // If already paid and not yet fully refunded, require an explicit
    // acknowledgement that staff understands money is still held.
    const paid = !!order.paid_at
    const fullyRefunded = Number(order.refunded_total || 0) >= Number(order.total_inc || 0) - 0.01
    if (paid && !fullyRefunded && !body.confirm_cancel_without_refund) {
      return res.status(409).json({
        error: 'Order is paid and not fully refunded. Issue a refund first, or pass confirm_cancel_without_refund:true to override.',
        refunded_total: Number(order.refunded_total || 0),
        total_inc: Number(order.total_inc || 0),
      })
    }
  }

  // Build update payload
  const update: Record<string, any> = {
    status: toStatus,
    updated_at: new Date().toISOString(),
  }

  // Timestamp logic:
  //   - Forward transitions stamp the matching column with NOW()
  //   - Undo transitions (e.g. shipped→packed) clear the higher-status timestamp
  const tsCol = STATUS_TIMESTAMP_COLUMN[toStatus]
  if (tsCol) update[tsCol] = new Date().toISOString()

  // Undo transitions: clear timestamps that no longer apply
  const undoMap: Record<string, string[]> = {
    paid:      ['picked_at', 'packed_at', 'shipped_at', 'delivered_at'],   // back to paid
    picking:   ['packed_at', 'shipped_at', 'delivered_at'],
    packed:    ['shipped_at', 'delivered_at'],
    shipped:   ['delivered_at'],
  }
  // Only treat as undo if going to a lower-rank status
  const RANK: Record<string, number> = {
    paid: 1, picking: 2, packed: 3, shipped: 4, delivered: 5,
  }
  if (RANK[toStatus] && RANK[fromStatus] && RANK[toStatus] < RANK[fromStatus]) {
    for (const col of (undoMap[toStatus] || [])) update[col] = null
  }

  // If the staff supplied carrier/tracking on the same call, persist it.
  if (carrier !== null)        update.carrier         = carrier
  if (trackingNumber !== null) update.tracking_number = trackingNumber

  const { data: updated, error: upErr } = await c
    .from('b2b_orders')
    .update(update)
    .eq('id', id)
    .select()
    .single()
  if (upErr) return res.status(500).json({ error: upErr.message })

  // Audit event
  await c.from('b2b_order_events').insert({
    order_id: id,
    event_type: 'status_changed',
    from_status: fromStatus,
    to_status: toStatus,
    actor_type: 'staff',
    actor_id: user.id,
    notes: body.notes ? String(body.notes).substring(0, 500) : null,
    metadata: {
      carrier: carrier || undefined,
      tracking_number: trackingNumber || undefined,
      undo: !!(RANK[toStatus] && RANK[fromStatus] && RANK[toStatus] < RANK[fromStatus]),
    },
  })

  return res.status(200).json({ ok: true, order: updated })
})
