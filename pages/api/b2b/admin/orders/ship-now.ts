// pages/api/b2b/admin/orders/ship-now.ts
// Admin "Ship Now" — manifests booked MachShip consignments and finalises each
// shipment (MYOB order→invoice, payment receipt, A4 invoice print, distributor
// shipped email/push). Core logic in lib/b2b-ship-now.ts.
//
// POST /api/b2b/admin/orders/ship-now   body { ids: string[] }  (or { id })
//
// Handles one order or a whole despatch run. A batch is deliberately ONE
// MachShip manifest per company, not one per order, because manifesting also
// books a carrier pickup — see the note in lib/b2b-ship-now.ts.
//
// Already-manifested orders come back { ok: true, already: true } rather than
// erroring, so re-pressing the button or including them in a selection is safe.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../lib/authServer'
import { shipNowForOrders } from '../../../../../lib/b2b-ship-now'

// 300s: per order this is a consignment GET + manifest + MYOB convert + payment
// receipt + invoice PDF + email. A ten-order despatch run past 60s would 504
// mid-flight, and book-freight already needed 120 for the same chain.
export const config = { api: { bodyParser: { sizeLimit: '1mb' } }, maxDuration: 300 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const raw: unknown = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : [])
  const ids = (raw as unknown[]).map(v => String(v || '').trim()).filter(Boolean)
  if (!ids.length) return res.status(400).json({ error: 'ids required' })
  // A despatch run is a handful of orders; a huge list is a mistake, and each
  // one costs several MachShip + MYOB round trips.
  if (ids.length > 50) return res.status(400).json({ error: 'Too many orders in one run (max 50)' })

  // Explicit admin approval to ship before a BECS debit clears (the UI asks
  // after the gate's per-order refusal). The acceptance is logged on each order.
  const acceptUnsettled = body.accept_unsettled === true

  const r = await shipNowForOrders(ids, { actorId: user.id, acceptUnsettled })
  if (!r.ok) return res.status(r.httpStatus).json({ error: r.error, detail: r.detail, not_configured: r.notConfigured, results: r.results })

  const shipped = r.results.filter(x => x.ok && !x.already)
  const already = r.results.filter(x => x.ok && x.already)
  const failed  = r.results.filter(x => !x.ok)
  return res.status(200).json({
    ok: true,
    shipped_count: shipped.length,
    already_count: already.length,
    failed_count: failed.length,
    warnings: r.results.map(x => x.warning).filter(Boolean),
    results: r.results,
  })
})
