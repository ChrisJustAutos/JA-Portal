// pages/api/workshop/credit-notes/index.ts
// GET  ?booking_id=|invoice_id=  — credit notes for a job / imported invoice
// POST                           — create a credit note (edit:bookings);
//                                  body = CreateCreditNoteInput. Typed errors
//                                  surface as 409 {code} like payment.ts.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { createCreditNote, listCreditNotes, WorkshopCreditNoteError } from '../../../../lib/workshop-credit-note'

export const config = { maxDuration: 30 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    const bookingId = String(req.query.booking_id || '').trim()
    const invoiceId = String(req.query.invoice_id || '').trim()
    // List ALL credit notes (Invoices → Credit notes tab).
    if (!bookingId && !invoiceId) {
      const q = String(req.query.q || '').replace(/[%,()*]/g, ' ').trim()
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
      const db = sb()
      let custIds: string[] = []
      if (q) {
        const { data: c } = await db.from('workshop_customers').select('id').ilike('name', `%${q}%`).limit(200)
        custIds = (c || []).map((x: any) => x.id)
      }
      let qy = db.from('workshop_credit_notes')
        .select('id, cn_seq, booking_id, invoice_id, customer_id, reason, kind, total_inc, myob_credit_number, myob_write_error, refunded, created_at, customer:workshop_customers!customer_id(name)')
        .is('deleted_at', null).order('created_at', { ascending: false }).limit(limit)
      if (q) {
        const ors = [`reason.ilike.%${q}%`]
        if (custIds.length) ors.push(`customer_id.in.(${custIds.join(',')})`)
        qy = qy.or(ors.join(','))
      }
      const { data, error } = await qy
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ creditNotes: data || [] })
    }
    const creditNotes = await listCreditNotes(bookingId ? { booking_id: bookingId } : { invoice_id: invoiceId })
    return res.status(200).json({ creditNotes })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    try {
      const result = await createCreditNote({
        booking_id: body.booking_id || null,
        invoice_id: body.invoice_id || null,
        kind: body.kind === 'amount' ? 'amount' : 'lines',
        line_ids: Array.isArray(body.line_ids) ? body.line_ids.map(String) : [],
        qty_overrides: body.qty_overrides && typeof body.qty_overrides === 'object' ? body.qty_overrides : {},
        amount: Number(body.amount) || 0,
        reason: String(body.reason || '').slice(0, 500),
        restock_parts: !!body.restock_parts,
        refund: body.refund?.tender ? { tender: body.refund.tender } : null,
      }, user.id, user.displayName || user.email)
      return res.status(201).json({ ok: true, ...result })
    } catch (e: any) {
      if (e instanceof WorkshopCreditNoteError) return res.status(409).json({ error: e.message, code: e.code })
      return res.status(500).json({ error: e?.message || 'Credit note failed' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
