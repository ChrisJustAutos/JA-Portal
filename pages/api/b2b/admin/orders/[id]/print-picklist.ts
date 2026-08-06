// POST /api/b2b/admin/orders/{id}/print-picklist — (re)print the pick list
// for an order on the workshop printer (kind 'invoice' → Fujifilm Upstairs).
// Pick lists print automatically when an order is paid; this button covers
// reprints and pre-automation orders (e.g. Torrisi B2B-2026-000040).

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../../lib/authServer'
import { queuePickListPrint } from '../../../../../../lib/b2b-pick-list-print'

export default withAuth('edit:b2b_orders', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const orderId = String(req.query.id || '').trim()
  if (!orderId) return res.status(400).json({ error: 'Missing order id' })
  const r = await queuePickListPrint(orderId, { force: true })
  if (r.status === 'failed') return res.status(500).json({ error: r.reason })
  return res.status(200).json({ ok: true, status: r.status, path: (r as any).path || null })
})
