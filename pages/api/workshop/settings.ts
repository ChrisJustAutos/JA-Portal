// pages/api/workshop/settings.ts
// One stop for the workshop_settings singleton (admin:settings).
//   GET   — { settings, incomeAccounts } (income accounts best-effort; empty
//            with a note if MYOB VPS isn't reachable).
//   PATCH — update any known settings field (business letterhead, invoicing,
//            SMS). Booleans/numbers coerced; '' clears text fields.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { getWorkshopSettings, setWorkshopSettings, listIncomeAccounts } from '../../../lib/workshop-myob-invoice'

export const config = { maxDuration: 30 }

const TEXT_FIELDS = ['business_name', 'business_abn', 'business_address', 'business_phone', 'business_email', 'document_footer', 'sms_from', 'myob_sales_account_uid', 'myob_sales_account_name'] as const
const BOOL_FIELDS = ['invoice_as_order', 'sms_enabled'] as const

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })

  if (req.method === 'GET') {
    const settings = await getWorkshopSettings()
    let incomeAccounts: any[] = []
    let accountsError: string | null = null
    try { incomeAccounts = await listIncomeAccounts() }
    catch (e: any) { accountsError = e?.message || 'Could not load MYOB income accounts' }
    return res.status(200).json({ settings, incomeAccounts, accountsError })
  }

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    for (const f of TEXT_FIELDS) if (f in body) patch[f] = body[f] === '' ? null : String(body[f])
    for (const f of BOOL_FIELDS) if (f in body) patch[f] = !!body[f]
    if ('booking_reminder_lead_hours' in body) patch.booking_reminder_lead_hours = Math.max(0, Number(body.booking_reminder_lead_hours) || 0)
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No known settings fields in body' })
    await setWorkshopSettings(patch)
    return res.status(200).json({ ok: true, settings: await getWorkshopSettings() })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
