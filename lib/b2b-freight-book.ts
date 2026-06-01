// lib/b2b-freight-book.ts
// SERVER-ONLY core that books the chosen MachShip route for a B2B order and
// stores the consignment + tracking + label. Extracted from
// pages/api/b2b/admin/orders/[id]/book-freight.ts so the authed admin button
// AND the login-less email action (token endpoint) share one implementation.
//
// Idempotent: returns alreadyBooked unless { force }. Returns notConfigured
// (instead of throwing) when MachShip has no token yet, so the email action
// page can show a friendly message.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { createConsignment, getLabelPdfBase64, MachShipApiError, MachShipNotConfiguredError, type CreateConsignmentRequest } from './b2b-machship'
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

export interface BookFreightResult {
  ok: boolean
  httpStatus: number
  error?: string
  detail?: any
  alreadyBooked?: boolean
  notConfigured?: boolean
  consignment_id?: string
  consignment_number?: string | null
  tracking_number?: string | null
  eta_utc?: string | null
  status?: string | null
  label_path?: string | null
  label_warning?: string | null
}

export async function bookFreightForOrder(orderId: string, opts: { actorId?: string | null; force?: boolean } = {}): Promise<BookFreightResult> {
  const c = svc()
  const fail = (httpStatus: number, error: string, detail?: any): BookFreightResult => ({ ok: false, httpStatus, error, detail })

  const { data: order, error: oErr } = await c.from('b2b_orders').select(`
      id, order_number, status, customer_po, distributor_id, shipping_address_snapshot,
      machship_consignment_id, machship_consignment_number,
      freight_chosen_quote, machship_carrier_id, machship_carrier_service_id, freight_service_label
    `).eq('id', orderId).maybeSingle()
  if (oErr) return fail(500, oErr.message)
  if (!order) return fail(404, 'Order not found')
  if (order.status === 'cancelled' || order.status === 'refunded') return fail(400, `Order is ${order.status} — cannot book freight.`)
  if (order.machship_consignment_id && !opts.force) {
    return { ok: false, httpStatus: 409, alreadyBooked: true, error: 'Consignment already booked for this order.', consignment_number: order.machship_consignment_number }
  }
  if (!order.machship_carrier_id || !order.machship_carrier_service_id) {
    return fail(400, 'Order has no MachShip carrier+service selected. Was it placed on a live quote?')
  }

  const { data: settings, error: sErr } = await c.from('b2b_settings').select(`
      machship_from_name, machship_from_company, machship_from_phone, machship_from_email,
      machship_from_address_line1, machship_from_address_line2,
      machship_from_suburb, machship_from_postcode, machship_from_state
    `).eq('id', 'singleton').maybeSingle()
  if (sErr) return fail(500, sErr.message)
  if (!settings?.machship_from_suburb || !settings?.machship_from_postcode) {
    return fail(400, 'MachShip sender address is not configured — set it in B2B Settings before booking.')
  }

  const snap: any = order.shipping_address_snapshot || null
  const { data: dist } = await c.from('b2b_distributors')
    .select('display_name, trading_name, primary_contact_phone, primary_contact_email, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode')
    .eq('id', order.distributor_id).maybeSingle()
  const pick = (...vals: any[]): string => { for (const v of vals) { if (v == null) continue; const s = String(v).trim(); if (s) return s } return '' }
  const recvCompany = pick(snap?.company_name, dist?.display_name, dist?.trading_name)
  const recvName = pick(snap?.recipient_name, snap?.contact_name, recvCompany)
  const recvPhone = pick(snap?.phone, dist?.primary_contact_phone)
  const recvEmail = pick(snap?.email, dist?.primary_contact_email)
  const recvLine1 = pick(snap?.line1, snap?.address_line1, dist?.ship_line1)
  const recvLine2 = pick(snap?.line2, snap?.address_line2, dist?.ship_line2)
  const recvSuburb = pick(snap?.suburb, dist?.ship_suburb)
  const recvState = pick(snap?.state, dist?.ship_state)
  const recvPost = pick(snap?.postcode, dist?.ship_postcode)
  if (!recvSuburb || !recvPost) return fail(400, 'Receiver address missing suburb/postcode — fix the order address before booking.')
  if (!recvName) return fail(400, 'Receiver has no name or company on file — set the distributor display name before booking.')

  const { data: lineRows, error: lErr } = await c.from('b2b_order_lines').select(`
      qty, sku, name, catalogue_id,
      catalogue:b2b_catalogue!b2b_order_lines_catalogue_id_fkey (
        freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging
      )`).eq('order_id', orderId)
  if (lErr) return fail(500, lErr.message)
  if (!lineRows || lineRows.length === 0) return fail(400, 'Order has no lines to ship.')
  const items: CreateConsignmentRequest['items'] = []
  const missing: string[] = []
  for (const r of lineRows as any[]) {
    const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
    const wg = cat?.freight_weight_g, lmm = cat?.freight_length_mm, wmm = cat?.freight_width_mm, hmm = cat?.freight_height_mm
    if (!wg || !lmm || !wmm || !hmm) { missing.push(`${r.sku} — ${r.name}`); continue }
    items.push({
      itemType: cat?.freight_packaging === 'pallet' ? 'Pallet' : 'Carton',
      name: String(r.name || r.sku).slice(0, 80), sku: r.sku || undefined, quantity: Number(r.qty),
      weight: Math.round(Number(wg) / 10) / 100,
      length: Math.round(Number(lmm) / 10) * 10 / 100, width: Math.round(Number(wmm) / 10) * 10 / 100, height: Math.round(Number(hmm) / 10) * 10 / 100,
    })
  }
  if (missing.length > 0) return fail(400, 'Some line items are missing freight dimensions — fix the catalogue before booking.', missing)

  const reference = order.order_number + (order.customer_po ? ` / ${order.customer_po}` : '')
  const chosen: any = order.freight_chosen_quote || {}
  const req2: CreateConsignmentRequest = {
    carrierId: Number(order.machship_carrier_id), carrierServiceId: Number(order.machship_carrier_service_id),
    companyCarrierAccountId: chosen?.companyCarrierAccountId ?? undefined,
    fromName: settings.machship_from_name || undefined, fromCompany: settings.machship_from_company || undefined,
    fromPhone: settings.machship_from_phone || undefined, fromEmail: settings.machship_from_email || undefined,
    fromAddressLine1: settings.machship_from_address_line1 || undefined, fromAddressLine2: settings.machship_from_address_line2 || undefined,
    fromLocation: { suburb: settings.machship_from_suburb, postcode: settings.machship_from_postcode },
    toName: recvName || undefined, toCompany: recvCompany || undefined, toPhone: recvPhone || undefined, toEmail: recvEmail || undefined,
    toAddressLine1: recvLine1 || undefined, toAddressLine2: recvLine2 || undefined, toLocation: { suburb: recvSuburb, postcode: recvPost },
    customerReference: reference, sendingTrackingEmail: false, items,
  }

  let consignment
  try {
    consignment = await createConsignment(req2)
  } catch (e: any) {
    console.error(`[book-freight] order ${orderId} createConsignment failed:`, e?.message || e)
    if (e instanceof MachShipNotConfiguredError) return { ok: false, httpStatus: 503, notConfigured: true, error: e.message }
    if (e instanceof MachShipApiError) return fail(502, e.message, e.detail)
    return fail(500, `createConsignment failed: ${e?.message || e}`)
  }

  const update: Record<string, any> = {
    machship_consignment_id: String(consignment.id),
    machship_consignment_number: consignment.consignmentNumber || null,
    tracking_number: consignment.carrierConsignmentId || null,
    freight_eta_at: consignment.etaUtc || consignment.etaLocal || null,
    freight_status: consignment.status?.name?.toLowerCase() || 'unmanifested',
    tracking_page_access_token: consignment.trackingPageAccessToken || null,
    last_freight_poll_at: new Date().toISOString(),
  }
  const firstBook = !order.machship_consignment_id
  if (firstBook) {
    update.shipped_at = new Date().toISOString()
    update.shipped_by = opts.actorId || null
    update.status = 'shipped'
    update.carrier = order.freight_service_label || consignment.status?.name || 'MachShip'
  }
  const { error: uErr } = await c.from('b2b_orders').update(update).eq('id', orderId)
  if (uErr) return fail(500, `Persist consignment failed: ${uErr.message}`)

  let labelWarning: string | null = null
  let labelPath: string | null = null
  try {
    const pdf = await getLabelPdfBase64(consignment.id)
    if (pdf?.content) {
      const bytes = Buffer.from(pdf.content, 'base64')
      if (bytes.length > 0) {
        const filename = (pdf.fileName || `${consignment.consignmentNumber || consignment.id}.pdf`).replace(/[^\w.\-]/g, '_').slice(0, 80)
        const path = `${orderId}/${Date.now()}-${filename}`
        const { error: upErr } = await c.storage.from(LABELS_BUCKET).upload(path, bytes, { contentType: pdf.contentType || 'application/pdf', upsert: false })
        if (upErr) labelWarning = `Label uploaded failed: ${upErr.message}`
        else { labelPath = path; await c.from('b2b_orders').update({ label_pdf_path: path }).eq('id', orderId) }
      } else labelWarning = 'Label PDF was empty'
    } else labelWarning = 'MachShip did not return label content'
  } catch (e: any) {
    labelWarning = `Label fetch failed: ${e?.message || e}`
    console.error(`book-freight: label fetch failed for order ${orderId}:`, e)
  }

  try {
    await c.from('b2b_order_events').insert({
      order_id: orderId, event_type: firstBook ? 'freight_booked' : 'freight_rebooked',
      actor_type: opts.actorId ? 'admin' : 'system', actor_id: opts.actorId || null,
      to_status: firstBook ? 'shipped' : null,
      metadata: { consignment_id: consignment.id, consignment_number: consignment.consignmentNumber, tracking_number: consignment.carrierConsignmentId, carrier_service: order.freight_service_label, label_warning: labelWarning },
    })
  } catch (e: any) { console.error('order_events insert failed (non-fatal):', e?.message) }

  // Enqueue the label for auto-printing on the workshop DYMO (best-effort). The
  // self-hosted print agent consumes label_print_jobs via Realtime.
  if (labelPath) {
    try {
      await c.from('label_print_jobs').insert({ order_id: orderId, storage_path: labelPath, consignment_number: consignment.consignmentNumber || null })
    } catch (e: any) { console.error('label_print_jobs enqueue failed (non-fatal):', e?.message) }
  }

  // Distributor "shipped + tracking" email on first booking (best-effort).
  if (firstBook) {
    try {
      await sendDistributorShippedEmail(orderId, {
        carrier: order.freight_service_label || consignment.status?.name || null,
        consignmentNumber: consignment.consignmentNumber || null,
        trackingNumber: consignment.carrierConsignmentId || null,
        trackingUrl: null,
        eta: consignment.etaUtc || consignment.etaLocal || null,
      })
    } catch (e: any) { console.error('distributor shipped email failed (non-fatal):', e?.message) }
  }

  return {
    ok: true, httpStatus: 200,
    consignment_id: String(consignment.id), consignment_number: consignment.consignmentNumber,
    tracking_number: consignment.carrierConsignmentId, eta_utc: consignment.etaUtc || consignment.etaLocal || null,
    status: consignment.status?.name || null, label_path: labelPath, label_warning: labelWarning,
  }
}
