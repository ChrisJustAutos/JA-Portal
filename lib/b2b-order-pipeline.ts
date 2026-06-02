// lib/b2b-order-pipeline.ts
// SERVER-ONLY. The post-payment pipeline for a B2B order, extracted from the
// Stripe webhook so it can run from BOTH the real webhook and the admin
// "mark paid" test shortcut. Marks the order paid, writes the MYOB invoice,
// auto-raises drop-ship POs, and sends the admin + distributor notifications.
// Every step is best-effort and idempotent via the order's flag columns, so
// re-runs (Stripe retries, or webhook + shortcut) never double-fire.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { writeOrderToMyob } from './b2b-myob-invoice'
import { raiseDropShipPOsForOrder, type DropshipRaiseResult } from './b2b-dropship'
import { sendOrderPlacedAdminEmail, sendDistributorOrderEmails } from './b2b-order-notify'
import { notify } from './notifications'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface PipelineResult { ok: boolean; status: string; alreadyComplete?: boolean }

export async function runPostPaymentPipeline(orderId: string, opts: { paymentIntentId?: string | null; eventId?: string | null } = {}): Promise<PipelineResult> {
  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, order_number, myob_invoice_uid, admin_notified_at, dropship_po_raised_at, distributor_notified_at')
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(oErr.message)
  if (!order) return { ok: false, status: 'not_found' }

  // Full no-op only if both paid AND MYOB invoice written.
  if (order.status === 'paid' && order.myob_invoice_uid) return { ok: true, status: 'paid', alreadyComplete: true }

  const nowIso = new Date().toISOString()
  if (order.status !== 'paid') {
    const { error: updErr } = await c.from('b2b_orders')
      .update({ status: 'paid', paid_at: nowIso, stripe_payment_intent_id: opts.paymentIntentId || null })
      .eq('id', orderId)
    if (updErr) throw new Error(updErr.message)
    await c.from('b2b_order_events').insert({
      order_id: orderId, event_type: 'payment_succeeded', from_status: 'pending_payment', to_status: 'paid',
      actor_type: 'stripe_webhook', actor_id: null,
      notes: `${opts.eventId ? `Stripe ${opts.eventId}; ` : ''}PaymentIntent ${opts.paymentIntentId || 'n/a'}`,
      metadata: { stripe_event_id: opts.eventId, stripe_payment_intent_id: opts.paymentIntentId },
    })
  }

  // MYOB invoice writeback (guarded by myob_invoice_uid via writeOrderToMyob).
  let myobInvoiceNumber: string | null = null
  try {
    const myob = await writeOrderToMyob(orderId)
    myobInvoiceNumber = myob.myob_invoice_number || null
    await c.from('b2b_order_events').insert({
      order_id: orderId, event_type: 'myob_invoice_created', to_status: 'paid', actor_type: 'system', actor_id: null,
      notes: `MYOB invoice ${myob.myob_invoice_number || myob.myob_invoice_uid} (${myob.status})`,
      metadata: { myob_invoice_uid: myob.myob_invoice_uid, myob_invoice_number: myob.myob_invoice_number, write_status: myob.status },
    })
  } catch (e: any) {
    const errMsg = e?.message || String(e)
    console.error(`pipeline: MYOB write failed for order ${orderId}:`, errMsg)
    await c.from('b2b_orders').update({ myob_write_error: errMsg.substring(0, 1000) }).eq('id', orderId)
    await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_write_failed', to_status: 'paid', actor_type: 'system', actor_id: null, notes: errMsg.substring(0, 500), metadata: { error: errMsg } })
  }

  // Auto-raise drop-ship POs (best-effort, guarded).
  let dropshipResult: DropshipRaiseResult | undefined
  if (!order.dropship_po_raised_at) {
    try { dropshipResult = await raiseDropShipPOsForOrder(orderId, { actorId: null }) }
    catch (e: any) {
      console.error(`pipeline: auto drop-ship PO failed for order ${orderId}:`, e?.message || e)
      try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'dropship_po_failed', actor_type: 'system', actor_id: null, notes: (e?.message || String(e)).slice(0, 500) }) } catch {}
    }
  }

  // Admin "order placed" email (once per order).
  if (!order.admin_notified_at) {
    try {
      const r = await sendOrderPlacedAdminEmail(orderId, { dropshipResult })
      await c.from('b2b_order_events').insert({ order_id: orderId, event_type: r.ok ? 'admin_notified' : 'admin_notify_skipped', actor_type: 'system', actor_id: null, notes: r.ok ? `Emailed ${r.recipients?.join(', ')}` : (r.reason || 'unknown') })
    } catch (e: any) { console.error(`pipeline: admin notify failed for order ${orderId}:`, e?.message || e) }
  }

  // Distributor emails — order confirmation + tax invoice (once per order).
  if (!order.distributor_notified_at) {
    try { await sendDistributorOrderEmails(orderId, { invoiceNumber: myobInvoiceNumber }) }
    catch (e: any) { console.error(`pipeline: distributor emails failed for order ${orderId}:`, e?.message || e) }
  }

  // Portal notification + optional Slack alert (best-effort, fire-and-forget).
  try {
    const { data: detail } = await c.from('b2b_orders')
      .select(`order_number, total_inc, is_test, distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name )`)
      .eq('id', orderId).maybeSingle()
    const dist: any = Array.isArray(detail?.distributor) ? detail!.distributor[0] : detail?.distributor

    // Red badge on the B2B Portal tile for admins/managers (deduped per order,
    // so webhook retries / the admin mark-paid shortcut never double-notify).
    await notify({
      module: 'b2b',
      title: `${detail?.is_test ? '[TEST] ' : ''}New B2B order ${detail?.order_number || ''}`.trim(),
      body: `${dist?.display_name || 'Unknown distributor'} — $${Number(detail?.total_inc || 0).toFixed(2)} inc GST`,
      href: '/admin/b2b',
      dedupeKey: `b2b-paid:${orderId}`,
      roles: ['admin', 'manager'],
    })

    const { data: settings } = await c.from('b2b_settings').select('slack_new_order_webhook_url').eq('id', 'singleton').maybeSingle()
    if (settings?.slack_new_order_webhook_url) {
      await fetch(settings.slack_new_order_webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `:moneybag: ${detail?.is_test ? '[TEST] ' : ''}New B2B order *${detail?.order_number}* — ${dist?.display_name || 'unknown'} — $${Number(detail?.total_inc || 0).toFixed(2)} AUD` }),
      }).catch(err => console.error('Slack notify failed:', err))
    }
  } catch (e) { console.error('Order notify error (non-fatal):', e) }

  return { ok: true, status: 'paid' }
}
