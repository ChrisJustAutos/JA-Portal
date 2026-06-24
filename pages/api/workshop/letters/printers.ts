// pages/api/workshop/letters/printers.ts
// GET — print-agent settings (printer routing + the printers the agent reported
//        installed on its PC + last-seen) (view:diary)
// PUT — set letter/envelope printer + scales (admin:settings)

import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getPrintAgentSettings, setPrintAgentSettings, PrintAgentSettings } from '../../../../lib/workshop-letters'

const TEXT = ['letter_printer', 'envelope_printer', 'invoice_printer', 'letter_scale', 'envelope_scale', 'letter_bin', 'envelope_bin', 'invoice_bin'] as const

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    return res.status(200).json({ printers: await getPrintAgentSettings() })
  }
  if (req.method === 'PUT') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const patch: Partial<PrintAgentSettings> = {}
    for (const f of TEXT) if (f in body) (patch as any)[f] = body[f] === '' ? null : body[f]
    try { return res.status(200).json({ ok: true, printers: await setPrintAgentSettings(patch) }) }
    catch (e: any) { return res.status(500).json({ error: e?.message || 'Save failed' }) }
  }
  res.setHeader('Allow', 'GET, PUT')
  return res.status(405).json({ error: 'Method not allowed' })
})
