// pages/api/workshop/myob-suppliers.ts
// GET ?q= — search MYOB (VPS) supplier cards to link a workshop supplier to its
// MYOB card (enables posting purchase bills to MYOB). Returns [] + an error note
// if the VPS file isn't reachable so the picker degrades gracefully.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { searchSuppliers, CompanyFileLabel } from '../../../lib/ap-myob-lookup'
import { WORKSHOP_MYOB_LABEL } from '../../../lib/workshop'

export const config = { maxDuration: 30 }

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
  const q = String(req.query.q || '').trim()
  try {
    const list = await searchSuppliers(WORKSHOP_MYOB_LABEL as CompanyFileLabel, q, 25)
    return res.status(200).json({ suppliers: list.map(s => ({ uid: s.uid, name: s.name, displayId: s.displayId })) })
  } catch (e: any) {
    return res.status(200).json({ suppliers: [], error: e?.message || 'Could not reach MYOB (VPS).' })
  }
})
