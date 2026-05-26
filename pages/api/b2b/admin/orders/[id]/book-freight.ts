// pages/api/b2b/admin/orders/[id]/book-freight.ts
//
// Admin endpoint that books the chosen MachShip route on a B2B order
// and stores the resulting consignment + tracking + label.
//
// POST /api/b2b/admin/orders/{id}/book-freight
//   body: {} (no fields — the order already carries the chosen quote)
//   query: ?force=1 to re-book even if a consignment id is already set
//
// Side-effects, in order:
//   1. POST /apiv2/consignments/createConsignment with the snapshot
//      saved at checkout time (machship_carrier_id + service_id, plus
//      sender from b2b_settings, receiver from b2b_distributors).
//   2. Persist consignment id, number, carrierConsignmentId (tracking
//      number), ETA, status, trackingPageAccessToken on the order.
//   3. GET /apiv2/labels/getItemPdfFileInfo, store the base64 PDF in
//      the b2b-shipping-labels bucket, set label_pdf_path.
//   4. Log a b2b_order_events row for the audit trail.
//
// Errors out before mutating anything if the precondition checks fail
// (no chosen quote, no sender address, distributor missing ship_*).
// Label fetch failure is non-fatal — the consignment is already
// booked, so we keep the consignment data and surface a warning to
// the admin.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import {
  createConsignment,
  getLabelPdfBase64,
  MachShipApiError,
  MachShipNotConfiguredError,
  type CreateConsignmentRequest,
} from '../../../../../../lib/b2b-machship'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const LABELS_BUCKET = 'b2b-shipping-labels'

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 60,
}

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const force = String(req.query.force || '') === '1'

  const c = sb()

  // ── Load order + linked rows ──
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status, customer_po,
      distributor_id,
      shipping_address_snapshot,
      machship_consignment_id, machship_consignment_number,
      freight_chosen_quote, machship_carrier_id, machship_carrier_service_id, freight_service_label
    `)
    .eq('id', id)
    .maybeSingle()
  if (oErr)   return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.status === 'cancelled' || order.status === 'refunded') {
    return res.status(400).json({ error: `Order is ${order.status} — cannot book freight.` })
  }
  if (order.machship_consignment_id && !force) {
    return res.status(409).json({ error: 'Consignment already booked for this order. Pass ?force=1 to re-book.' })
  }
  if (!order.machship_carrier_id || !order.machship_carrier_service_id) {
    return res.status(400).json({ error: 'Order has no MachShip carrier+service selected. Was it placed on a live quote?' })
  }

  // ── Sender (pickup) — from singleton settings ──
  const { data: settings, error: sErr } = await c
    .from('b2b_settings')
    .select(`
      machship_from_name, machship_from_company, machship_from_phone, machship_from_email,
      machship_from_address_line1, machship_from_address_line2,
      machship_from_suburb, machship_from_postcode, machship_from_state
    `)
    .eq('id', 'singleton')
    .maybeSingle()
  if (sErr) return res.status(500).json({ error: sErr.message })
  if (!settings?.machship_from_suburb || !settings?.machship_from_postcode) {
    return res.status(400).json({ error: 'MachShip sender address is not configured — set it in B2B Settings before booking.' })
  }

  // ── Receiver — prefer the snapshot taken at order time, fall back
  // to the distributor's current shipping address. ──
  let recvName    = ''
  let recvCompany = ''
  let recvPhone   = ''
  let recvEmail   = ''
  let recvLine1   = ''
  let recvLine2   = ''
  let recvSuburb  = ''
  let recvState   = ''
  let recvPost    = ''
  const snap: any = order.shipping_address_snapshot || null
  if (snap && typeof snap === 'object') {
    recvName    = String(snap.recipient_name || snap.contact_name || '').trim()
    recvCompany = String(snap.company_name   || '').trim()
    recvPhone   = String(snap.phone          || '').trim()
    recvEmail   = String(snap.email          || '').trim()
    recvLine1   = String(snap.line1          || snap.address_line1 || '').trim()
    recvLine2   = String(snap.line2          || snap.address_line2 || '').trim()
    recvSuburb  = String(snap.suburb         || '').trim()
    recvState   = String(snap.state          || '').trim()
    recvPost    = String(snap.postcode       || '').trim()
  }
  if (!recvSuburb || !recvPost) {
    // Fall back to the distributor's primary ship_* fields.
    const { data: dist } = await c
      .from('b2b_distributors')
      .select('display_name, primary_contact_phone, primary_contact_email, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode')
      .eq('id', order.distributor_id)
      .maybeSingle()
    recvCompany = recvCompany || (dist?.display_name || '')
    recvPhone   = recvPhone   || (dist?.primary_contact_phone || '')
    recvEmail   = recvEmail   || (dist?.primary_contact_email || '')
    recvLine1   = recvLine1   || (dist?.ship_line1 || '')
    recvLine2   = recvLine2   || (dist?.ship_line2 || '')
    recvSuburb  = recvSuburb  || (dist?.ship_suburb || '')
    recvState   = recvState   || (dist?.ship_state || '')
    recvPost    = recvPost    || (dist?.ship_postcode || '')
  }
  if (!recvSuburb || !recvPost) {
    return res.status(400).json({ error: 'Receiver address missing suburb/postcode — fix the order address before booking.' })
  }

  // ── Items — pull from order lines joined to catalogue freight cols ──
  const { data: lineRows, error: lErr } = await c
    .from('b2b_order_lines')
    .select(`
      qty, sku, name, catalogue_id,
      catalogue:b2b_catalogue!b2b_order_lines_catalogue_id_fkey (
        freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging
      )
    `)
    .eq('order_id', id)
  if (lErr) return res.status(500).json({ error: lErr.message })
  if (!lineRows || lineRows.length === 0) {
    return res.status(400).json({ error: 'Order has no lines to ship.' })
  }
  const items: CreateConsignmentRequest['items'] = []
  const missing: string[] = []
  for (const r of lineRows as any[]) {
    const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
    const wg  = cat?.freight_weight_g
    const lmm = cat?.freight_length_mm
    const wmm = cat?.freight_width_mm
    const hmm = cat?.freight_height_mm
    if (!wg || !lmm || !wmm || !hmm) {
      missing.push(`${r.sku} — ${r.name}`)
      continue
    }
    items.push({
      itemType: cat?.freight_packaging === 'pallet' ? 'Pallet' : 'Carton',
      name:     String(r.name || r.sku).slice(0, 80),
      sku:      r.sku || undefined,
      quantity: Number(r.qty),
      weight:   Math.round(Number(wg)  / 10)  / 100,    // g → kg, 2dp
      length:   Math.round(Number(lmm) / 10)  * 10 / 100,// mm → cm, 1dp
      width:    Math.round(Number(wmm) / 10)  * 10 / 100,
      height:   Math.round(Number(hmm) / 10)  * 10 / 100,
    })
  }
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Some line items are missing freight dimensions — fix the catalogue before booking.',
      details: missing,
    })
  }

  // ── Build the create-consignment request ──
  const reference = order.order_number + (order.customer_po ? ` / ${order.customer_po}` : '')
  const chosen: any = order.freight_chosen_quote || {}
  const req2: CreateConsignmentRequest = {
    carrierId:               Number(order.machship_carrier_id),
    carrierServiceId:        Number(order.machship_carrier_service_id),
    companyCarrierAccountId: chosen?.companyCarrierAccountId ?? undefined,

    fromName:         settings.machship_from_name || undefined,
    fromCompany:      settings.machship_from_company || undefined,
    fromPhone:        settings.machship_from_phone || undefined,
    fromEmail:        settings.machship_from_email || undefined,
    fromAddressLine1: settings.machship_from_address_line1 || undefined,
    fromAddressLine2: settings.machship_from_address_line2 || undefined,
    fromLocation:     { suburb: settings.machship_from_suburb, postcode: settings.machship_from_postcode },

    toName:           recvName || undefined,
    toCompany:        recvCompany || undefined,
    toPhone:          recvPhone || undefined,
    toEmail:          recvEmail || undefined,
    toAddressLine1:   recvLine1 || undefined,
    toAddressLine2:   recvLine2 || undefined,
    toLocation:       { suburb: recvSuburb, postcode: recvPost },

    customerReference: reference,
    sendingTrackingEmail: false,   // we control distributor notifications ourselves

    items,
  }

  // ── Book ──
  let consignment
  try {
    consignment = await createConsignment(req2)
  } catch (e: any) {
    // Log the full request body so we can diagnose validation rejects
    // by replaying the exact payload against MachShip's swagger. Never
    // returned to the client — request bag stays server-side.
    console.error(`[book-freight] order ${id} createConsignment failed:`, e?.message || e)
    console.error(`[book-freight] order ${id} request body:`, JSON.stringify(req2).slice(0, 4000))
    if (e instanceof MachShipNotConfiguredError) return res.status(503).json({ error: e.message })
    if (e instanceof MachShipApiError)            return res.status(502).json({ error: e.message, detail: e.detail })
    return res.status(500).json({ error: `createConsignment failed: ${e?.message || e}` })
  }

  // ── Persist consignment fields on the order ──
  const update: Record<string, any> = {
    machship_consignment_id:     String(consignment.id),
    machship_consignment_number: consignment.consignmentNumber || null,
    tracking_number:             consignment.carrierConsignmentId || null,
    freight_eta_at:              consignment.etaUtc || consignment.etaLocal || null,
    freight_status:              consignment.status?.name?.toLowerCase() || 'unmanifested',
    tracking_page_access_token:  consignment.trackingPageAccessToken || null,
    last_freight_poll_at:        new Date().toISOString(),
  }
  // First-time book promotes the order to 'shipped' so it appears as
  // fulfilled in admin and the distributor sees a tracking link.
  if (!order.machship_consignment_id) {
    update.shipped_at = new Date().toISOString()
    update.shipped_by = user.id
    update.status     = 'shipped'
    update.carrier    = order.freight_service_label || consignment.status?.name || 'MachShip'
  }
  const { error: uErr } = await c.from('b2b_orders').update(update).eq('id', id)
  if (uErr) return res.status(500).json({ error: `Persist consignment failed: ${uErr.message}` })

  // ── Fetch the label and store it (non-fatal on failure) ──
  let labelWarning: string | null = null
  let labelPath: string | null = null
  try {
    const pdf = await getLabelPdfBase64(consignment.id)
    if (pdf?.content) {
      const bytes = Buffer.from(pdf.content, 'base64')
      if (bytes.length > 0) {
        const filename = (pdf.fileName || `${consignment.consignmentNumber || consignment.id}.pdf`)
          .replace(/[^\w.\-]/g, '_').slice(0, 80)
        const path = `${id}/${Date.now()}-${filename}`
        const { error: upErr } = await c.storage.from(LABELS_BUCKET).upload(path, bytes, {
          contentType: pdf.contentType || 'application/pdf',
          upsert: false,
        })
        if (upErr) {
          labelWarning = `Label uploaded failed: ${upErr.message}`
        } else {
          labelPath = path
          await c.from('b2b_orders').update({ label_pdf_path: path }).eq('id', id)
        }
      } else {
        labelWarning = 'Label PDF was empty'
      }
    } else {
      labelWarning = 'MachShip did not return label content'
    }
  } catch (e: any) {
    labelWarning = `Label fetch failed: ${e?.message || e}`
    console.error(`book-freight: label fetch failed for order ${id}:`, e)
  }

  // ── Audit ──
  try {
    await c.from('b2b_order_events').insert({
      order_id:    id,
      event_type:  order.machship_consignment_id ? 'freight_rebooked' : 'freight_booked',
      actor_type:  'admin',
      actor_id:    user.id,
      to_status:   order.machship_consignment_id ? null : 'shipped',
      metadata: {
        consignment_id:      consignment.id,
        consignment_number:  consignment.consignmentNumber,
        tracking_number:     consignment.carrierConsignmentId,
        carrier_service:     order.freight_service_label,
        label_warning:       labelWarning,
      },
    })
  } catch (e: any) {
    console.error('order_events insert failed (non-fatal):', e?.message)
  }

  return res.status(200).json({
    ok: true,
    consignment_id:     String(consignment.id),
    consignment_number: consignment.consignmentNumber,
    tracking_number:    consignment.carrierConsignmentId,
    eta_utc:            consignment.etaUtc || consignment.etaLocal || null,
    status:             consignment.status?.name || null,
    label_path:         labelPath,
    label_warning:      labelWarning,
  })
})
