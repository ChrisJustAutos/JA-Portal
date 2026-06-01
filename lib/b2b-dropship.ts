// lib/b2b-dropship.ts
// SERVER-ONLY core for raising B2B drop-ship purchase orders. Extracted from
// pages/api/b2b/admin/orders/[id]/dropship-po.ts so the Stripe webhook (auto)
// and the manual admin route both share one implementation.
//
// Groups an order's drop-ship lines by their MYOB primary supplier, creates one
// Item Purchase Order per supplier in MYOB JAWS (ship-to = customer for direct
// delivery), then best-effort emails the supplier their PO. Idempotent: skips
// if POs were already raised unless { force }.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { assertCheckoutConfigured } from './b2b-settings'
import { createDropShipPurchaseOrder, getSupplierContact, DropShipPOLine } from './b2b-myob-po'
import { sendMail } from './microsoft-graph'
import { renderEmail, linesTableHtml, addressBlock } from './email-templates'

export const PO_FROM_MAILBOX = process.env.B2B_PO_FROM_MAILBOX || process.env.AP_INBOX_MAILBOX || 'accounts@justautosmechanical.com.au'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

export function buildPoEmailHtml(input: { poNumber: string | null; supplierName: string; reference: string; shipTo: string; lines: DropShipPOLine[] }): string {
  const rows = input.lines.map(l => `
    <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.description)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${l.qty}</td></tr>`).join('')
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:620px">
    <p>Hi ${esc(input.supplierName)},</p>
    <p>Please supply the following on <strong>drop ship</strong> — deliver direct to the customer at the address below.
       Our purchase order ${input.poNumber ? `<strong>${esc(input.poNumber)}</strong> ` : ''}(ref ${esc(input.reference)}) follows.</p>
    <table style="border-collapse:collapse;width:100%;margin:14px 0">
      <thead><tr><th style="padding:6px 10px;border-bottom:2px solid #333;text-align:left">Item</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Qty</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:0 0 4px"><strong>Deliver to:</strong></p>
    <pre style="font-family:inherit;background:#f6f6f6;padding:10px 12px;border-radius:6px;white-space:pre-wrap;margin:0 0 16px">${esc(input.shipTo)}</pre>
    <p>Thanks,<br/>Just Autos Mechanical</p>
  </div>`
}

export async function buildShipTo(c: SupabaseClient, order: any): Promise<string> {
  const snap: any = order.shipping_address_snapshot || null
  const pick = (...vals: any[]): string => { for (const v of vals) { if (v == null) continue; const s = String(v).trim(); if (s) return s } return '' }
  let name = '', company = '', line1 = '', line2 = '', suburb = '', state = '', post = ''
  if (snap && typeof snap === 'object') {
    name = pick(snap.recipient_name, snap.contact_name); company = pick(snap.company_name)
    line1 = pick(snap.line1, snap.address_line1); line2 = pick(snap.line2, snap.address_line2)
    suburb = pick(snap.suburb); state = pick(snap.state); post = pick(snap.postcode)
  }
  if (!suburb || !post) {
    const { data: dist } = await c.from('b2b_distributors')
      .select('display_name, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode')
      .eq('id', order.distributor_id).maybeSingle()
    company = company || (dist?.display_name || ''); line1 = line1 || (dist?.ship_line1 || '')
    line2 = line2 || (dist?.ship_line2 || ''); suburb = suburb || (dist?.ship_suburb || '')
    state = state || (dist?.ship_state || ''); post = post || (dist?.ship_postcode || '')
  }
  const cityLine = [suburb, state, post].filter(Boolean).join(' ')
  return ['DROP SHIP — deliver direct to customer:', [name, company].filter(Boolean).join(' / '), line1, line2, cityLine].filter(Boolean).join('\n')
}

interface Grouped { supplierUid: string; supplierName: string; lines: DropShipPOLine[] }

async function gatherDropShip(c: SupabaseClient, orderId: string, gstTaxCodeUid: string) {
  const { data: lineRows, error } = await c.from('b2b_order_lines').select(`
      qty, sku, name, myob_item_uid,
      catalogue:b2b_catalogue!b2b_order_lines_catalogue_id_fkey (
        is_drop_ship, myob_supplier_uid, myob_supplier_name, supplier_item_number, cost_price_ex_gst, myob_item_uid
      )`).eq('order_id', orderId)
  if (error) throw new Error(error.message)
  const bySupplier = new Map<string, Grouped>()
  const missingSupplier: string[] = []
  const missingItem: string[] = []
  for (const r of (lineRows || []) as any[]) {
    const cat = Array.isArray(r.catalogue) ? r.catalogue[0] : r.catalogue
    if (!cat || cat.is_drop_ship !== true) continue
    const supplierUid = cat.myob_supplier_uid
    const itemUid = cat.myob_item_uid || r.myob_item_uid
    if (!supplierUid) { missingSupplier.push(`${r.sku} — ${r.name}`); continue }
    if (!itemUid) { missingItem.push(`${r.sku} — ${r.name}`); continue }
    const g: Grouped = bySupplier.get(supplierUid) || { supplierUid, supplierName: cat.myob_supplier_name || 'Supplier', lines: [] }
    g.lines.push({
      itemUid,
      description: `${r.name}${cat.supplier_item_number ? ` (their #${cat.supplier_item_number})` : ''}`,
      qty: Number(r.qty),
      unitPriceExGst: cat.cost_price_ex_gst != null ? Number(cat.cost_price_ex_gst) : 0,
      taxUid: gstTaxCodeUid,
    })
    bySupplier.set(supplierUid, g)
  }
  return { bySupplier, missingSupplier, missingItem }
}

export interface DropshipRaiseResult {
  ok: boolean
  alreadyRaised?: boolean
  noDropShip?: boolean
  raised: any[]
  failures: { supplier: string; error: string }[]
  missingSupplier: string[]
  missingItem: string[]
  error?: string
}

export async function raiseDropShipPOsForOrder(orderId: string, opts: { actorId?: string | null; force?: boolean } = {}): Promise<DropshipRaiseResult> {
  const c = svc()
  const { data: order, error: oErr } = await c.from('b2b_orders')
    .select('id, order_number, customer_po, distributor_id, shipping_address_snapshot, dropship_pos, dropship_po_raised_at')
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(oErr.message)
  if (!order) return { ok: false, raised: [], failures: [], missingSupplier: [], missingItem: [], error: 'Order not found' }

  const existing = Array.isArray(order.dropship_pos) ? order.dropship_pos : []
  if (existing.length > 0 && !opts.force) {
    return { ok: false, alreadyRaised: true, raised: [], failures: [], missingSupplier: [], missingItem: [] }
  }

  const cfg = await assertCheckoutConfigured()
  const { bySupplier, missingSupplier, missingItem } = await gatherDropShip(c, orderId, cfg.gstTaxCodeUid)
  if (bySupplier.size === 0) {
    return { ok: false, noDropShip: missingSupplier.length === 0, raised: [], failures: [], missingSupplier, missingItem }
  }

  const shipTo = await buildShipTo(c, order)
  const reference = order.order_number + (order.customer_po ? ` / ${order.customer_po}` : '')

  const raised: any[] = []
  const failures: { supplier: string; error: string }[] = []
  for (const g of Array.from(bySupplier.values())) {
    try {
      const po = await createDropShipPurchaseOrder({
        supplierUid: g.supplierUid, lines: g.lines, shipToAddress: shipTo,
        comment: `Drop ship — deliver direct to customer. JA order ${reference}`,
        journalMemo: `B2B drop-ship; order ${order.order_number}`,
      })
      let emailStatus: 'sent' | 'no_email' | 'failed' | 'disabled' = 'no_email'
      let emailedTo: string | null = null
      let emailError: string | null = null
      try {
        const rendered = await renderEmail('supplier_dropship_po',
          { supplier_name: g.supplierName, po_number: po.number || '', order_reference: reference },
          { lines_table: linesTableHtml(g.lines.map(l => ({ description: l.description, qty: l.qty }))), ship_to: addressBlock(shipTo) })
        if (!rendered.enabled) { emailStatus = 'disabled' }
        else {
          const contact = await getSupplierContact(g.supplierUid)
          if (contact.email) {
            await sendMail(PO_FROM_MAILBOX, { to: [contact.email], subject: rendered.subject, html: rendered.html })
            emailStatus = 'sent'; emailedTo = contact.email
          }
        }
      } catch (e: any) {
        emailStatus = 'failed'; emailError = (e?.message || String(e)).slice(0, 300)
        console.error(`drop-ship PO email failed for ${g.supplierName}:`, emailError)
      }
      raised.push({
        supplier_uid: g.supplierUid, supplier_name: g.supplierName,
        myob_po_uid: po.uid, myob_po_number: po.number, line_count: g.lines.length,
        email_status: emailStatus, emailed_to: emailedTo, email_error: emailError,
        created_at: new Date().toISOString(),
      })
    } catch (e: any) {
      failures.push({ supplier: g.supplierName, error: (e?.message || String(e)).slice(0, 300) })
    }
  }

  if (raised.length > 0) {
    await c.from('b2b_orders').update({
      dropship_pos: [...existing, ...raised],
      dropship_po_raised_at: order.dropship_po_raised_at || new Date().toISOString(),
    }).eq('id', orderId)
    try {
      await c.from('b2b_order_events').insert({
        order_id: orderId, event_type: 'dropship_po_raised',
        actor_type: opts.actorId ? 'admin' : 'system', actor_id: opts.actorId || null,
        metadata: { raised, failures },
      })
    } catch (e: any) { console.error('order_events insert failed (non-fatal):', e?.message) }
  }

  return { ok: raised.length > 0, raised, failures, missingSupplier, missingItem }
}

// Re-email an already-raised PO for one supplier (admin manual action). Returns
// the email status; never raises a new PO.
export async function resendDropShipPoEmail(orderId: string, supplierUid: string, actorId?: string | null): Promise<{ ok: boolean; email_status: string; emailed_to?: string | null; error?: string }> {
  const c = svc()
  const { data: order } = await c.from('b2b_orders')
    .select('id, order_number, customer_po, distributor_id, shipping_address_snapshot, dropship_pos')
    .eq('id', orderId).maybeSingle()
  if (!order) return { ok: false, email_status: 'failed', error: 'Order not found' }
  const cfg = await assertCheckoutConfigured()
  const { bySupplier } = await gatherDropShip(c, orderId, cfg.gstTaxCodeUid)
  const g = bySupplier.get(supplierUid)
  if (!g) return { ok: false, email_status: 'failed', error: 'No drop-ship lines for that supplier on this order.' }
  const existingPos = Array.isArray(order.dropship_pos) ? order.dropship_pos : []
  const rec = existingPos.find((p: any) => p.supplier_uid === supplierUid)
  const shipTo = await buildShipTo(c, order)
  const reference = order.order_number + (order.customer_po ? ` / ${order.customer_po}` : '')
  const patchRec = (patch: Record<string, any>) =>
    c.from('b2b_orders').update({ dropship_pos: existingPos.map((p: any) => p.supplier_uid === supplierUid ? { ...p, ...patch } : p) }).eq('id', orderId)
  try {
    const rendered = await renderEmail('supplier_dropship_po',
      { supplier_name: g.supplierName, po_number: rec?.myob_po_number || '', order_reference: reference },
      { lines_table: linesTableHtml(g.lines.map(l => ({ description: l.description, qty: l.qty }))), ship_to: addressBlock(shipTo) })
    if (!rendered.enabled) return { ok: false, email_status: 'disabled', error: 'The supplier PO email template is turned off in B2B Settings.' }
    const contact = await getSupplierContact(supplierUid)
    if (!contact.email) {
      await patchRec({ email_status: 'no_email', emailed_to: null, email_error: 'No email on the MYOB supplier card' })
      return { ok: false, email_status: 'no_email', error: 'Supplier has no email on their MYOB card.' }
    }
    await sendMail(PO_FROM_MAILBOX, { to: [contact.email], subject: rendered.subject, html: rendered.html })
    await patchRec({ email_status: 'sent', emailed_to: contact.email, email_error: null })
    try { await c.from('b2b_order_events').insert({ order_id: orderId, event_type: 'dropship_po_emailed', actor_type: actorId ? 'admin' : 'system', actor_id: actorId || null, metadata: { supplier: g.supplierName, to: contact.email } }) } catch {}
    return { ok: true, email_status: 'sent', emailed_to: contact.email }
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 300)
    await patchRec({ email_status: 'failed', email_error: msg })
    return { ok: false, email_status: 'failed', error: msg }
  }
}
