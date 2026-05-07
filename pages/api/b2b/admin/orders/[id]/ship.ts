// pages/api/b2b/admin/orders/[id]/ship.ts
// Admin endpoint that records a B2B order as shipped: stamps carrier +
// tracking + freight cost + shipped_at + shipped_by, optionally stores
// the label PDF in the b2b-shipping-labels bucket so it can be re-printed
// from the order detail page later.
//
// POST /api/b2b/admin/orders/{id}/ship
//   body: {
//     carrier?:        string,
//     tracking_number?: string,
//     tracking_url?:   string,    // optional; if omitted we store as-is
//     freight_cost_ex_gst?: number,
//     label_pdf_base64?: string,  // optional; data: URL prefix tolerated
//     label_filename?: string,    // recommended when label_pdf_base64 set
//     internal_notes?: string,
//   }
//
// Re-callable: hitting it again on an already-shipped order updates the
// fields in place (e.g. you fix a typo'd tracking number). The original
// shipped_at/shipped_by are preserved unless you pass clear=true.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'

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
const MAX_LABEL_BYTES = 10 * 1024 * 1024

export const config = {
  api: { bodyParser: { sizeLimit: '15mb' } },
  maxDuration: 30,
}

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, status, label_pdf_path, shipped_at')
    .eq('id', id)
    .maybeSingle()
  if (oErr) return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const body = (req.body || {}) as Record<string, any>

  // ── Optional label upload ──
  let labelPath: string | null | undefined = undefined  // undefined = leave alone, null = clear, string = update
  if (body.label_pdf_base64) {
    try {
      const cleaned = String(body.label_pdf_base64).replace(/^data:[^,]+;base64,/, '').trim()
      const bytes = Buffer.from(cleaned, 'base64')
      if (bytes.length === 0) throw new Error('empty file')
      if (bytes.length > MAX_LABEL_BYTES) {
        return res.status(400).json({ error: `Label too large (${Math.round(bytes.length/1024)}KB > ${MAX_LABEL_BYTES/1024}KB cap)` })
      }
      const filename = String(body.label_filename || 'label.pdf').replace(/[^\w.\-]/g, '_').slice(0, 80) || 'label.pdf'
      const path = `${id}/${Date.now()}-${filename}`
      // Best-effort: detect content-type from the magic bytes so the bucket's
      // mime-type allowlist accepts it.
      let contentType = 'application/pdf'
      if (filename.toLowerCase().endsWith('.png')) contentType = 'image/png'
      else if (/\.jpe?g$/i.test(filename))         contentType = 'image/jpeg'

      const { error: upErr } = await c.storage.from(LABELS_BUCKET).upload(path, bytes, {
        contentType,
        upsert: false,
      })
      if (upErr) return res.status(500).json({ error: 'Label upload failed: ' + upErr.message })

      // If the order already had a label, best-effort delete the previous one
      // to avoid orphaned files. Failure here is non-blocking.
      if (order.label_pdf_path && order.label_pdf_path !== path) {
        try { await c.storage.from(LABELS_BUCKET).remove([order.label_pdf_path]) } catch {}
      }
      labelPath = path
    } catch (e: any) {
      return res.status(400).json({ error: 'Label PDF failed: ' + (e?.message || String(e)) })
    }
  } else if (body.clear_label === true) {
    if (order.label_pdf_path) {
      try { await c.storage.from(LABELS_BUCKET).remove([order.label_pdf_path]) } catch {}
    }
    labelPath = null
  }

  // ── Build the update ──
  const update: Record<string, any> = {}
  if (typeof body.carrier === 'string')               update.carrier = body.carrier.trim().slice(0, 80) || null
  if (typeof body.tracking_number === 'string')       update.tracking_number = body.tracking_number.trim().slice(0, 120) || null
  if (typeof body.tracking_url === 'string')          update.tracking_url = body.tracking_url.trim().slice(0, 500) || null
  if (typeof body.internal_notes === 'string')        update.internal_notes = body.internal_notes.trim().slice(0, 2000) || null
  if (body.freight_cost_ex_gst != null) {
    const n = Number(body.freight_cost_ex_gst)
    if (Number.isFinite(n) && n >= 0) update.freight_cost_ex_gst = n
  }
  if (labelPath !== undefined) update.label_pdf_path = labelPath

  // First-time ship: stamp shipped_at + shipped_by + status. Re-runs only
  // refresh shipped_at if explicitly asked (body.update_shipped_at=true).
  if (!order.shipped_at) {
    update.shipped_at = new Date().toISOString()
    update.shipped_by = user.id
    update.status = 'shipped'
  } else if (body.update_shipped_at === true) {
    update.shipped_at = new Date().toISOString()
    update.shipped_by = user.id
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No shipping fields supplied' })
  }

  const { data: updated, error: uErr } = await c
    .from('b2b_orders')
    .update(update)
    .eq('id', id)
    .select()
    .single()
  if (uErr) return res.status(500).json({ error: uErr.message })

  // Best-effort order event log
  try {
    await c.from('b2b_order_events').insert({
      order_id:    id,
      event_type:  order.shipped_at ? 'shipping_updated' : 'shipped',
      actor_type:  'admin',
      actor_id:    user.id,
      to_status:   order.shipped_at ? null : 'shipped',
      metadata: {
        carrier: update.carrier,
        tracking_number: update.tracking_number,
        freight_cost_ex_gst: update.freight_cost_ex_gst,
        label_attached: labelPath != null,
      },
    })
  } catch (e: any) {
    console.error('order_events insert failed (non-fatal):', e?.message)
  }

  return res.status(200).json({ ok: true, order: updated })
})
