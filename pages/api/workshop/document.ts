// pages/api/workshop/document.ts
// Workshop documents as PDF — quotes, tax invoices, job cards.
//   GET  ?type=quote|jobcard|invoice&id=<uuid>  → renders the PDF inline
//        (view:diary). Open in a tab to print or save.
//   POST { type, id, to?, subject?, message? }   → emails the PDF to the
//        customer (or an override address) via MS Graph (edit:bookings).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { customerLabel, vehicleLabel } from '../../../lib/workshop'
import { getWorkshopSettings } from '../../../lib/workshop-myob-invoice'
import { renderWorkshopDocPdf, WorkshopDoc } from '../../../lib/workshop-pdf'
import { sendMail } from '../../../lib/email'

export const config = { maxDuration: 30 }

const FROM_MAILBOX =
  process.env.WORKSHOP_FROM_MAILBOX ||
  process.env.B2B_PO_FROM_MAILBOX ||
  process.env.AP_INBOX_MAILBOX ||
  'accounts@justautosmechanical.com.au'

type DocType = 'quote' | 'jobcard' | 'invoice' | 'po'
const round2 = (n: number) => Math.round(n * 100) / 100

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function prettyStatus(status: string | null | undefined): string | null {
  if (!status) return null
  const s = String(status).replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

interface BuiltDoc { doc: WorkshopDoc; customerEmail: string | null; customerName: string; filename: string }

async function buildDoc(db: SupabaseClient, type: DocType, id: string): Promise<BuiltDoc | null> {
  const settings = await getWorkshopSettings()
  const business = {
    name: settings.business_name || 'Vehicle Performance Solutions',
    abn: settings.business_abn, address: settings.business_address,
    phone: settings.business_phone, email: settings.business_email,
  }
  const footer = settings.document_footer || null

  if (type === 'quote') {
    const { data: quote } = await db.from('workshop_quotes')
      .select('*, customer:workshop_customers(*), vehicle:workshop_vehicles(*)').eq('id', id).maybeSingle()
    if (!quote) return null
    const { data: lines } = await db.from('workshop_quote_lines').select('*').eq('quote_id', id).order('sort_order', { ascending: true })
    const docLines = (lines || []).map((l: any) => (
      l.line_type === 'description'
        ? { description: l.description || '', partNumber: null, qty: 0, unitPrice: 0, total: 0, isHeading: true }
        : {
            description: l.description || '', partNumber: l.part_number,
            qty: Number(l.qty) || 0, unitPrice: Number(l.unit_price) || 0,
            total: round2((Number(l.qty) || 0) * (Number(l.unit_price) || 0)),
          }
    ))
    const cust: any = (quote as any).customer || {}
    const veh: any = (quote as any).vehicle
    const ref = (quote as any).quote_seq ? `Q-${(quote as any).quote_seq}` : `Q-${String(id).slice(0, 8).toUpperCase()}`
    let salesperson: string | null = null
    if ((quote as any).salesperson_id) {
      const { data: sp } = await db.from('user_profiles').select('display_name, email').eq('id', (quote as any).salesperson_id).maybeSingle()
      salesperson = sp ? (sp.display_name || sp.email) : null
    }
    const doc: WorkshopDoc = {
      kind: 'quote', title: 'Quote', reference: ref,
      date: (quote as any).created_at || new Date().toISOString(),
      status: prettyStatus((quote as any).status), business,
      customer: { name: customerLabel(cust) || cust.name || '—', company: cust.company || null, phone: cust.mobile || cust.phone || null, email: cust.email || null, address: cust.address || null },
      vehicle: veh ? { label: vehicleLabel(veh), rego: veh.rego, vin: veh.vin, odometer: veh.odometer } : null,
      lines: docLines, subtotal: Number((quote as any).subtotal) || 0, gst: Number((quote as any).gst) || 0, total: Number((quote as any).total) || 0,
      notes: (quote as any).notes || null, terms: settings.quote_terms || null, footer, salesperson,
    }
    return { doc, customerEmail: cust.email || null, customerName: cust.name || 'customer', filename: `${ref}.pdf` }
  }

  if (type === 'po') {
    const { data: po } = await db.from('workshop_purchase_orders')
      .select('*, supplier:workshop_suppliers(id, name, email, phone, address)').eq('id', id).is('deleted_at', null).maybeSingle()
    if (!po) return null
    const { data: lines } = await db.from('workshop_po_lines').select('*').eq('po_id', id).order('sort_order', { ascending: true })
    const sup: any = (po as any).supplier || {}
    let sub = 0
    const docLines = (lines || []).map((l: any) => {
      const ex = round2((Number(l.line_total_ex_gst) ?? 0) || (Number(l.qty) * Number(l.unit_cost_ex_gst)))
      sub += ex
      return { description: l.name || l.sku || '', partNumber: l.sku, qty: Number(l.qty) || 0, unitPrice: Number(l.unit_cost_ex_gst) || 0, total: ex }
    })
    sub = round2(sub)
    const poGst = round2(sub * 0.10)
    const ref = `PO-${String((po as any).po_seq).padStart(4, '0')}`
    const doc: WorkshopDoc = {
      kind: 'po', title: 'Purchase Order', reference: ref,
      date: (po as any).ordered_at || (po as any).created_at || new Date().toISOString(),
      status: prettyStatus((po as any).status), business,
      customer: { name: sup.name || (po as any).supplier_name || '—', phone: sup.phone || null, email: sup.email || null, address: sup.address || null },
      partyLabel: 'Supplier', vehicle: null,
      lines: docLines, subtotal: sub, gst: poGst, total: round2(sub + poGst),
      notes: (po as any).notes || null, terms: settings.po_terms || null, footer,
    }
    return { doc, customerEmail: sup.email || null, customerName: sup.name || 'supplier', filename: `${ref}.pdf` }
  }

  // jobcard | invoice — both render from a booking
  const { data: booking } = await db.from('workshop_bookings')
    .select('*, customer:workshop_customers(*), vehicle:workshop_vehicles(*)').eq('id', id).maybeSingle()
  if (!booking) return null
  const { data: lines } = await db.from('workshop_booking_lines').select('*').eq('booking_id', id).order('sort_order', { ascending: true })
  let subtotal = 0, gst = 0
  const docLines = (lines || []).map((l: any) => {
    if (l.line_type === 'description') {
      return { description: l.description || '', partNumber: null, qty: 0, unitPrice: 0, total: 0, isHeading: true }
    }
    const ex = round2((Number(l.total_ex_gst) ?? 0) || (Number(l.qty) * Number(l.unit_price_ex_gst)))
    subtotal += ex; gst += ex * (Number(l.gst_rate) || 0.10)
    return { description: l.description || l.part_number || l.line_type || '', partNumber: l.part_number, qty: Number(l.qty) || 0, unitPrice: Number(l.unit_price_ex_gst) || 0, total: ex }
  })
  subtotal = round2(subtotal); gst = round2(gst)
  const cust: any = (booking as any).customer || {}
  const veh: any = (booking as any).vehicle
  const isInvoice = type === 'invoice'
  const ref = `${isInvoice ? 'INV' : 'JOB'}-${String(id).slice(0, 8).toUpperCase()}`
  const doc: WorkshopDoc = {
    kind: isInvoice ? 'invoice' : 'jobcard',
    title: isInvoice ? 'Tax Invoice' : 'Job Card',
    reference: ref,
    date: (booking as any).completed_at || (booking as any).starts_at || (booking as any).created_at || new Date().toISOString(),
    status: prettyStatus((booking as any).status), business,
    customer: { name: customerLabel(cust) || cust.name || '—', company: cust.company || null, phone: cust.mobile || cust.phone || null, email: cust.email || null, address: cust.address || null },
    vehicle: veh ? { label: vehicleLabel(veh), rego: veh.rego, vin: veh.vin, odometer: (booking as any).odometer || veh.odometer } : null,
    lines: docLines, subtotal, gst, total: round2(subtotal + gst),
    notes: [(booking as any).description, (booking as any).summary, (booking as any).notes].filter(Boolean).join('\n\n') || null,
    terms: isInvoice ? (settings.invoice_terms || null) : null,
    footer,
  }
  return { doc, customerEmail: cust.email || null, customerName: cust.name || 'customer', filename: `${ref}.pdf` }
}

function parseType(raw: any): DocType | null {
  const t = String(raw || '').toLowerCase()
  return t === 'quote' || t === 'jobcard' || t === 'invoice' || t === 'po' ? t : null
}

const FILES_BUCKET = 'workshop-files'

interface AttachmentCandidate { id: string; file_name: string; mime_type: string | null; size_bytes: number | null; source: 'job' | 'jobtype' }

// Optional PDFs an email can include: the booking's own uploaded files + the
// files attached to any job type applied to this booking/quote (template docs
// like checklists, warranty sheets).
async function gatherAttachmentCandidates(db: SupabaseClient, type: DocType, id: string): Promise<AttachmentCandidate[]> {
  const out: AttachmentCandidate[] = []
  const jtIds = new Set<string>()

  if (type === 'jobcard' || type === 'invoice') {
    const { data: bf } = await db.from('workshop_files')
      .select('id, file_name, mime_type, size_bytes').eq('booking_id', id).order('created_at', { ascending: false })
    for (const f of bf || []) out.push({ ...(f as any), source: 'job' })
    const { data: links } = await db.from('workshop_doc_job_types').select('job_type_id').eq('booking_id', id)
    for (const l of links || []) jtIds.add((l as any).job_type_id)
    const { data: bk } = await db.from('workshop_bookings').select('job_type').eq('id', id).maybeSingle()
    if ((bk as any)?.job_type) {
      const { data: jt } = await db.from('workshop_job_types').select('id').ilike('name', String((bk as any).job_type))
      for (const j of jt || []) jtIds.add((j as any).id)
    }
  } else if (type === 'quote') {
    const { data: links } = await db.from('workshop_doc_job_types').select('job_type_id').eq('quote_id', id)
    for (const l of links || []) jtIds.add((l as any).job_type_id)
  }

  if (jtIds.size) {
    const { data: jf } = await db.from('workshop_files')
      .select('id, file_name, mime_type, size_bytes').in('job_type_id', Array.from(jtIds))
    for (const f of jf || []) out.push({ ...(f as any), source: 'jobtype' })
  }
  return out
}

export default withAuth('view:diary', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const type = parseType(req.query.type)
    const id = String(req.query.id || '').trim()
    if (!type || !id) return res.status(400).json({ error: 'type (quote|jobcard|invoice) and id required' })

    // ?meta=1 → JSON for the editable send-email preview (no PDF render).
    if (req.query.meta) {
      const built = await buildDoc(db, type, id)
      if (!built) return res.status(404).json({ error: 'not_found' })
      const attachments = await gatherAttachmentCandidates(db, type, id)
      return res.status(200).json({
        ok: true,
        to: built.customerEmail || '',
        subject: `${built.doc.title} ${built.doc.reference} — ${built.doc.business.name}`,
        message: `Please find your ${built.doc.title.toLowerCase()} attached${built.doc.vehicle ? ` for your ${built.doc.vehicle.label}` : ''}.`,
        doc: { title: built.doc.title, reference: built.doc.reference, filename: built.filename },
        attachments,
      })
    }

    const built = await buildDoc(db, type, id)
    if (!built) return res.status(404).json({ error: 'not_found' })
    const pdf = await renderWorkshopDocPdf(built.doc)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).send(pdf)
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden — cannot send documents' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const type = parseType(body.type)
    const id = String(body.id || '').trim()
    if (!type || !id) return res.status(400).json({ error: 'type and id required' })

    const built = await buildDoc(db, type, id)
    if (!built) return res.status(404).json({ error: 'not_found' })
    const to = String(body.to || built.customerEmail || '').trim()
    if (!to) return res.status(400).json({ error: 'no_email', message: 'This customer has no email. Add one or pass a "to" address.' })

    const pdf = await renderWorkshopDocPdf(built.doc)
    const bizName = built.doc.business.name
    const firstName = (built.customerName || 'there').split(' ')[0]
    const subject = String(body.subject || '').trim() || `${built.doc.title} ${built.doc.reference} — ${bizName}`
    const message = String(body.message || '').trim()
    const html = `<p>Hi ${firstName},</p>`
      + `<p>${message || `Please find your ${built.doc.title.toLowerCase()} attached${built.doc.vehicle ? ` for your ${built.doc.vehicle.label}` : ''}.`}</p>`
      + `<p>Total: <strong>$${built.doc.total.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> (inc GST).</p>`
      + `<p>Thanks,<br/>${bizName}</p>`

    const attachments: { name: string; contentType: string; content: Buffer }[] = [
      { name: built.filename, contentType: 'application/pdf', content: pdf },
    ]

    // Extra attachments — booking files / applied job-type template docs the
    // sender ticked. Restricted to this doc's candidate set.
    const fileIds: string[] = Array.isArray(body.file_ids) ? body.file_ids.map(String) : []
    if (fileIds.length) {
      const allowed = new Set((await gatherAttachmentCandidates(db, type, id)).map(c => c.id))
      for (const fid of fileIds.filter(f => allowed.has(f)).slice(0, 12)) {
        const { data: row } = await db.from('workshop_files').select('storage_path, file_name, mime_type').eq('id', fid).maybeSingle()
        if (!row) continue
        const dl = await db.storage.from(FILES_BUCKET).download((row as any).storage_path)
        if (dl.error || !dl.data) continue
        attachments.push({ name: (row as any).file_name || 'attachment', contentType: (row as any).mime_type || 'application/octet-stream', content: Buffer.from(await dl.data.arrayBuffer()) })
      }
    }

    try {
      await sendMail(FROM_MAILBOX, { to: [to], subject, html, replyTo: built.doc.business.email || undefined, attachments })
    } catch (e: any) {
      return res.status(502).json({ error: 'send_failed', message: e?.message || 'Email send failed' })
    }

    // Record in the comms history (best-effort).
    try {
      let customerId: string | null = null, bookingId: string | null = null, quoteId: string | null = null
      if (type === 'jobcard' || type === 'invoice') { bookingId = id; const { data: bk } = await db.from('workshop_bookings').select('customer_id').eq('id', id).maybeSingle(); customerId = (bk as any)?.customer_id || null }
      else if (type === 'quote') { quoteId = id; const { data: qq } = await db.from('workshop_quotes').select('customer_id').eq('id', id).maybeSingle(); customerId = (qq as any)?.customer_id || null }
      const nowIso = new Date().toISOString()
      await db.from('workshop_reminders').insert({
        type: 'document', channel: 'email', to_email: to,
        subject, body: `${built.doc.title} ${built.doc.reference}${attachments.length > 1 ? ` (+${attachments.length - 1} attachment${attachments.length > 2 ? 's' : ''})` : ''}${message ? `\n\n${message}` : ''}`,
        customer_id: customerId, booking_id: bookingId, quote_id: quoteId,
        status: 'sent', send_at: nowIso, sent_at: nowIso, created_by: user.id,
      })
    } catch { /* logging is best-effort */ }

    return res.status(200).json({ ok: true, to, attached: attachments.length })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
