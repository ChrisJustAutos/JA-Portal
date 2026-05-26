// pages/api/b2b/admin/orders/[id]/dropship-po.ts
//
// Raises drop-ship purchase orders for a B2B order. Gathers the order's
// drop-ship line items, groups them by their MYOB primary supplier, and
// creates one Item Purchase Order per supplier in MYOB JAWS with the
// distributor's address as the ship-to (so the supplier delivers direct
// to the customer).
//
// POST /api/b2b/admin/orders/{id}/dropship-po   (no body)
//   ?force=1 to raise again even if POs were already raised.
//
// Phase 2 of the drop-ship feature — MYOB PO only. Emailing the supplier
// (Graph Mail.Send) is a separate follow-up.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { assertCheckoutConfigured } from '../../../../../../lib/b2b-settings'
import { createDropShipPurchaseOrder, getSupplierContact, DropShipPOLine } from '../../../../../../lib/b2b-myob-po'
import { sendMail } from '../../../../../../lib/microsoft-graph'

const PO_FROM_MAILBOX = process.env.B2B_PO_FROM_MAILBOX || process.env.AP_INBOX_MAILBOX || 'accounts@justautosmechanical.com.au'

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

function buildPoEmailHtml(input: { poNumber: string | null; supplierName: string; reference: string; shipTo: string; lines: DropShipPOLine[] }): string {
  const rows = input.lines.map(l => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.description)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${l.qty}</td>
    </tr>`).join('')
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:620px">
    <p>Hi ${esc(input.supplierName)},</p>
    <p>Please supply the following on <strong>drop ship</strong> — deliver direct to the customer at the address below.
       Our purchase order ${input.poNumber ? `<strong>${esc(input.poNumber)}</strong> ` : ''}(ref ${esc(input.reference)}) follows.</p>
    <table style="border-collapse:collapse;width:100%;margin:14px 0">
      <thead><tr>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:left">Item</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Qty</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:0 0 4px"><strong>Deliver to:</strong></p>
    <pre style="font-family:inherit;background:#f6f6f6;padding:10px 12px;border-radius:6px;white-space:pre-wrap;margin:0 0 16px">${esc(input.shipTo)}</pre>
    <p>Thanks,<br/>Just Autos Mechanical</p>
  </div>`
}

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const force = String(req.query.force || '') === '1'

  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, order_number, customer_po, distributor_id, shipping_address_snapshot, dropship_pos, dropship_po_raised_at')
    .eq('id', id)
    .maybeSingle()
  if (oErr)   return res.status(500).json({ error: oErr.message })
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (Array.isArray(order.dropship_pos) && order.dropship_pos.length > 0 && !force) {
    return res.status(409).json({ error: 'Drop-ship POs already raised for this order. Pass ?force=1 to raise again.' })
  }

  // Order lines joined to catalogue for drop-ship + supplier + buy price.
  const { data: lineRows, error: lErr } = await c
    .from('b2b_order_lines')
    .select(`
      qty, sku, name, myob_item_uid,
      catalogue:b2b_catalogue!b2b_order_lines_catalogue_id_fkey (
        is_drop_ship, myob_supplier_uid, myob_supplier_name, supplier_item_number, cost_price_ex_gst, myob_item_uid
      )
    `)
    .eq('order_id', id)
  if (lErr) return res.status(500).json({ error: lErr.message })

  // Keep only drop-ship lines.
  type Grouped = { supplierUid: string; supplierName: string; lines: DropShipPOLine[] }
  const bySupplier = new Map<string, Grouped>()
  const missingSupplier: string[] = []
  const missingItem: string[] = []

  let cfg: any
  try { cfg = await assertCheckoutConfigured() } catch (e: any) {
    return res.status(503).json({ error: 'MYOB/Stripe config incomplete — fix B2B Settings first.', detail: e?.message })
  }

  for (const r of (lineRows || []) as any[]) {
    const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
    if (!cat || cat.is_drop_ship !== true) continue
    const supplierUid = cat.myob_supplier_uid
    const itemUid = cat.myob_item_uid || r.myob_item_uid
    if (!supplierUid) { missingSupplier.push(`${r.sku} — ${r.name}`); continue }
    if (!itemUid)     { missingItem.push(`${r.sku} — ${r.name}`); continue }
    const g: Grouped = bySupplier.get(supplierUid) || { supplierUid, supplierName: cat.myob_supplier_name || 'Supplier', lines: [] }
    g.lines.push({
      itemUid,
      description: `${r.name}${cat.supplier_item_number ? ` (their #${cat.supplier_item_number})` : ''}`,
      qty: Number(r.qty),
      unitPriceExGst: cat.cost_price_ex_gst != null ? Number(cat.cost_price_ex_gst) : 0,
      taxUid: cfg.gstTaxCodeUid,
    })
    bySupplier.set(supplierUid, g)
  }

  if (bySupplier.size === 0) {
    if (missingSupplier.length > 0) {
      return res.status(400).json({
        error: 'Drop-ship lines found but their MYOB items have no reorder supplier set. Add one in MYOB (Buying Details).',
        details: missingSupplier,
      })
    }
    return res.status(400).json({ error: 'This order has no drop-ship line items.' })
  }

  // Build the ship-to address from the order snapshot / distributor.
  const shipTo = await buildShipTo(c, order)

  // Raise one PO per supplier.
  const reference = order.order_number + (order.customer_po ? ` / ${order.customer_po}` : '')
  const raised: any[] = []
  const failures: Array<{ supplier: string; error: string }> = []
  for (const g of Array.from(bySupplier.values())) {
    try {
      const po = await createDropShipPurchaseOrder({
        supplierUid: g.supplierUid,
        lines: g.lines,
        shipToAddress: shipTo,
        comment: `Drop ship — deliver direct to customer. JA order ${reference}`,
        journalMemo: `B2B drop-ship; order ${order.order_number}`,
      })

      // Email the supplier their PO (best-effort — PO is already real in MYOB).
      let emailStatus: 'sent' | 'no_email' | 'failed' = 'no_email'
      let emailedTo: string | null = null
      let emailError: string | null = null
      try {
        const contact = await getSupplierContact(g.supplierUid)
        if (contact.email) {
          await sendMail(PO_FROM_MAILBOX, {
            to: [contact.email],
            subject: `Purchase Order ${po.number || ''} — Just Autos (drop ship)`.replace(/\s+/g, ' ').trim(),
            html: buildPoEmailHtml({ poNumber: po.number, supplierName: g.supplierName, reference, shipTo, lines: g.lines }),
          })
          emailStatus = 'sent'; emailedTo = contact.email
        }
      } catch (e: any) {
        emailStatus = 'failed'; emailError = (e?.message || String(e)).slice(0, 300)
        console.error(`drop-ship PO email failed for ${g.supplierName}:`, emailError)
      }

      raised.push({
        supplier_uid: g.supplierUid,
        supplier_name: g.supplierName,
        myob_po_uid: po.uid,
        myob_po_number: po.number,
        line_count: g.lines.length,
        email_status: emailStatus,
        emailed_to: emailedTo,
        email_error: emailError,
        created_at: new Date().toISOString(),
      })
    } catch (e: any) {
      failures.push({ supplier: g.supplierName, error: (e?.message || String(e)).slice(0, 300) })
    }
  }

  if (raised.length > 0) {
    const existing = Array.isArray(order.dropship_pos) ? order.dropship_pos : []
    await c.from('b2b_orders').update({
      dropship_pos: [...existing, ...raised],
      dropship_po_raised_at: order.dropship_po_raised_at || new Date().toISOString(),
    }).eq('id', id)
    try {
      await c.from('b2b_order_events').insert({
        order_id: id, event_type: 'dropship_po_raised', actor_type: 'admin', actor_id: user.id,
        metadata: { raised, failures },
      })
    } catch (e: any) { console.error('order_events insert failed (non-fatal):', e?.message) }
  }

  return res.status(failures.length > 0 && raised.length === 0 ? 502 : 200).json({
    ok: raised.length > 0,
    raised,
    failures,
    missing_supplier: missingSupplier,
    missing_item: missingItem,
  })
})

async function buildShipTo(c: SupabaseClient, order: any): Promise<string> {
  const snap: any = order.shipping_address_snapshot || null
  const pick = (...vals: any[]): string => { for (const v of vals) { if (v == null) continue; const s = String(v).trim(); if (s) return s } return '' }
  let name = '', company = '', line1 = '', line2 = '', suburb = '', state = '', post = ''
  if (snap && typeof snap === 'object') {
    name    = pick(snap.recipient_name, snap.contact_name)
    company = pick(snap.company_name)
    line1   = pick(snap.line1, snap.address_line1)
    line2   = pick(snap.line2, snap.address_line2)
    suburb  = pick(snap.suburb)
    state   = pick(snap.state)
    post    = pick(snap.postcode)
  }
  if (!suburb || !post) {
    const { data: dist } = await c
      .from('b2b_distributors')
      .select('display_name, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode')
      .eq('id', order.distributor_id)
      .maybeSingle()
    company = company || (dist?.display_name || '')
    line1   = line1   || (dist?.ship_line1 || '')
    line2   = line2   || (dist?.ship_line2 || '')
    suburb  = suburb  || (dist?.ship_suburb || '')
    state   = state   || (dist?.ship_state || '')
    post    = post    || (dist?.ship_postcode || '')
  }
  const cityLine = [suburb, state, post].filter(Boolean).join(' ')
  return ['DROP SHIP — deliver direct to customer:', [name, company].filter(Boolean).join(' / '), line1, line2, cityLine]
    .filter(Boolean).join('\n')
}
