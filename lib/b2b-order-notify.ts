// lib/b2b-order-notify.ts
// SERVER-ONLY. Sends the admin an "order placed" notification email with the
// order details, the drop-ship PO outcome, an "Open in portal" link and a
// login-less "Book Freight" button (signed token → /order-action). Goal: an
// admin rarely needs to log in to action an order.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendMail } from './microsoft-graph'
import { signOrderAction } from './order-action-token'
import { type DropshipRaiseResult } from './b2b-dropship'
import { getFromMailbox } from './b2b-settings'
import { renderEmail, linesTableHtml, addressBlock, buttonHtml, linkHtml } from './email-templates'

const BASE_URL = process.env.B2B_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.JA_PORTAL_BASE_URL || 'https://ja-portal.vercel.app'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}
function esc(s: any): string { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string)) }
function money(n: any): string { const v = Number(n); return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—' }

async function resolveRecipients(c: SupabaseClient): Promise<string[]> {
  const { data } = await c.from('b2b_settings').select('admin_order_notify_emails').eq('id', 'singleton').maybeSingle()
  const raw = String(data?.admin_order_notify_emails || process.env.B2B_ADMIN_NOTIFY_EMAILS || '').trim()
  return raw.split(/[,;\s]+/).map(s => s.trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
}

function shipToText(snap: any, dist: any): string {
  const pick = (...v: any[]) => { for (const x of v) { if (x == null) continue; const s = String(x).trim(); if (s) return s } return '' }
  const lines = [
    pick(snap?.recipient_name, snap?.contact_name),
    pick(snap?.company_name, dist?.display_name),
    pick(snap?.line1, snap?.address_line1, dist?.ship_line1),
    pick(snap?.line2, snap?.address_line2, dist?.ship_line2),
    [pick(snap?.suburb, dist?.ship_suburb), pick(snap?.state, dist?.ship_state), pick(snap?.postcode, dist?.ship_postcode)].filter(Boolean).join(' '),
  ].filter(Boolean)
  return lines.join('\n')
}

function dropshipSummaryHtml(order: any, result?: DropshipRaiseResult): string {
  const pos = Array.isArray(order.dropship_pos) ? order.dropship_pos : []
  const missing = result?.missingSupplier || []
  if (pos.length === 0 && missing.length === 0 && !(result?.failures?.length)) {
    return `<p style="color:#666">No drop-ship items on this order.</p>`
  }
  const posRows = pos.map((p: any) => `<li>${esc(p.supplier_name)} — PO <strong>${esc(p.myob_po_number || p.myob_po_uid || '?')}</strong> · supplier email: <strong>${esc(p.email_status || 'n/a')}</strong>${p.emailed_to ? ` (${esc(p.emailed_to)})` : ''}</li>`).join('')
  const failRows = (result?.failures || []).map(f => `<li style="color:#b00">${esc(f.supplier)} — FAILED: ${esc(f.error)}</li>`).join('')
  const missRows = missing.length ? `<p style="color:#b00;margin:6px 0 0"><strong>${missing.length} drop-ship item(s) had no MYOB reorder supplier — not ordered. Fix in MYOB (Buying Details):</strong></p><ul>${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''
  return `<ul style="margin:6px 0">${posRows}${failRows}</ul>${missRows}`
}

export async function sendOrderPlacedAdminEmail(orderId: string, opts: { dropshipResult?: DropshipRaiseResult } = {}): Promise<{ ok: boolean; recipients?: string[]; reason?: string }> {
  const c = svc()
  const recipients = await resolveRecipients(c)
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' }

  const { data: order } = await c.from('b2b_orders').select(`
      id, order_number, customer_po, customer_notes, total_inc, status,
      shipping_address_snapshot, dropship_pos, machship_carrier_id, machship_consignment_id,
      freight_service_label,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode )
    `).eq('id', orderId).maybeSingle()
  if (!order) return { ok: false, reason: 'order_not_found' }
  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  const { data: lines } = await c.from('b2b_order_lines').select('qty, sku, name').eq('order_id', orderId)
  const linesBlock = linesTableHtml((lines || []).map((l: any) => ({ description: [l.sku, l.name].filter(Boolean).join(' — '), qty: l.qty })))

  const portalUrl = `${BASE_URL}/admin/b2b/orders/${orderId}`
  // Book-freight button: only meaningful if a carrier was chosen and not yet booked.
  let freightBlock = ''
  if (order.machship_consignment_id) {
    freightBlock = `<p style="color:#2a7">✓ Freight already booked.</p>`
  } else if (order.machship_carrier_id) {
    const token = signOrderAction({ orderId, scope: 'book_freight' })
    const bookUrl = `${BASE_URL}/order-action?token=${encodeURIComponent(token)}`
    freightBlock = `${buttonHtml(`📦 Book Freight${order.freight_service_label ? ` (${order.freight_service_label})` : ''}`, bookUrl, '#34c77b')}<br/><span style="font-size:12px;color:#888">No login needed — opens a confirmation page.</span>`
  } else {
    freightBlock = `<p style="color:#a60">No freight quote on this order — book manually in the portal.</p>`
  }

  const rendered = await renderEmail('admin_order_placed', {
    order_number: order.order_number,
    distributor_name: dist?.display_name || 'Distributor',
    order_total: money(order.total_inc),
    customer_po: order.customer_po ? ` · Their PO ${order.customer_po}` : '',
    customer_notes: order.customer_notes ? `Customer notes: ${order.customer_notes}` : '',
  }, {
    lines_table: linesBlock,
    dropship_summary: dropshipSummaryHtml(order, opts.dropshipResult),
    ship_to: addressBlock(shipToText(order.shipping_address_snapshot, dist)),
    book_freight_button: freightBlock,
    portal_link: linkHtml('Open this order in the portal →', portalUrl),
  })
  // Mark notified even if disabled, so we don't recompute every webhook retry.
  await c.from('b2b_orders').update({ admin_notified_at: new Date().toISOString() }).eq('id', orderId)
  if (!rendered.enabled) return { ok: false, reason: 'disabled' }

  await sendMail(await getFromMailbox(), { to: recipients, subject: rendered.subject, html: rendered.html })
  return { ok: true, recipients }
}

// ── Distributor-facing emails ─────────────────────────────────────────
// Sent on payment: order confirmation (to primary contact) + tax invoice (to
// invoice email, once the MYOB invoice number exists). Each respects its
// template's enabled flag and is skipped if the recipient email is blank.
// Guarded once-per-order by b2b_orders.distributor_notified_at (set by caller
// context — we set it here after attempting).
export async function sendDistributorOrderEmails(orderId: string, opts: { invoiceNumber?: string | null } = {}): Promise<{ ok: boolean; sent: string[] }> {
  const c = svc()
  const { data: order } = await c.from('b2b_orders').select(`
      id, order_number, customer_po, total_inc, shipping_address_snapshot, myob_invoice_number,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name, primary_contact_email, invoice_email, freight_email, ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode )
    `).eq('id', orderId).maybeSingle()
  if (!order) return { ok: false, sent: [] }
  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  const { data: lines } = await c.from('b2b_order_lines').select('qty, sku, name').eq('order_id', orderId)
  const linesBlock = linesTableHtml((lines || []).map((l: any) => ({ description: [l.sku, l.name].filter(Boolean).join(' — '), qty: l.qty })))
  const sent: string[] = []

  // Order confirmation → primary contact.
  const primary = (dist?.primary_contact_email || '').trim()
  if (primary) {
    const r = await renderEmail('distributor_order_confirmed', {
      distributor_name: dist?.display_name || '', order_number: order.order_number,
      customer_po: order.customer_po ? ` (your PO ${order.customer_po})` : '', order_total: money(order.total_inc),
    }, { lines_table: linesBlock, ship_to: addressBlock(shipToText(order.shipping_address_snapshot, dist)) })
    if (r.enabled) { try { await sendMail(await getFromMailbox(), { to: [primary], subject: r.subject, html: r.html }); sent.push('order_confirmed') } catch (e: any) { console.error('distributor order_confirmed email failed:', e?.message) } }
  }

  // Tax invoice → invoice email (fallback primary), only once we have a number.
  const invNumber = opts.invoiceNumber || order.myob_invoice_number || ''
  const invoiceTo = (dist?.invoice_email || dist?.primary_contact_email || '').trim()
  if (invNumber && invoiceTo) {
    const r = await renderEmail('distributor_invoice', {
      distributor_name: dist?.display_name || '', order_number: order.order_number,
      invoice_number: String(invNumber), order_total: money(order.total_inc),
    })
    if (r.enabled) { try { await sendMail(await getFromMailbox(), { to: [invoiceTo], subject: r.subject, html: r.html }); sent.push('invoice') } catch (e: any) { console.error('distributor invoice email failed:', e?.message) } }
  }

  await c.from('b2b_orders').update({ distributor_notified_at: new Date().toISOString() }).eq('id', orderId)
  return { ok: true, sent }
}

// Distributor "shipped + tracking" — called from lib/b2b-freight-book after a
// first successful booking. Best-effort; respects the template + recipient.
export async function sendDistributorShippedEmail(orderId: string, info: { carrier?: string | null; consignmentNumber?: string | null; trackingNumber?: string | null; trackingUrl?: string | null; eta?: string | null }): Promise<void> {
  const c = svc()
  const { data: order } = await c.from('b2b_orders').select(`
      order_number, distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( display_name, freight_email, primary_contact_email )
    `).eq('id', orderId).maybeSingle()
  if (!order) return
  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  const to = (dist?.freight_email || dist?.primary_contact_email || '').trim()
  if (!to) return
  const r = await renderEmail('distributor_shipped', {
    distributor_name: dist?.display_name || '', order_number: order.order_number,
    carrier: info.carrier || 'our carrier', consignment_number: info.consignmentNumber || '—',
    tracking_number: info.trackingNumber || '—', eta: info.eta || '',
  }, { tracking_link: info.trackingUrl ? buttonHtml('Track this shipment', info.trackingUrl, '#4f8ef7') : '' })
  if (!r.enabled) return
  try { await sendMail(await getFromMailbox(), { to: [to], subject: r.subject, html: r.html }) } catch (e: any) { console.error('distributor shipped email failed:', e?.message) }
}
