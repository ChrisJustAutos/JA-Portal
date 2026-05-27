// pages/api/workshop/payment.ts
// GET  ?booking_id=  — payments for a job + paid total (view:diary)
// POST { booking_id, amount, tender, note } — take a payment (edit:bookings).
//        Records locally; posts a MYOB CustomerPayment when posting is enabled
//        and the job has a MYOB invoice.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { PAYMENT_TENDERS, PaymentTender } from '../../../lib/workshop'
import { recordJobPayment, listJobPayments, WorkshopPaymentError } from '../../../lib/workshop-myob-invoice'

export const config = { maxDuration: 30 }

const TENDER_IDS = PAYMENT_TENDERS.map(t => t.id)

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    const bookingId = String(req.query.booking_id || '').trim()
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    try {
      const data = await listJobPayments(bookingId)
      return res.status(200).json(data)
    } catch (e: any) { return res.status(500).json({ error: e?.message || 'Failed to load payments' }) }
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const bookingId = String(body.booking_id || '').trim()
    const tender = String(body.tender || '') as PaymentTender
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    if (!TENDER_IDS.includes(tender)) return res.status(400).json({ error: 'invalid tender' })
    try {
      const result = await recordJobPayment(bookingId, { amount: Number(body.amount), tender, note: body.note || null }, user.id)
      return res.status(200).json({ ok: true, ...result })
    } catch (e: any) {
      if (e instanceof WorkshopPaymentError) return res.status(409).json({ ok: false, code: e.code, error: e.message })
      return res.status(500).json({ ok: false, error: e?.message || 'Payment failed' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
