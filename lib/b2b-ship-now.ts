// lib/b2b-ship-now.ts
// SERVER-ONLY. "Ship Now" — manifests already-booked MachShip consignments and
// then does everything that depends on the goods actually going: converts the
// MYOB Sale.Order → Sale.Invoice, receipts the payment against it, prints the
// A4 tax invoice, and emails/pushes the distributor.
//
// WHY THIS IS SPLIT FROM bookFreight (Chris, 2026-08-20): booking now only
// PREPARES the despatch — it creates the consignment (left Unmanifested in
// MachShip) and prints the pick slip + consignment note/labels so the order can
// be picked and packed. Nothing reaches the carrier and no tax invoice is raised
// until someone presses Ship Now. This deliberately reverses the 2026-08-06
// behaviour where bookFreight manifested immediately.
//
// BULK IS ONE MANIFEST, NOT N: MachShip's manifest call also books a carrier
// PICKUP window, so manifesting ten consignments individually would raise ten
// pickup requests. The endpoint takes an array precisely so a despatch run is a
// single manifest and a single pickup — we group by companyId and send one call
// per group.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  manifestConsignments,
  findConsignmentsByCarrierConsignmentId,
  findConsignmentsByReference1,
  MachShipApiError, MachShipNotConfiguredError,
  type Consignment,
} from './b2b-machship'
import { sendDistributorShippedEmail } from './b2b-order-notify'

const LABELS_BUCKET = 'b2b-shipping-labels'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface ShipNowOrderResult {
  order_id: string
  order_number: string | null
  ok: boolean
  /** Already manifested before this call — not an error, nothing was re-sent. */
  already?: boolean
  manifest_id?: string | null
  /** Non-fatal problems (MYOB deferred, email failed, …). The manifest still stands. */
  warning?: string | null
  /** Blocked only by the unsettled-BECS gate — re-run with acceptUnsettled to override. */
  becsUnsettled?: boolean
  error?: string
}

export interface ShipNowResult {
  ok: boolean
  httpStatus: number
  error?: string
  detail?: any
  notConfigured?: boolean
  results: ShipNowOrderResult[]
}

const ORDER_FIELDS = `
  id, order_number, status, distributor_id, dropship_pos, is_test,
  machship_consignment_id, machship_consignment_number, machship_manifest_id,
  machship_company_id, customer_po, freight_chosen_quote,
  tracking_number, freight_service_label, freight_status, shipped_at,
  payment_method, payment_settled_at
`

type OrderRow = {
  id: string
  order_number: string | null
  status: string | null
  distributor_id: string | null
  dropship_pos: any
  is_test: boolean | null
  machship_consignment_id: string | null
  machship_consignment_number: string | null
  machship_manifest_id: string | null
  machship_company_id: number | null
  customer_po: string | null
  freight_chosen_quote: any
  tracking_number: string | null
  freight_service_label: string | null
  freight_status: string | null
  shipped_at: string | null
  payment_method: string | null
  payment_settled_at: string | null
}

/** An order is manifestable once a consignment exists and hasn't been manifested. */
// The despatch rule lives in lib/b2b-despatch-state so the two admin screens
// and this guard cannot drift apart again. Imported for use below and
// re-exported because callers already reach for it on this module.
import { isManifested, PRE_DESPATCH_STATES } from './b2b-despatch-state'
export { isManifested }

/**
 * Everything that depends on the goods actually leaving. Best-effort throughout:
 * the manifest has already succeeded by the time we get here, so nothing in this
 * function may throw its way out and make a shipped order look unshipped.
 * Returns a human-readable warning string when something needed attention.
 */
async function finaliseShipment(c: SupabaseClient, order: OrderRow): Promise<string | null> {
  const orderId = order.id
  const warnings: string[] = []

  // MYOB Sale.Order → Sale.Invoice (hits the GL) BEFORE the email, so the
  // invoice number is on the order for the PDF/subject.
  try {
    const { convertOrderToInvoiceInMyob } = await import('./accounting/post-b2b-doc')
    const conv = await convertOrderToInvoiceInMyob(orderId, {
      trackingNumber: order.tracking_number || order.machship_consignment_number || null,
      carrier: order.freight_service_label || null,
    })
    await c.from('b2b_order_events').insert({
      order_id: orderId, event_type: 'myob_invoice_converted', actor_type: 'system', actor_id: null,
      notes: `MYOB invoice ${conv.myob_sale_invoice_number || conv.myob_sale_invoice_uid} (${conv.status})`,
      metadata: { myob_sale_invoice_uid: conv.myob_sale_invoice_uid, myob_sale_invoice_number: conv.myob_sale_invoice_number, status: conv.status },
    })

    // Receipt the Stripe payment against the new invoice (→ Undeposited Funds)
    // so it shows PAID in MYOB. Skips BECS until the debit clears
    // (payment_settled_at gate inside). Best-effort.
    try {
      const { applyCustomerPaymentInMyob } = await import('./accounting/post-b2b-doc')
      const pay = await applyCustomerPaymentInMyob(orderId)
      if (pay.status === 'created') {
        await c.from('b2b_order_events').insert({
          order_id: orderId, event_type: 'myob_payment_applied', actor_type: 'system', actor_id: null,
          notes: `Customer payment → Undeposited Funds (${pay.myob_payment_uid})`,
          metadata: { myob_payment_uid: pay.myob_payment_uid },
        })
      }
    } catch (e: any) {
      console.error(`ship-now: MYOB customer payment failed for ${orderId}:`, e?.message || e)
      warnings.push('MYOB payment receipt failed')
      try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_payment_failed', actor_type: 'system', actor_id: null, notes: (e?.message || String(e)).slice(0, 500) }) } catch {}
    }
  } catch (e: any) {
    const msg = e?.message || String(e)
    // Expected case, not a fault: the order has drop-ship POs that haven't been
    // billed yet, so MYOB (correctly) refuses to invoice a line whose stock was
    // never received. The manifest stays good; the invoice converts via the
    // receive flow once the supplier confirms.
    const unbilledDropshipPo = (Array.isArray(order.dropship_pos) ? order.dropship_pos : [])
      .some((p: any) => p?.myob_po_uid && !p?.myob_bill_uid)
    if (unbilledDropshipPo && /insufficient.?stock/i.test(msg)) {
      const friendly = 'Invoice will convert once the supplier PO is billed — use "Supplier confirmed" on the order page.'
      warnings.push(friendly)
      console.warn(`ship-now: MYOB invoice conversion deferred for ${orderId} (drop-ship PO not billed yet): ${msg}`)
      try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_invoice_convert_deferred', actor_type: 'system', actor_id: null, notes: friendly, metadata: { myob_error: msg.slice(0, 300) } }) } catch {}
    } else {
      warnings.push(`MYOB invoice conversion failed: ${msg.slice(0, 160)}`)
      console.error(`ship-now: MYOB order→invoice convert failed for ${orderId}:`, msg)
      try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'myob_invoice_convert_failed', actor_type: 'system', actor_id: null, notes: msg.slice(0, 500) }) } catch {}
    }
  }

  // A4 tax invoice to the workshop printer. Prefers the real MYOB invoice PDF
  // (falls back to the system copy), so it runs after the conversion above.
  try {
    const { getOutboundInvoicePdf } = await import('./b2b-invoice-pdf')
    const inv = await getOutboundInvoicePdf(orderId)
    const invPath = `invoices/${orderId}.pdf`
    const { error: upErr } = await c.storage.from(LABELS_BUCKET).upload(invPath, inv.buffer, { contentType: 'application/pdf', upsert: true })
    if (upErr) throw new Error(upErr.message)
    await c.from('label_print_jobs').insert({ order_id: orderId, storage_path: invPath, kind: 'invoice', consignment_number: order.machship_consignment_number || null })
  } catch (e: any) {
    console.error('ship-now: invoice print enqueue failed (non-fatal):', e?.message || e)
    warnings.push('Tax invoice did not queue for printing')
  }

  // Distributor "shipped + tax invoice" email + app push.
  try {
    await sendDistributorShippedEmail(orderId, {
      carrier: order.freight_service_label || null,
      consignmentNumber: order.machship_consignment_number || null,
      trackingNumber: order.tracking_number || null,
      trackingUrl: null,
      eta: null,
    })
  } catch (e: any) {
    console.error('ship-now: distributor shipped email failed (non-fatal):', e?.message)
    warnings.push('Distributor shipped email failed')
  }
  try {
    if (order.distributor_id) {
      const carrier = order.freight_service_label || 'courier'
      const tn = order.tracking_number || order.machship_consignment_number
      const { sendPushToDistributor } = await import('./push')
      await sendPushToDistributor(order.distributor_id, {
        title: `Order ${order.order_number || ''} shipped`.trim(),
        body: `On its way via ${carrier}${tn ? ` — tracking ${tn}` : ''}.`,
        href: `/b2b/orders/${orderId}`,
        tag: `order-${orderId}`,
      })
    }
  } catch (e: any) { console.error('ship-now: distributor shipped push failed (non-fatal):', e?.message) }

  return warnings.length ? warnings.join(' · ') : null
}

/**
 * Manifest one or more booked consignments and finalise each shipment.
 * Orders already manifested are reported as `already` and left untouched, so
 * this is safe to re-run and safe to call on a mixed selection.
 */
export async function shipNowForOrders(
  orderIds: string[],
  opts: { actorId?: string | null; acceptUnsettled?: boolean } = {},
): Promise<ShipNowResult> {
  const c = svc()
  const ids = Array.from(new Set(orderIds.map(s => String(s || '').trim()).filter(Boolean)))
  if (!ids.length) return { ok: false, httpStatus: 400, error: 'No orders given', results: [] }

  const { data: rows, error } = await c.from('b2b_orders').select(ORDER_FIELDS).in('id', ids)
  if (error) return { ok: false, httpStatus: 500, error: error.message, results: [] }

  const orders = (rows || []) as OrderRow[]
  const results: ShipNowOrderResult[] = []
  const byId = new Map(orders.map(o => [o.id, o]))
  for (const id of ids) {
    if (!byId.has(id)) results.push({ order_id: id, order_number: null, ok: false, error: 'Order not found' })
  }

  // Split into what we can actually manifest.
  const todo: OrderRow[] = []
  for (const o of orders) {
    if (!o.machship_consignment_id) {
      results.push({ order_id: o.id, order_number: o.order_number, ok: false, error: 'No MachShip consignment — book freight first' })
    } else if ((o.freight_status || '').toLowerCase() === 'consignment_missing') {
      results.push({ order_id: o.id, order_number: o.order_number, ok: false, error: 'Consignment missing in MachShip — rebook it' })
    } else if (o.payment_method === 'becs' && !o.payment_settled_at && !opts.acceptUnsettled) {
      // The credit risk lives HERE, not at booking: this is the point the goods
      // leave and the tax invoice is raised. Booking only prints paperwork.
      results.push({
        order_id: o.id, order_number: o.order_number, ok: false,
        error: 'BECS payment hasn’t settled yet — funds take 2–3 business days to clear. Ship once it settles, or approve shipping now (admin accepts the credit risk).',
        becsUnsettled: true,
      })
    } else if (isManifested(o)) {
      results.push({ order_id: o.id, order_number: o.order_number, ok: true, already: true, manifest_id: o.machship_manifest_id })
    } else {
      todo.push(o)
    }
  }
  if (!todo.length) {
    const anyOk = results.some(r => r.ok)
    return { ok: anyOk, httpStatus: anyOk ? 200 : 400, error: anyOk ? undefined : results.find(r => !r.ok)?.error, results }
  }

  // MachShip's manifest endpoint REQUIRES companyId, and createConsignment's
  // response doesn't carry it ("CompanyId is required" on Banana Coast 000043,
  // 2026-08-11) — the consignment GET does, so resolve it there. Group by it so
  // each company gets ONE manifest (= one pickup booking) for the whole run.

/**
 * Dig the companyId out of the stored MachShip rate quote. Every order booked
 * through the portal has one, and it has always carried the field — this is the
 * cheapest and most reliable source, and needs no API call at all.
 */
function companyIdFromQuote(quote: any): number | null {
  const seen = new Set<any>()
  const walk = (v: any): number | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null
    seen.add(v)
    for (const [k, val] of Object.entries(v)) {
      if (/^companyId$/i.test(k)) {
        const n = Number(val)
        if (Number.isFinite(n) && n > 0) return n
      }
      if (val && typeof val === 'object') { const hit = walk(val); if (hit) return hit }
    }
    return null
  }
  return walk(quote)
}

/**
 * Ask the CARRIER whether these consignments actually left "Unmanifested".
 * MachShip has returned a clean 200 for a manifest it never created, so a
 * successful HTTP call is not evidence of despatch — this is.
 */
async function confirmManifested(orders: OrderRow[]): Promise<boolean> {
  try {
    let checked = 0
    for (const o of orders) {
      const live = await resolveConsignmentForOrder(o)
      if (!live) continue          // couldn't read it — don't claim success
      checked++
      const st = String(live.status?.name || '').trim().toLowerCase()
      if (!st || PRE_DESPATCH_STATES.has(st)) return false
    }
    return checked === orders.length && checked > 0
  } catch (e: any) {
    console.error('[ship-now] manifest verification failed:', e?.message || e)
    return false
  }
}

/** The account-wide fallback CompanyId, set in B2B Settings. */
async function loadSettingsCompanyId(c: SupabaseClient): Promise<number | null> {
  try {
    const { data } = await c.from('b2b_settings').select('machship_company_id').limit(1).maybeSingle()
    const n = Number(data?.machship_company_id)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

/**
 * Fetch the live consignment WITHOUT the broken direct GET, using the two
 * lookup endpoints MachShip actually serves — by carrier tracking number, then
 * by our Reference 1. Same approach the freight poller uses to recover.
 */
async function resolveConsignmentForOrder(o: OrderRow): Promise<Consignment | null> {
  const tracking = String(o.tracking_number || '').trim()
  const wantId = String(o.machship_consignment_id || '').trim()
  const pick = (list: Consignment[]): Consignment | null => {
    if (!list.length) return null
    const exact = list.find(x => String(x.id) === wantId)
    if (exact) return exact
    return list.length === 1 ? list[0] : null
  }
  if (tracking) {
    const byTracking = pick(await findConsignmentsByCarrierConsignmentId([tracking]))
    if (byTracking) return byTracking
  }
  const reference = o.order_number
    ? o.order_number + (o.customer_po ? ` / ${o.customer_po}` : '')
    : ''
  if (reference) {
    const byRef = pick(await findConsignmentsByReference1([reference]))
    if (byRef) return byRef
  }
  return null
}

  // ── CompanyId, which MachShip requires on every manifest ────────────────
  //
  // This used to come from GET /apiv2/consignments/{id}. That is NOT a real
  // MachShip route — it 404s for every consignment that has ever existed. The
  // freight poller hid it by falling back to the returnConsignmentsBy*
  // lookups (its logs read "re-resolved 71024867 -> 71024867": the SAME id, so
  // nothing was ever stale — the route was wrong). Ship Now had no fallback,
  // so companyId was silently null and manifesting failed outright once
  // MachShip started enforcing it.
  //
  // Resolution order, cheapest and most trustworthy first:
  //   1. the id captured on the order when the consignment was booked
  //   2. the MachShip rate quote already stored on the order — it has carried
  //      companyId all along on every order since 2026-08-06; nothing was
  //      reading it
  //   3. the configured account-wide fallback (B2B settings)
  //   4. a live lookup by carrier tracking number / our Reference 1 — the two
  //      endpoints that actually work
  const fallbackCompanyId = await loadSettingsCompanyId(c)

  const groups = new Map<string, { companyId: number | null; orders: OrderRow[] }>()
  for (const o of todo) {
    let companyId: number | null = o.machship_company_id ?? companyIdFromQuote(o.freight_chosen_quote) ?? fallbackCompanyId ?? null

    if (!companyId) {
      try {
        const found = await resolveConsignmentForOrder(o)
        companyId = (found?.companyId ?? found?.company?.id ?? null) as number | null
        if (companyId) {
          // Persist it so this order never needs the lookup again.
          await c.from('b2b_orders').update({ machship_company_id: companyId }).eq('id', o.id)
        }
      } catch (e: any) {
        if (e instanceof MachShipNotConfiguredError) {
          return { ok: false, httpStatus: 503, notConfigured: true, error: e.message, results }
        }
        console.error(`ship-now: companyId lookup failed for order ${o.id}:`, e?.message || e)
      }
    }

    if (!companyId) {
      // Fail this order with something actionable instead of letting MachShip
      // answer "CompanyId is required", which says nothing about what to do.
      results.push({
        order_id: o.id, order_number: o.order_number, ok: false,
        error: 'Could not determine the MachShip CompanyId for this consignment. Set the fallback in B2B Settings → Freight, or re-book the freight.',
      })
      continue
    }

    const key = String(companyId)
    if (!groups.has(key)) groups.set(key, { companyId, orders: [] })
    groups.get(key)!.orders.push(o)
  }

  if (opts.acceptUnsettled) {
    for (const o of todo) {
      if (o.payment_method === 'becs' && !o.payment_settled_at) {
        try {
          await c.from('b2b_order_events').insert({
            order_id: o.id, event_type: 'note',
            actor_type: opts.actorId ? 'admin' : 'system', actor_id: opts.actorId || null,
            notes: 'Shipped BEFORE the BECS payment settled — admin approved the credit risk.',
          })
        } catch { /* best-effort audit */ }
      }
    }
  }

  for (const { companyId, orders: group } of Array.from(groups.values())) {
    const consignmentIds = group.map(o => Number(o.machship_consignment_id))
    let manifestId: string | null = null
    // Set when the pickup had to move to the next business day, so the order
    // says so rather than the warehouse expecting a truck that isn't coming.
    let pickupNote: string | null = null
    try {
      // MachShip's documented two-step flow (group, then manifest the groups).
      // The outcome is decided by bookingSuccessful/errorMessage in the
      // response, NOT by the HTTP status — a 200 has been returned for a
      // manifest that was never created.
      const outcome = await manifestConsignments(consignmentIds, { companyId })
      manifestId = outcome.manifestId
      pickupNote = outcome.rolledToNextDay
        ? `Carrier cut-off for today had passed — pickup booked for ${String(outcome.pickupDateTime || '').slice(0, 16).replace('T', ' ')}.`
        : null

      // Belt and braces: ask the carrier. MachShip has reported success for a
      // consignment it left Unmanifested, and marking an order shipped when the
      // freight is still on our floor converts the MYOB invoice and tells the
      // warehouse the job is done.
      const verified = outcome.ok ? await confirmManifested(group) : false

      if (!outcome.ok || !verified) {
        const why = outcome.errors.length
          ? outcome.errors.join('; ')
          : 'MachShip reported success but the consignment is still Unmanifested'
        console.error(`[ship-now] manifest not confirmed for ${consignmentIds.join(',')}: ${why}`)
        for (const o of group) {
          results.push({
            order_id: o.id, order_number: o.order_number, ok: false,
            error: `Not despatched — ${why}`.slice(0, 300),
          })
        }
        continue
      }
    } catch (e: any) {
      const msg = e instanceof MachShipApiError ? e.message : (e?.message || String(e))
      console.error(`ship-now: manifest failed for consignments ${consignmentIds.join(',')}:`, msg)
      for (const o of group) {
        results.push({ order_id: o.id, order_number: o.order_number, ok: false, error: `Manifest failed: ${String(msg).slice(0, 200)}` })
      }
      continue
    }

    for (const o of group) {
      // Record the manifest FIRST — it's the irreversible bit. If the downstream
      // finalise work fails we must never look unmanifested and re-manifest,
      // because that would book the carrier a second pickup.
      const patch: Record<string, any> = { freight_status: 'manifested' }
      if (manifestId) patch.machship_manifest_id = manifestId
      if (!o.shipped_at) {
        patch.shipped_at = new Date().toISOString()
        patch.shipped_by = opts.actorId || null
        patch.status = 'shipped'
        patch.carrier = o.freight_service_label || 'MachShip'
      }
      if (pickupNote) {
        try {
          await c.from('b2b_order_events').insert({
            order_id: o.id, event_type: 'note',
            actor_type: opts.actorId ? 'admin' : 'system', actor_id: opts.actorId || null,
            notes: pickupNote,
          })
        } catch { /* best-effort audit */ }
      }
      let uErr: any = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await c.from('b2b_orders').update(patch).eq('id', o.id)
        uErr = r.error
        if (!uErr) break
        await new Promise(r2 => setTimeout(r2, 1000 * (attempt + 1)))
      }
      if (uErr) {
        results.push({
          order_id: o.id, order_number: o.order_number, ok: false,
          error: `Manifested in MachShip (manifest ${manifestId || '?'}) but saving the order failed: ${uErr.message}. Do NOT re-run — set freight_status='manifested' by hand.`,
        })
        continue
      }

      try {
        await c.from('b2b_order_events').insert({
          order_id: o.id, event_type: 'freight_manifested',
          actor_type: opts.actorId ? 'admin' : 'system', actor_id: opts.actorId || null,
          notes: `Shipped now — consignment ${o.machship_consignment_number || o.machship_consignment_id} manifested${manifestId ? ` (manifest ${manifestId})` : ''}`,
          metadata: { consignment_id: o.machship_consignment_id, consignment_number: o.machship_consignment_number, manifest_id: manifestId, batch_size: group.length },
        })
      } catch (e: any) { console.error('ship-now: order_events insert failed (non-fatal):', e?.message) }

      const warning = await finaliseShipment(c, { ...o, machship_manifest_id: manifestId })
      results.push({ order_id: o.id, order_number: o.order_number, ok: true, manifest_id: manifestId, warning })
    }
  }

  const anyOk = results.some(r => r.ok)
  return { ok: anyOk, httpStatus: anyOk ? 200 : 502, error: anyOk ? undefined : results.find(r => !r.ok)?.error, results }
}
