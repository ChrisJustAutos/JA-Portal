// pages/api/cron/b2b-payment-check.ts
// Runs a few times a day and closes the loop on B2B payments, in both
// directions:
//
//   Pass 1 — not settled here, but paid in MYOB. Reads the Sale Invoice's
//     balance; once it's ≈ 0 the order is marked settled and admins notified.
//     Mainly BECS Direct Debit, which lands days after the order.
//
//   Pass 2 — settled here, but never receipted in MYOB. The settlement webhook
//     is the primary path; this is the safety net for when it doesn't fire,
//     errors, or is skipped. JAWSB2B0059 sat like this for four days with
//     $4,074.46 against it and nothing watching, because every recovery path
//     was keyed on a field that order never got. This pass is keyed on the
//     money instead: settled, and no payment recorded.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/b2b-payment-check

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from '../../../lib/myob'

export const config = { maxDuration: 120 }
const DEFAULT_BATCH = 40

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || ''), 10) || DEFAULT_BATCH, 200))
  const c = sb()

  // Orders that are fulfilled but not yet settled, and have a real MYOB invoice
  // to check (created at book-freight). Not cancelled/refunded.
  const { data: orders, error } = await c
    .from('b2b_orders')
    .select('id, order_number, myob_sale_invoice_uid, payment_method, distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name )')
    .is('payment_settled_at', null)
    .not('myob_sale_invoice_uid', 'is', null)
    .not('status', 'in', '(cancelled,refunded)')
    .order('myob_payment_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) return res.status(500).json({ error: error.message })
  if (!orders || orders.length === 0) return res.status(200).json({ ok: true, checked: 0, settled: 0 })

  let conn: any = null
  try { conn = await getConnection('JAWS') } catch {}
  if (!conn) return res.status(200).json({ ok: false, checked: 0, settled: 0, error: 'JAWS MYOB connection not configured' })

  const nowIso = new Date().toISOString()
  let settled = 0
  const settledOrders: string[] = []
  for (const o of orders as any[]) {
    try {
      const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/Invoice/Item/${o.myob_sale_invoice_uid}`)
      let isPaid = false
      if (r.status === 200 && r.data) {
        const balance = Number(r.data.BalanceDueAmount ?? r.data.TotalAmount ?? -1)
        const status = String(r.data.Status || '')
        isPaid = (isFinite(balance) && balance <= 0.005) || status.toLowerCase() === 'closed'
      }
      if (isPaid) {
        await c.from('b2b_orders').update({ payment_settled_at: nowIso, myob_payment_checked_at: nowIso }).eq('id', o.id)
        await c.from('b2b_order_events').insert({ order_id: o.id, event_type: 'payment_settled', actor_type: 'system', actor_id: null, notes: `Payment applied in MYOB (${o.payment_method || 'card'}) — invoice closed.` }).then(() => {}, () => {})
        const dist: any = Array.isArray(o.distributor) ? o.distributor[0] : o.distributor
        try {
          const { notify } = await import('../../../lib/notifications')
          await notify({ module: 'b2b', title: `Payment settled — ${o.order_number}`, body: `${dist?.display_name || 'Distributor'} payment is now applied in MYOB.`, href: `/admin/b2b/orders/${o.id}`, dedupeKey: `b2b-settled:${o.id}`, roles: ['admin', 'manager'] })
        } catch {}
        settled++; settledOrders.push(o.order_number)
      } else {
        await c.from('b2b_orders').update({ myob_payment_checked_at: nowIso }).eq('id', o.id)
      }
    } catch (e: any) {
      console.error(`b2b-payment-check: order ${o.id} failed:`, e?.message || e)
    }
  }

  const applied = await applyOutstandingPayments(c, limit)

  return res.status(200).json({ ok: true, checked: orders.length, settled, settledOrders, ...applied })
}

/**
 * Pass 2 — orders whose money has cleared but which have no MYOB customer
 * payment against them. Skips anything settled in the last 15 minutes so this
 * never races the settlement webhook, and test orders, which have no real money
 * behind them. applyCustomerPaymentInMyob resolves the live MYOB document and
 * is idempotent, so a repeat run is a no-op.
 */
async function applyOutstandingPayments(c: SupabaseClient, limit: number) {
  const graceIso = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  const { data: outstanding, error } = await c
    .from('b2b_orders')
    .select('id, order_number, total_inc, payment_method, distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name )')
    .not('payment_settled_at', 'is', null)
    .lt('payment_settled_at', graceIso)
    .is('myob_payment_uid', null)
    .is('myob_payment_at', null)
    .not('status', 'in', '(cancelled,refunded)')
    .or('is_test.is.false,is_test.is.null')
    .order('payment_settled_at', { ascending: true })
    .limit(limit)
  if (error || !outstanding || outstanding.length === 0) {
    return { outstanding: 0, applied: 0, appliedOrders: [] as string[] }
  }

  const { applyCustomerPaymentInMyob } = await import('../../../lib/accounting/post-b2b-doc')
  let applied = 0
  const appliedOrders: string[] = []
  for (const o of outstanding as any[]) {
    try {
      const pay = await applyCustomerPaymentInMyob(o.id)
      if (pay.status !== 'created' || !pay.myob_payment_uid) continue
      applied++; appliedOrders.push(o.order_number)
      await c.from('b2b_order_events').insert({
        order_id: o.id, event_type: 'myob_payment_applied', actor_type: 'system', actor_id: null,
        notes: `Customer payment → Undeposited Funds, applied to the MYOB ${pay.appliedTo || 'order'} (${pay.myob_payment_uid}) — swept up by the payment-check cron.`,
        metadata: { myob_payment_uid: pay.myob_payment_uid, applied_to: pay.appliedTo || 'order', source: 'b2b-payment-check-cron' },
      }).then(() => {}, () => {})
      // Worth telling someone: reaching this pass means the webhook missed it.
      const dist: any = Array.isArray(o.distributor) ? o.distributor[0] : o.distributor
      try {
        const { notify } = await import('../../../lib/notifications')
        await notify({
          module: 'b2b',
          title: `Payment receipted in MYOB — ${o.order_number}`,
          body: `${dist?.display_name || 'Distributor'}'s cleared payment had not reached MYOB; it has now been applied.`,
          href: `/admin/b2b/orders/${o.id}`, dedupeKey: `b2b-payment-swept:${o.id}`, roles: ['admin', 'manager'],
        })
      } catch {}
    } catch (e: any) {
      console.error(`b2b-payment-check: applying payment for ${o.order_number} failed:`, e?.message || e)
    }
  }
  return { outstanding: outstanding.length, applied, appliedOrders }
}
