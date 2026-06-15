// pages/api/workshop/myob-accounts.ts
// GET — live MYOB income accounts for the inventory item sale-account picker.
// Admin only. Returns [] + an error note if the VPS file isn't reachable so the
// editor still works (falls back to the currently-saved account name).

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { listIncomeAccounts } from '../../../lib/workshop-myob-invoice'

export const config = { maxDuration: 30 }

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  try {
    const incomeAccounts = await listIncomeAccounts()
    return res.status(200).json({ incomeAccounts })
  } catch (e: any) {
    return res.status(200).json({ incomeAccounts: [], error: e?.message || 'Could not load MYOB accounts (VPS may be down).' })
  }
})
