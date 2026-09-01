// pages/api/b2b/admin/orders/[id]/approve.ts
// Approve a large order that was submitted WITHOUT payment (migration 218).
//
// Orders at or above b2b_settings.manual_approval_threshold_inc skip Stripe and
// land as `awaiting_approval`. Nothing happens to them until someone here says
// so — Chris, 2026-09-02: "Nothing until you approve it."
//
// Approving does the warehouse half only:
//   • status → pending_payment, so it appears in the normal despatch workflow
//     (Book Shipment, pick slip, Ship now) exactly like any unpaid order
//   • the MYOB SALE ORDER is written, so the paperwork and stock commitment
//     exist while the bank transfer is arranged
//
// It deliberately does NOT raise drop-ship purchase orders. Those commit a
// supplier, and an unpaid $30k order is precisely where that shouldn't happen
// automatically — they are raised by the post-payment pipeline when the money
// lands (see mark-paid).
//
// The MYOB write is best-effort: a MYOB outage must not block the warehouse
// from picking. A failed write leaves myob_write_error on the order and is
// retried by the existing "Retry MYOB" action.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { writeOrderToMyob } from '../../../../../../lib/accounting/post-b2b-doc'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 60 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()
  const { data: order } = await c.from('b2b_orders')
    .select('id, order_number, status, total_inc, myob_invoice_uid')
    .eq('id', id).maybeSingle()
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.status !== 'awaiting_approval') {
    return res.status(400).json({ error: `Order is ${order.status} — only an order awaiting approval can be approved.` })
  }

  const { error: upErr } = await c.from('b2b_orders').update({
    status: 'pending_payment',
    approved_at: new Date().toISOString(),
    approved_by: user.id,
  }).eq('id', id).eq('status', 'awaiting_approval')   // guard against a double-click racing itself
  if (upErr) return res.status(500).json({ error: upErr.message })

  // Paperwork. Non-fatal: the approval stands either way.
  let myob: { ok: boolean; error?: string } = { ok: true }
  if (!order.myob_invoice_uid) {
    try { await writeOrderToMyob(id) }
    catch (e: any) {
      myob = { ok: false, error: String(e?.message || e).slice(0, 300) }
      console.error(`approve ${order.order_number}: MYOB write failed (non-fatal):`, myob.error)
    }
  }

  return res.status(200).json({
    ok: true,
    orderNumber: order.order_number,
    status: 'pending_payment',
    myob,
    note: 'Approved. Drop-ship POs are held until the payment is recorded.',
  })
})
