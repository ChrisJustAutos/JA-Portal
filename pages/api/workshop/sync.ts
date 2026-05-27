// pages/api/workshop/sync.ts
// POST ?what=customers|inventory|all — pull MYOB (VPS) Contacts + Items into
// workshop_customers / workshop_inventory. Admin-only; long-running.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { syncWorkshopCustomers, syncWorkshopInventory, WorkshopSyncResult } from '../../../lib/workshop-myob-sync'

export const config = { maxDuration: 300 }

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  if (!roleHasPermission(user.role, 'admin:settings')) {
    return res.status(403).json({ error: 'Admin only' })
  }
  const what = String(req.query.what || 'all')
  try {
    const results: WorkshopSyncResult[] = []
    if (what === 'customers' || what === 'all') results.push(await syncWorkshopCustomers(user.id))
    if (what === 'inventory' || what === 'all') results.push(await syncWorkshopInventory(user.id))
    return res.status(200).json({ ok: true, results })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})
