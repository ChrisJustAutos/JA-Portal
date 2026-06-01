// pages/api/b2b/admin/orders/[id]/book-freight.ts
// Admin trigger to book the chosen MachShip route on a B2B order. The core
// logic lives in lib/b2b-freight-book.ts so the login-less email action shares
// it. Idempotent (?force=1 to re-book).
//
// POST /api/b2b/admin/orders/{id}/book-freight   body {}   query ?force=1

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../../lib/authServer'
import { bookFreightForOrder } from '../../../../../../lib/b2b-freight-book'

export const config = { api: { bodyParser: { sizeLimit: '1mb' } }, maxDuration: 60 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const force = String(req.query.force || '') === '1'

  const r = await bookFreightForOrder(id, { actorId: user.id, force })
  if (!r.ok) return res.status(r.httpStatus).json({ error: r.error, detail: r.detail })
  return res.status(200).json({
    ok: true, consignment_id: r.consignment_id, consignment_number: r.consignment_number,
    tracking_number: r.tracking_number, eta_utc: r.eta_utc, status: r.status,
    label_path: r.label_path, label_warning: r.label_warning,
  })
})
