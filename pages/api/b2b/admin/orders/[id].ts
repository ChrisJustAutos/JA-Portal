// pages/api/b2b/admin/orders/[id].ts
//
// GET   /api/b2b/admin/orders/{id}   — full detail (header + lines + events + Stripe + MYOB)
// PATCH /api/b2b/admin/orders/{id}   — update editable fields (internal_notes, carrier, tracking_number)
//
// Permission:
//   GET   → view:b2b
//   PATCH → edit:b2b_orders

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getCurrentUser } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'
import { listRefundsForPaymentIntent } from '../../../../../lib/stripe'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const PATCHABLE_FIELDS = ['internal_notes', 'carrier', 'tracking_number'] as const
type PatchableField = typeof PATCHABLE_FIELDS[number]

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing order id' })

  const user = await getCurrentUser(req)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })

  if (req.method === 'GET') {
    if (!roleHasPermission(user.role, 'view:b2b')) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    return getDetail(id, res)
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:b2b_orders')) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    return patchOrder(id, req, res, user.id)
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
}

async function getDetail(id: string, res: NextApiResponse) {
  const c = sb()

  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status,
      distributor_id, placed_by_user_id, customer_po,
      subtotal_ex_gst, gst, card_fee_inc, total_inc, refunded_total, currency,
      created_at, paid_at, picked_at, packed_at, shipped_at, delivered_at,
      cancelled_at, refunded_at,
      carrier, tracking_number, customer_notes, internal_notes,
      stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
      myob_invoice_uid, myob_invoice_number, myob_company_file,
      myob_written_at, myob_write_attempts, myob_write_error,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        id, display_name, myob_primary_customer_uid
      ),
      lines:b2b_order_lines!b2b_order_lines_order_id_fkey (
        id, sku, name, qty, myob_item_uid,
        unit_trade_price_ex_gst, line_subtotal_ex_gst, line_gst, line_total_inc,
        is_taxable, sort_order
      ),
      events:b2b_order_events!b2b_order_events_order_id_fkey (
        id, event_type, from_status, to_status,
        actor_type, actor_id, notes, metadata, created_at
      )
    `)
    .eq('id', id)
    .maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const lines = Array.isArray(order.lines)
    ? [...order.lines].sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0))
    : []
  const events = Array.isArray(order.events)
    ? [...order.events].sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    : []

  // Best-effort: pull live refund list from Stripe
  let refunds: any[] = []
  if (order.stripe_payment_intent_id) {
    try {
      const r = await listRefundsForPaymentIntent(order.stripe_payment_intent_id)
      refunds = (r.data || []).map((rf: any) => ({
        id: rf.id,
        amount: rf.amount / 100,
        currency: rf.currency,
        status: rf.status,
        reason: rf.reason,
        created: rf.created,
      }))
    } catch { /* ignore — best-effort */ }
  }

  // Resolve actor names for events for nicer display
  const actorIds = events
    .map((e: any) => e.actor_type === 'staff' ? e.actor_id : null)
    .filter((id: any): id is string => !!id)
  const uniqueActorIds = Array.from(new Set(actorIds))
  let staffById: Record<string, { name: string | null; email: string | null }> = {}
  if (uniqueActorIds.length > 0) {
    const { data: profiles } = await c
      .from('user_profiles')
      .select('id, display_name, email')
      .in('id', uniqueActorIds)
    if (profiles) {
      for (const p of profiles) {
        staffById[(p as any).id] = { name: (p as any).display_name, email: (p as any).email }
      }
    }
  }

  const eventsEnriched = events.map((e: any) => ({
    ...e,
    actor_name: e.actor_type === 'staff' && e.actor_id
      ? (staffById[e.actor_id]?.name || staffById[e.actor_id]?.email || 'Staff member')
      : (e.actor_type === 'distributor_user' ? 'Distributor' :
         e.actor_type === 'system' ? 'System' : (e.actor_type || 'Unknown')),
  }))

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor

  return res.status(200).json({
    order: {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      placed_at: order.created_at,
      paid_at: order.paid_at,
      picked_at: order.picked_at,
      packed_at: order.packed_at,
      shipped_at: order.shipped_at,
      delivered_at: order.delivered_at,
      cancelled_at: order.cancelled_at,
      refunded_at: order.refunded_at,
      currency: order.currency,
      customer_po: order.customer_po,
      subtotal_ex_gst: Number(order.subtotal_ex_gst || 0),
      gst: Number(order.gst || 0),
      card_fee_inc: Number(order.card_fee_inc || 0),
      total_inc: Number(order.total_inc || 0),
      refunded_total: Number(order.refunded_total || 0),
      carrier: order.carrier,
      tracking_number: order.tracking_number,
      customer_notes: order.customer_notes,
      internal_notes: order.internal_notes,
      distributor: dist ? {
        id: dist.id,
        display_name: dist.display_name,
        myob_customer_uid: dist.myob_primary_customer_uid,
      } : null,
      stripe: {
        checkout_session_id: order.stripe_checkout_session_id,
        payment_intent_id: order.stripe_payment_intent_id,
        charge_id: order.stripe_charge_id,
      },
      myob: {
        company_file: order.myob_company_file,
        order_uid: order.myob_invoice_uid,         // column kept as _invoice_uid for compat
        order_number: order.myob_invoice_number,   // (it stores the Sale.Order number)
        written_at: order.myob_written_at,
        write_attempts: order.myob_write_attempts,
        write_error: order.myob_write_error,
      },
      lines,
      events: eventsEnriched,
      refunds,
    },
  })
}

async function patchOrder(id: string, req: NextApiRequest, res: NextApiResponse, userId: string) {
  const c = sb()

  // Parse + whitelist patch
  let body: any = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  } catch {
    return res.status(400).json({ error: 'Bad JSON body' })
  }

  const patch: Record<string, any> = {}
  for (const k of PATCHABLE_FIELDS) {
    if (k in body) {
      const v = body[k]
      if (v === null || v === '') {
        patch[k] = null
      } else if (typeof v === 'string') {
        patch[k] = v.substring(0, k === 'internal_notes' ? 4000 : 200)
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No patchable fields supplied' })
  }

  // Look up old values for the audit event
  const { data: existing, error: exErr } = await c
    .from('b2b_orders')
    .select('id, status, ' + (PATCHABLE_FIELDS as readonly string[]).join(', '))
    .eq('id', id)
    .maybeSingle()
  if (exErr) return res.status(500).json({ error: exErr.message })
  if (!existing) return res.status(404).json({ error: 'Order not found' })

  const { data: updated, error: upErr } = await c
    .from('b2b_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (upErr) return res.status(500).json({ error: upErr.message })

  // Build a single audit event listing what changed
  const changedDescs: string[] = []
  for (const k of PATCHABLE_FIELDS) {
    if (k in patch && (existing as any)[k] !== patch[k]) {
      changedDescs.push(`${k}: "${truncate((existing as any)[k])}" → "${truncate(patch[k])}"`)
    }
  }
  if (changedDescs.length > 0) {
    await c.from('b2b_order_events').insert({
      order_id: id,
      event_type: 'admin_edited',
      from_status: (existing as any).status,
      to_status: (existing as any).status,
      actor_type: 'staff',
      actor_id: userId,
      notes: changedDescs.join(' • '),
      metadata: { fields: Object.keys(patch) },
    })
  }

  return res.status(200).json({ ok: true, order: updated })
}

function truncate(v: any): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return s.length > 50 ? s.substring(0, 47) + '…' : s
}
