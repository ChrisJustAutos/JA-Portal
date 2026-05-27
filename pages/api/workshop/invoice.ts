// pages/api/workshop/invoice.ts
// POST  { booking_id }  — create a MYOB Service sale for the job (edit:bookings)
// GET                   — workshop settings + JAWS income-account candidates
//                         for the sales-account picker (admin)
// PATCH { myob_sales_account_uid, myob_sales_account_name, invoice_as_order }
//                       — set workshop invoice settings (admin)

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import {
  createJobInvoiceInMyob, getWorkshopSettings, setWorkshopSettings,
  listJawsIncomeAccounts, WorkshopInvoiceError,
} from '../../../lib/workshop-myob-invoice'

export const config = { maxDuration: 60 }

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    try {
      const [settings, candidates] = await Promise.all([getWorkshopSettings(), listJawsIncomeAccounts()])
      return res.status(200).json({ settings, candidates })
    } catch (e: any) { return res.status(500).json({ error: e?.message || 'Failed to load accounts' }) }
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const patch: any = {}
    if ('myob_sales_account_uid' in body) patch.myob_sales_account_uid = body.myob_sales_account_uid || null
    if ('myob_sales_account_name' in body) patch.myob_sales_account_name = body.myob_sales_account_name || null
    if ('invoice_as_order' in body) patch.invoice_as_order = !!body.invoice_as_order
    await setWorkshopSettings(patch)
    return res.status(200).json({ ok: true, settings: await getWorkshopSettings() })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const bookingId = String(body.booking_id || '').trim()
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    try {
      const result = await createJobInvoiceInMyob(bookingId, user.id)
      return res.status(200).json({ ok: true, ...result })
    } catch (e: any) {
      if (e instanceof WorkshopInvoiceError) return res.status(409).json({ ok: false, code: e.code, error: e.message })
      return res.status(500).json({ ok: false, error: e?.message || 'Invoice failed' })
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH')
  return res.status(405).json({ error: 'GET, POST or PATCH only' })
})
