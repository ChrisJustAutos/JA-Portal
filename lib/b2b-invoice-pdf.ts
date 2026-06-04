// lib/b2b-invoice-pdf.ts
// SERVER-ONLY. Builds a tax-invoice PDF for a B2B order by mapping it onto the
// shared WorkshopDoc shape and rendering with lib/workshop-pdf. Attached to the
// distributor's invoice/shipped email at booking time. The MYOB Sale.Invoice
// remains the canonical accounting document; this is the customer-facing copy.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { renderWorkshopDocPdf, type WorkshopDoc, type WorkshopDocLine } from './workshop-pdf'
import { getFromMailbox } from './b2b-settings'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}
const round2 = (n: number) => Math.round(n * 100) / 100

export interface B2bInvoicePdf {
  buffer: Buffer
  filename: string
  invoiceNumber: string | null
}

// Best invoice PDF for outbound use (printing + email): the real MYOB tax
// invoice when it's available, otherwise the system-generated copy. Always
// returns something (only throws if even the system render fails).
export async function getOutboundInvoicePdf(orderId: string): Promise<{ buffer: Buffer; filename: string; source: 'myob' | 'system' }> {
  try {
    const { getMyobInvoicePdf } = await import('./b2b-myob-invoice')
    const myob = await getMyobInvoicePdf(orderId)
    if (myob) return { buffer: myob.buffer, filename: myob.filename, source: 'myob' }
  } catch (e: any) { console.error('MYOB invoice PDF unavailable, using system PDF:', e?.message || e) }
  const sys = await renderB2bOrderInvoicePdf(orderId)
  return { buffer: sys.buffer, filename: sys.filename, source: 'system' }
}

// Build + render the invoice PDF for an order. Throws on missing order.
export async function renderB2bOrderInvoicePdf(orderId: string): Promise<B2bInvoicePdf> {
  const c = sb()
  const { data: order, error } = await c.from('b2b_orders').select(`
      id, order_number, customer_po, created_at, paid_at,
      subtotal_ex_gst, gst, card_fee_inc, total_inc, freight_cost_ex_gst,
      freight_service_label, freight_method_label,
      myob_sale_invoice_number, myob_invoice_number, shipping_address_snapshot,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        display_name, abn, primary_contact_email, primary_contact_phone,
        ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode
      )
    `).eq('id', orderId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!order) throw new Error(`Order ${orderId} not found`)
  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor

  const { data: lineRows } = await c.from('b2b_order_lines')
    .select('sku, name, qty, unit_trade_price_ex_gst, line_subtotal_ex_gst, sort_order')
    .eq('order_id', orderId).order('sort_order', { ascending: true })

  const lines: WorkshopDocLine[] = (lineRows || []).map((l: any) => ({
    description: l.name || l.sku || '(item)',
    partNumber: l.sku || null,
    qty: Number(l.qty || 0),
    unitPrice: round2(Number(l.unit_trade_price_ex_gst || 0)),
    total: round2(Number(l.line_subtotal_ex_gst || 0)),
  }))

  // Freight is folded into subtotal_ex_gst at checkout — surface it as its own
  // line so the figures reconcile and the distributor sees the freight charge.
  const freightEx = round2(Number(order.freight_cost_ex_gst || 0))
  if (freightEx > 0) {
    lines.push({ description: `Freight — ${order.freight_service_label || order.freight_method_label || 'delivery'}`, partNumber: null, qty: 1, unitPrice: freightEx, total: freightEx })
  }
  // Card surcharge (GST-free pass-through) as a line so the total reconciles.
  const cardFee = round2(Number(order.card_fee_inc || 0))
  if (cardFee > 0) {
    lines.push({ description: 'Card processing surcharge', partNumber: null, qty: 1, unitPrice: cardFee, total: cardFee })
  }

  const subtotal = round2(lines.reduce((s, l) => s + (Number(l.total) || 0), 0))
  const gst = round2(Number(order.gst || 0))
  const total = round2(Number(order.total_inc || 0))

  const invoiceNumber = (order.myob_sale_invoice_number || order.myob_invoice_number || order.order_number) as string

  const snap: any = order.shipping_address_snapshot || null
  const pick = (...vals: any[]): string => { for (const v of vals) { if (v == null) continue; const s = String(v).trim(); if (s) return s } return '' }
  const shipLine = [pick(snap?.line1, snap?.address_line1, dist?.ship_line1), pick(snap?.line2, snap?.address_line2, dist?.ship_line2), [pick(snap?.suburb, dist?.ship_suburb), pick(snap?.state, dist?.ship_state), pick(snap?.postcode, dist?.ship_postcode)].filter(Boolean).join(' ')].filter(Boolean).join('\n')

  // Seller (Just Autos Wholesale). Sender/business details come from B2B
  // settings where available; email from the configured outbound mailbox.
  const { data: settings } = await c.from('b2b_settings').select('machship_from_company, machship_from_address_line1, machship_from_address_line2, machship_from_suburb, machship_from_state, machship_from_postcode, machship_from_phone').eq('id', 'singleton').maybeSingle()
  const sAddr = [settings?.machship_from_address_line1, settings?.machship_from_address_line2, [settings?.machship_from_suburb, settings?.machship_from_state, settings?.machship_from_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const fromEmail = await getFromMailbox()

  const doc: WorkshopDoc = {
    kind: 'invoice',
    title: 'Tax Invoice',
    reference: String(invoiceNumber),
    date: order.paid_at || order.created_at,
    status: null,
    business: {
      name: (settings?.machship_from_company || 'Just Autos Wholesale'),
      abn: null,
      address: sAddr || null,
      phone: settings?.machship_from_phone || null,
      email: fromEmail,
    },
    customer: {
      name: dist?.display_name || 'Distributor',
      company: null,
      phone: dist?.primary_contact_phone || null,
      email: dist?.primary_contact_email || null,
      address: shipLine || null,
    },
    vehicle: null,
    lines,
    subtotal,
    gst,
    total,
    notes: order.customer_po ? `Your PO: ${order.customer_po}` : null,
    footer: null,
  }

  const buffer = await renderWorkshopDocPdf(doc)
  const filename = `Invoice-${String(invoiceNumber).replace(/[^\w.\-]/g, '_')}.pdf`
  return { buffer, filename, invoiceNumber: String(invoiceNumber) }
}
