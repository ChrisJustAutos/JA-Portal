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
    })
  }

  if (req.method === 'POST') {
    const r = await bookFreightForOrder(orderId, { actorId: null })
    if (!r.ok) {
      try { await svc().from('b2b_order_events').insert({ order_id: orderId, event_type: 'freight_book_via_email_failed', actor_type: 'system', actor_id: null, notes: (r.error || '').slice(0, 500) }) } catch {}
      return res.status(r.httpStatus).json({ ok: false, error: r.error, notConfigured: r.notConfigured, alreadyBooked: r.alreadyBooked, consignment_number: r.consignment_number })
    }
    try { await svc().from('b2b_order_events').insert({ order_id: orderId, event_type: 'freight_booked_via_email', actor_type: 'system', actor_id: null, metadata: { consignment_number: r.consignment_number, tracking_number: r.tracking_number } }) } catch {}
    return res.status(200).json({ ok: true, consignment_number: r.consignment_number, tracking_number: r.tracking_number, status: r.status, eta_utc: r.eta_utc })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}
