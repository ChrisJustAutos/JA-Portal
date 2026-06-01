// lib/b2b-order-notify.ts
// SERVER-ONLY. Sends the admin an "order placed" notification email with the
// order details, the drop-ship PO outcome, an "Open in portal" link and a
// login-less "Book Freight" button (signed token → /order-action). Goal: an
// admin rarely needs to log in to action an order.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { sendMail } from './microsoft-graph'
import { signOrderAction } from './order-action-token'
import { PO_FROM_MAILBOX, type DropshipRaiseResult } from './b2b-dropship'

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

  const lineRows = (lines || []).map((l: any) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(l.sku)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(l.name)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${esc(l.qty)}</td></tr>`).join('')

  const portalUrl = `${BASE_URL}/admin/b2b/orders/${orderId}`
  // Book-freight button: only meaningful if a carrier was chosen and not yet booked.
  let freightBlock = ''
  if (order.machship_consignment_id) {
    freightBlock = `<p style="color:#2a7">✓ Freight already booked.</p>`
  } else if (order.machship_carrier_id) {
    const token = signOrderAction({ orderId, scope: 'book_freight' })
    const bookUrl = `${BASE_URL}/order-action?token=${encodeURIComponent(token)}`
    freightBlock = `<p style="margin:18px 0"><a href="${bookUrl}" style="background:#34c77b;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:600;display:inline-block">📦 Book Freight${order.freight_service_label ? ` (${esc(order.freight_service_label)})` : ''}</a><br/><span style="font-size:12px;color:#888">No login needed — opens a confirmation page.</span></p>`
  } else {
    freightBlock = `<p style="color:#a60">No freight quote on this order — book manually in the portal.</p>`
  }

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:660px">
    <h2 style="margin:0 0 4px">New B2B order ${esc(order.order_number)}</h2>
    <p style="margin:0 0 14px;color:#555">${esc(dist?.display_name || 'Distributor')} · Total ${money(order.total_inc)} inc GST${order.customer_po ? ` · Their PO ${esc(order.customer_po)}` : ''}</p>

    <a href="${portalUrl}" style="color:#4f8ef7">Open this order in the portal →</a>

    <h3 style="margin:18px 0 4px">Items</h3>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr><th style="padding:4px 8px;border-bottom:2px solid #333;text-align:left">SKU</th><th style="padding:4px 8px;border-bottom:2px solid #333;text-align:left">Item</th><th style="padding:4px 8px;border-bottom:2px solid #333;text-align:right">Qty</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>

    <h3 style="margin:18px 0 4px">Drop-ship</h3>
    ${dropshipSummaryHtml(order, opts.dropshipResult)}

    <h3 style="margin:18px 0 4px">Ship to</h3>
    <pre style="font-family:inherit;background:#f6f6f6;padding:10px 12px;border-radius:6px;white-space:pre-wrap;margin:0">${esc(shipToText(order.shipping_address_snapshot, dist))}</pre>

    <h3 style="margin:18px 0 4px">Freight</h3>
    ${freightBlock}
    ${order.customer_notes ? `<h3 style="margin:18px 0 4px">Customer notes</h3><p>${esc(order.customer_notes)}</p>` : ''}
  </div>`

  await sendMail(PO_FROM_MAILBOX, {
    to: recipients,
    subject: `New B2B order ${order.order_number} — ${dist?.display_name || ''}`.trim(),
    html,
  })
  await c.from('b2b_orders').update({ admin_notified_at: new Date().toISOString() }).eq('id', orderId)
  return { ok: true, recipients }
}
