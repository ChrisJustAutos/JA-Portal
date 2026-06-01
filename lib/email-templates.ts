// lib/email-templates.ts
// SERVER-ONLY. Editable transactional email templates for the B2B order flow
// (supplier / distributor / internal admin). Defaults live here in code; a
// b2b_email_templates row stores any admin override + enabled flag (so "reset
// to default" just deletes the row). One renderer wraps every email in the same
// branded shell and substitutes {{tokens}} — simple vars escaped, prebuilt
// block tokens (line tables, buttons, addresses) injected as trusted HTML.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _sb: SupabaseClient | null = null
function svc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export type TemplateKey =
  | 'supplier_dropship_po'
  | 'admin_order_placed'
  | 'distributor_order_confirmed'
  | 'distributor_invoice'
  | 'distributor_shipped'

export interface TemplateVar { token: string; desc: string }
export interface TemplateDef {
  label: string
  direction: 'Supplier' | 'Distributor' | 'Internal'
  description: string
  defaultSubject: string
  defaultBody: string
  variables: TemplateVar[]
}

const v = (token: string, desc: string): TemplateVar => ({ token, desc })

export const TEMPLATE_DEFS: Record<TemplateKey, TemplateDef> = {
  supplier_dropship_po: {
    label: 'Drop-ship purchase order', direction: 'Supplier',
    description: 'Sent to the supplier (email from their MYOB card) when a drop-ship PO is raised.',
    defaultSubject: 'Purchase Order {{po_number}} — Just Autos (drop ship)',
    defaultBody:
`Hi {{supplier_name}},

Please supply the following on drop ship — deliver direct to the customer at the address below. Our purchase order {{po_number}} (ref {{order_reference}}) follows.

{{lines_table}}

Deliver to:
{{ship_to}}

Thanks,
Just Autos Mechanical`,
    variables: [v('supplier_name', 'Supplier name'), v('po_number', 'MYOB PO number'), v('order_reference', 'Order # / customer PO'), v('lines_table', 'Item table (block)'), v('ship_to', 'Delivery address (block)')],
  },
  admin_order_placed: {
    label: 'Order placed (admin notification)', direction: 'Internal',
    description: 'Sent to your team (B2B Settings → Order notification emails) when an order is paid.',
    defaultSubject: 'New B2B order {{order_number}} — {{distributor_name}}',
    defaultBody:
`New B2B order {{order_number}} from {{distributor_name}} — total {{order_total}} inc GST{{customer_po}}.

{{portal_link}}

Items:
{{lines_table}}

Drop-ship:
{{dropship_summary}}

Ship to:
{{ship_to}}

Freight:
{{book_freight_button}}

{{customer_notes}}`,
    variables: [v('order_number', 'Order number'), v('distributor_name', 'Distributor'), v('order_total', 'Total inc GST'), v('customer_po', "Their PO (or blank)"), v('portal_link', 'Open-in-portal link (block)'), v('lines_table', 'Item table (block)'), v('dropship_summary', 'Drop-ship outcome (block)'), v('ship_to', 'Ship-to (block)'), v('book_freight_button', 'Book-freight button (block)'), v('customer_notes', 'Customer notes (or blank)')],
  },
  distributor_order_confirmed: {
    label: 'Order confirmation', direction: 'Distributor',
    description: 'Sent to the distributor (primary contact email) when their order is paid.',
    defaultSubject: 'Order {{order_number}} received — Just Autos',
    defaultBody:
`Hi {{distributor_name}},

Thanks for your order {{order_number}}{{customer_po}} — we've received it and it's being processed. Order total {{order_total}} inc GST.

{{lines_table}}

Shipping to:
{{ship_to}}

We'll email tracking as soon as it ships.

Just Autos`,
    variables: [v('distributor_name', 'Distributor'), v('order_number', 'Order number'), v('customer_po', 'Their PO (or blank)'), v('order_total', 'Total inc GST'), v('lines_table', 'Item table (block)'), v('ship_to', 'Ship-to (block)')],
  },
  distributor_invoice: {
    label: 'Tax invoice / receipt', direction: 'Distributor',
    description: 'Sent to the distributor (invoice email) once paid and the MYOB invoice exists.',
    defaultSubject: 'Tax invoice {{invoice_number}} — order {{order_number}}',
    defaultBody:
`Hi {{distributor_name}},

Your tax invoice for order {{order_number}} is {{invoice_number}} — total {{order_total}} inc GST. Thanks for your business.

Just Autos`,
    variables: [v('distributor_name', 'Distributor'), v('order_number', 'Order number'), v('invoice_number', 'MYOB invoice number'), v('order_total', 'Total inc GST')],
  },
  distributor_shipped: {
    label: 'Shipped + tax invoice', direction: 'Distributor',
    description: 'Sent to the distributor when Just Autos books freight: consignment, tracking and the tax invoice (PDF attached).',
    defaultSubject: 'Order {{order_number}} shipped — invoice {{invoice_number}}, tracking {{tracking_number}}',
    defaultBody:
`Hi {{distributor_name}},

Good news — order {{order_number}} has shipped with {{carrier}}.
Consignment: {{consignment_number}}
Tracking: {{tracking_number}}
Estimated delivery: {{eta}}

Your tax invoice {{invoice_number}} (total {{order_total}} inc GST) is attached.

{{tracking_link}}

Just Autos`,
    variables: [v('distributor_name', 'Distributor'), v('order_number', 'Order number'), v('invoice_number', 'Tax invoice number'), v('order_total', 'Total inc GST'), v('carrier', 'Carrier/service'), v('consignment_number', 'Consignment number'), v('tracking_number', 'Tracking number'), v('eta', 'ETA (or blank)'), v('tracking_link', 'Tracking link button (block)')],
  },
}

export function escapeHtml(s: any): string {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

// ── Prebuilt block builders (callers pass the results as `blocks`) ──────
export function linesTableHtml(lines: { description: string; qty: number | string }[]): string {
  const rows = lines.map(l => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(l.description)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${escapeHtml(l.qty)}</td></tr>`).join('')
  return `<table style="border-collapse:collapse;width:100%;margin:8px 0"><thead><tr><th style="padding:6px 10px;border-bottom:2px solid #333;text-align:left">Item</th><th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Qty</th></tr></thead><tbody>${rows}</tbody></table>`
}
export function addressBlock(text: string): string {
  return `<pre style="font-family:inherit;background:#f6f6f6;padding:10px 12px;border-radius:6px;white-space:pre-wrap;margin:6px 0">${escapeHtml(text)}</pre>`
}
export function buttonHtml(label: string, url: string, color = '#4f8ef7'): string {
  return `<a href="${escapeHtml(url)}" style="background:${color};color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:600;display:inline-block;margin:6px 0">${escapeHtml(label)}</a>`
}
export function linkHtml(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}" style="color:#4f8ef7">${escapeHtml(label)}</a>`
}

function wrapHtml(inner: string, logoUrl?: string | null): string {
  // Header: logo image if configured (b2b_settings.email_logo_url), else the
  // plain wordmark. max-height keeps oversized logos sane across mail clients.
  const header = logoUrl
    ? `<div style="border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:16px"><img src="${escapeHtml(logoUrl)}" alt="Just Autos" style="max-height:56px;max-width:240px;display:block"/></div>`
    : `<div style="border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:16px;font-size:18px;font-weight:700">Just Autos</div>`
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;margin:0 auto">
    ${header}
    ${inner}
    <div style="border-top:1px solid #eee;margin-top:20px;padding-top:10px;color:#888;font-size:12px">Just Autos Mechanical · Sent automatically by the Just Autos portal.</div>
  </div>`
}

// The configured email logo URL (b2b_settings.email_logo_url), or null. Read
// per render — cheap and always current after an admin changes it.
async function loadEmailLogoUrl(): Promise<string | null> {
  try {
    const { data } = await svc().from('b2b_settings').select('email_logo_url').eq('id', 'singleton').maybeSingle()
    const u = String((data as any)?.email_logo_url || '').trim()
    return u || null
  } catch { return null }
}

// Convert the (plain-text-with-tokens) body to safe HTML, then substitute.
function bodyToHtml(body: string, vars: Record<string, string>, blocks: Record<string, string>): string {
  let html = escapeHtml(body)
  html = '<p style="line-height:1.6;margin:0 0 12px">' + html.replace(/\n\n+/g, '</p><p style="line-height:1.6;margin:0 0 12px">').replace(/\n/g, '<br/>') + '</p>'
  for (const [token, raw] of Object.entries(blocks)) html = html.split(`{{${token}}}`).join(raw || '')
  for (const [token, val] of Object.entries(vars)) html = html.split(`{{${token}}}`).join(escapeHtml(val))
  return html.replace(/\{\{[^}]+\}\}/g, '')
}
function subjectSubstitute(subject: string, vars: Record<string, string>): string {
  let s = subject
  for (const [token, val] of Object.entries(vars)) s = s.split(`{{${token}}}`).join(String(val ?? ''))
  return s.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim()
}

export interface LoadedTemplate { enabled: boolean; subject: string; body: string }
export async function loadTemplate(key: TemplateKey): Promise<LoadedTemplate> {
  const def = TEMPLATE_DEFS[key]
  const { data } = await svc().from('b2b_email_templates').select('enabled, subject, body').eq('key', key).maybeSingle()
  return {
    enabled: data ? data.enabled !== false : true,
    subject: (data?.subject ?? '').trim() || def.defaultSubject,
    body: (data?.body ?? '').trim() || def.defaultBody,
  }
}

export interface RenderedEmail { enabled: boolean; subject: string; html: string }
export async function renderEmail(key: TemplateKey, vars: Record<string, string>, blocks: Record<string, string> = {}): Promise<RenderedEmail> {
  const t = await loadTemplate(key)
  if (!t.enabled) return { enabled: false, subject: '', html: '' }
  const logoUrl = await loadEmailLogoUrl()
  return { enabled: true, subject: subjectSubstitute(t.subject, vars), html: wrapHtml(bodyToHtml(t.body, vars, blocks), logoUrl) }
}

// For the settings API: all templates merged with their defaults + metadata.
export async function listTemplatesWithOverrides(): Promise<Array<{ key: TemplateKey; label: string; direction: string; description: string; enabled: boolean; subject: string; body: string; isOverridden: boolean; variables: TemplateVar[] }>> {
  const { data } = await svc().from('b2b_email_templates').select('key, enabled, subject, body')
  const byKey = new Map((data || []).map((r: any) => [r.key, r]))
  return (Object.keys(TEMPLATE_DEFS) as TemplateKey[]).map(key => {
    const def = TEMPLATE_DEFS[key]
    const row: any = byKey.get(key)
    return {
      key, label: def.label, direction: def.direction, description: def.description,
      enabled: row ? row.enabled !== false : true,
      subject: (row?.subject ?? '').trim() || def.defaultSubject,
      body: (row?.body ?? '').trim() || def.defaultBody,
      isOverridden: !!row,
      variables: def.variables,
    }
  })
}
