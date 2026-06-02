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

  // Optional desired despatch (collection) time — books now, carrier collects then.
  let dispatchAt: string | undefined
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const rawWhen = String(body.dispatch_at || '').trim()
  if (rawWhen) {
    const d = new Date(rawWhen)
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'dispatch_at is not a valid date/time' })
    dispatchAt = d.toISOString()
  }

  const pm = String(body.pack_mode || '').trim()
  const packMode = (pm === 'pallet' || pm === 'cartons' || pm === 'auto') ? pm as 'pallet' | 'cartons' | 'auto' : undefined

  const r = await bookFreightForOrder(id, { actorId: user.id, force, dispatchAt, packMode })
  if (!r.ok) return res.status(r.httpStatus).json({ error: r.error, detail: r.detail })
  return res.status(200).json({
    ok: true, consignment_id: r.consignment_id, consignment_number: r.consignment_number,
    tracking_number: r.tracking_number, eta_utc: r.eta_utc, status: r.status,
    label_path: r.label_path, label_warning: r.label_warning,
  })
})
