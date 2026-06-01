// pages/api/b2b/order-action/freight.ts
// Login-less, token-gated freight action for the admin "Book Freight" email
// button. No user session — a signed HMAC token (scope 'book_freight') is the
// authorization. GET returns an order summary for the confirmation page; POST
// books the consignment (idempotent via lib/b2b-freight-book).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { verifyOrderAction } from '../../../../lib/order-action-token'
import { bookFreightForOrder } from '../../../../lib/b2b-freight-book'

export const config = { maxDuration: 60 }

function svc() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = String((req.method === 'POST' ? (req.body?.token) : req.query.token) || '')
  const v = verifyOrderAction(token, 'book_freight')
  if (!v) return res.status(401).json({ error: 'This link is invalid or has expired.' })
  const orderId = v.orderId

  if (req.method === 'GET') {
    const c = svc()
    const { data: order } = await c.from('b2b_orders').select(`
        order_number, status, total_inc, freight_service_label,
        machship_carrier_id, machship_consignment_id, machship_consignment_number, tracking_number, freight_status,
        freight_book_scheduled_at,
        shipping_address_snapshot,
        distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name, ship_suburb, ship_state, ship_postcode )
      `).eq('id', orderId).maybeSingle()
    if (!order) return res.status(404).json({ error: 'Order not found' })
    const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
    const snap: any = order.shipping_address_snapshot || {}
    const shipTo = [snap.company_name || dist?.display_name, [snap.suburb || dist?.ship_suburb, snap.state || dist?.ship_state, snap.postcode || dist?.ship_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    return res.status(200).json({
      order_number: order.order_number, distributor: dist?.display_name || '', status: order.status,
      total_inc: order.total_inc, carrier_label: order.freight_service_label || null,
      has_carrier: !!order.machship_carrier_id, already_booked: !!order.machship_consignment_id,
      consignment_number: order.machship_consignment_number, tracking_number: order.tracking_number,
      freight_status: order.freight_status, ship_to: shipTo,
      scheduled_at: order.freight_book_scheduled_at || null,
    })
  }

  if (req.method === 'POST') {
    // "Book later": book the consignment NOW but set MachShip's desired despatch
    // (collection) date/time to the chosen later time — so the label/booking
    // exist immediately and the carrier knows when to collect.
    let dispatchAt: string | undefined
    if (req.body?.action === 'later') {
      const whenRaw = String(req.body?.when || '').trim()
      const when = whenRaw && !isNaN(Date.parse(whenRaw)) ? new Date(whenRaw) : null
      if (!when) return res.status(400).json({ error: 'Pick a valid despatch time.' })
      if (when.getTime() < Date.now() - 60_000) return res.status(400).json({ error: 'That time is in the past — pick a future time.' })
      dispatchAt = when.toISOString()
      // Record the desired despatch for display (booking still happens now below).
      try { await svc().from('b2b_orders').update({ freight_book_scheduled_at: dispatchAt }).eq('id', orderId) } catch {}
    }

    const r = await bookFreightForOrder(orderId, { actorId: null, dispatchAt })
    if (!r.ok) {
      try { await svc().from('b2b_order_events').insert({ order_id: orderId, event_type: 'freight_book_via_email_failed', actor_type: 'system', actor_id: null, notes: (r.error || '').slice(0, 500) }) } catch {}
      return res.status(r.httpStatus).json({ ok: false, error: r.error, notConfigured: r.notConfigured, alreadyBooked: r.alreadyBooked, consignment_number: r.consignment_number })
    }
    try { await svc().from('b2b_order_events').insert({ order_id: orderId, event_type: 'freight_booked_via_email', actor_type: 'system', actor_id: null, metadata: { consignment_number: r.consignment_number, tracking_number: r.tracking_number, dispatch_at: dispatchAt || null } }) } catch {}
    return res.status(200).json({ ok: true, consignment_number: r.consignment_number, tracking_number: r.tracking_number, status: r.status, eta_utc: r.eta_utc, dispatch_at: dispatchAt || null })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}
