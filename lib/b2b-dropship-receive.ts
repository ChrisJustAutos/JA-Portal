// lib/b2b-dropship-receive.ts
// SERVER-ONLY "supplier confirmed" receiving flow for drop-ship orders.
//
// Why this exists: order B2B-2026-000040 (Torrisi) — MYOB rejected the
// Sale Order → Invoice conversion with Inventory_InsufficientStockMultipleLocation
// because the drop-ship line's stock was never RECEIVED: the supplier PO
// (MPI) was still an open purchase order, so the "MPI DS" location had no
// stock for the sale line to draw from.
//
// The fix, run when the supplier confirms the drop-ship order:
//   1. Convert each un-billed drop-ship PURCHASE ORDER to a BILL in MYOB
//      (native Order:{UID}-link conversion — receives stock into the
//      supplier's DS location). Bill uid/number/billed_at are recorded on
//      the order's dropship_pos jsonb entries (migration 190 adds the
//      order-level dropship_po_billed_at stamp + the dropship_billing_at
//      concurrency claim).
//   2. Retry the SAME sale-side sequence freight booking runs: sale order →
//      invoice conversion, then customer-payment receipting — respecting the
//      existing idempotency gates (myob_sale_invoice_uid, myob_payment_uid,
//      payment_settled_at).
//
// All accounting calls go through lib/accounting/post-b2b-doc (the
// MYOB/Xero provider seam), matching the rest of the B2B module.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { convertDropShipPoToBill, convertOrderToInvoiceInMyob, applyCustomerPaymentInMyob } from './accounting/post-b2b-doc'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface ReceiveStep {
  step: string
  ok: boolean
  detail: string
}

export interface ReceiveDropShipResult {
  ok: boolean
  httpStatus: number
  steps: ReceiveStep[]
  error?: string
}

export async function receiveDropShipPo(orderId: string, opts: { actorId?: string | null } = {}): Promise<ReceiveDropShipResult> {
  const c = svc()
  const steps: ReceiveStep[] = []

  const { data: order, error: oErr } = await c.from('b2b_orders')
    .select('id, order_number, dropship_pos, dropship_po_billed_at, myob_invoice_uid, myob_sale_invoice_uid, myob_payment_uid, tracking_number, carrier, freight_service_label')
    .eq('id', orderId).maybeSingle()
  if (oErr) return { ok: false, httpStatus: 500, steps, error: oErr.message }
  if (!order) return { ok: false, httpStatus: 404, steps, error: 'Order not found' }

  const initialPos: any[] = Array.isArray(order.dropship_pos) ? order.dropship_pos : []
  if (!initialPos.some(p => p?.myob_po_uid)) {
    return { ok: false, httpStatus: 400, steps, error: 'This order has no raised drop-ship purchase orders to bill.' }
  }

  // Claim the stage — a double-click (or two staff) must not both reach MYOB:
  // each POST /Purchase/Bill/Item creates a real bill. Claims from crashed
  // runs expire in 10 min (lib/b2b-claims, migration 190 adds the column).
  const { claimOrderStage, releaseOrderStage } = await import('./b2b-claims')
  if (!(await claimOrderStage(c, orderId, 'dropship_billing_at'))) {
    return { ok: false, httpStatus: 409, steps, error: 'Another receive run is in progress for this order — wait a moment and refresh.' }
  }
  try {
    // Re-read under the claim — a racing run may have just billed/converted.
    const { data: fresh } = await c.from('b2b_orders')
      .select('dropship_pos, dropship_po_billed_at, myob_invoice_uid, myob_sale_invoice_uid, myob_payment_uid, tracking_number, carrier, freight_service_label')
      .eq('id', orderId).maybeSingle()
    const o: any = fresh || order

    // ── 1. Convert each un-billed drop-ship PO → Bill ────────────────────
    let currentPos: any[] = Array.isArray(o.dropship_pos) ? o.dropship_pos : initialPos
    const billed: any[] = []
    for (const po of [...currentPos]) {
      if (!po?.myob_po_uid) continue
      const label = `bill_po:${po.supplier_name || po.myob_po_number || po.myob_po_uid}`
      if (po.myob_bill_uid) {
        steps.push({ step: label, ok: true, detail: `Already billed — ${po.myob_bill_number || po.myob_bill_uid}${po.billed_at ? ` (${String(po.billed_at).substring(0, 10)})` : ''}` })
        continue
      }
      try {
        const bill = await convertDropShipPoToBill({
          poUid: po.myob_po_uid,
          supplierName: po.supplier_name || null,
          journalMemo: `B2B drop-ship received; order ${order.order_number}`,
        })
        const nowIso = new Date().toISOString()
        currentPos = currentPos.map(p => p?.myob_po_uid === po.myob_po_uid
          ? { ...p, myob_bill_uid: bill.uid, myob_bill_number: bill.number, billed_at: nowIso }
          : p)
        // The bill EXISTS in MYOB — losing this update would let a retry bill
        // the PO twice, so a persist failure is surfaced loudly.
        const { error: upErr } = await c.from('b2b_orders').update({ dropship_pos: currentPos }).eq('id', orderId)
        if (upErr) {
          steps.push({ step: label, ok: false, detail: `Bill ${bill.number || bill.uid} WAS created in MYOB but saving it to the order failed: ${upErr.message} — do NOT re-run before recording it manually.` })
        } else {
          steps.push({ step: label, ok: true, detail: `PO ${po.myob_po_number || po.myob_po_uid} converted to bill ${bill.number || bill.uid} — stock received into the supplier's DS location` })
          billed.push({ supplier_name: po.supplier_name, myob_po_uid: po.myob_po_uid, myob_po_number: po.myob_po_number, myob_bill_uid: bill.uid, myob_bill_number: bill.number })
        }
      } catch (e: any) {
        steps.push({ step: label, ok: false, detail: (e?.message || String(e)).slice(0, 400) })
      }
    }

    const allBilled = currentPos.filter(p => p?.myob_po_uid).every(p => p?.myob_bill_uid)
    if (allBilled && !o.dropship_po_billed_at) {
      await c.from('b2b_orders').update({ dropship_po_billed_at: new Date().toISOString() }).eq('id', orderId)
    }
    if (billed.length > 0) {
      try {
        await c.from('b2b_order_events').insert({
          order_id: orderId, event_type: 'dropship_po_billed',
          actor_type: opts.actorId ? 'admin' : 'system', actor_id: opts.actorId || null,
          notes: `Supplier confirmed — ${billed.length} PO(s) converted to bill(s): ${billed.map(b => b.myob_bill_number || b.myob_bill_uid).join(', ')}`,
          metadata: { billed },
        })
      } catch (e: any) { console.error('order_events insert failed (non-fatal):', e?.message) }
    }

    // ── 2. Retry sale order → invoice conversion (same as freight booking) ─
    let hasSaleInvoice = !!o.myob_sale_invoice_uid
    if (!o.myob_invoice_uid) {
      steps.push({ step: 'convert_invoice', ok: true, detail: 'No MYOB sale order on file yet — nothing to convert.' })
    } else if (hasSaleInvoice) {
      steps.push({ step: 'convert_invoice', ok: true, detail: `Sale order already converted — invoice ${o.myob_sale_invoice_uid}` })
    } else {
      try {
        const conv = await convertOrderToInvoiceInMyob(orderId, {
          trackingNumber: o.tracking_number || null,
          carrier: o.freight_service_label || o.carrier || null,
        })
        hasSaleInvoice = true
        steps.push({ step: 'convert_invoice', ok: true, detail: `MYOB invoice ${conv.myob_sale_invoice_number || conv.myob_sale_invoice_uid} (${conv.status})` })
        try {
          await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_invoice_converted', actor_type: 'system', actor_id: null, notes: `MYOB invoice ${conv.myob_sale_invoice_number || conv.myob_sale_invoice_uid} (${conv.status})`, metadata: { myob_sale_invoice_uid: conv.myob_sale_invoice_uid, myob_sale_invoice_number: conv.myob_sale_invoice_number, status: conv.status } })
        } catch (e: any) { console.error('order_events insert failed (non-fatal):', e?.message) }
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 500)
        steps.push({ step: 'convert_invoice', ok: false, detail: msg })
        console.error(`receive-dropship: MYOB order→invoice convert failed for ${orderId}:`, msg)
        try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_invoice_convert_failed', actor_type: 'system', actor_id: null, notes: msg }) } catch {}
      }
    }

    // ── 3. Receipt the customer payment (same gates as freight booking:
    //      myob_payment_uid idempotency + payment_settled_at inside) ───────
    if (hasSaleInvoice) {
      try {
        const pay = await applyCustomerPaymentInMyob(orderId)
        const detail =
          pay.status === 'created'              ? `Customer payment receipted → Undeposited Funds (${pay.myob_payment_uid})`
          : pay.status === 'already_applied'    ? 'Payment already receipted in MYOB'
          : pay.status === 'invoice_already_paid' ? 'Invoice already shows paid in MYOB'
          : pay.status === 'not_settled'        ? 'Payment not settled yet (e.g. BECS) — receipting will run once it clears'
          : 'No invoice to receipt against'
        steps.push({ step: 'apply_payment', ok: true, detail })
        if (pay.status === 'created') {
          try {
            await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_payment_applied', actor_type: 'system', actor_id: null, notes: `Customer payment → Undeposited Funds (${pay.myob_payment_uid})`, metadata: { myob_payment_uid: pay.myob_payment_uid } })
          } catch (e: any) { console.error('order_events insert failed (non-fatal):', e?.message) }
        }
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 500)
        steps.push({ step: 'apply_payment', ok: false, detail: msg })
        console.error(`receive-dropship: MYOB customer payment failed for ${orderId}:`, msg)
        try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_payment_failed', actor_type: 'system', actor_id: null, notes: msg }) } catch {}
      }
    }

    return { ok: steps.length > 0 && steps.every(s => s.ok), httpStatus: 200, steps }
  } finally {
    await releaseOrderStage(c, orderId, 'dropship_billing_at')
  }
}
