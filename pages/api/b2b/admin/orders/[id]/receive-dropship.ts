// pages/api/b2b/admin/orders/[id]/receive-dropship.ts
//
// POST — "supplier confirmed" receiving for a drop-ship order: converts the
// order's un-billed drop-ship purchase orders to BILLS in MYOB (receives the
// stock into the supplier's DS location), then retries the sale-order →
// invoice conversion + customer-payment receipting that freight booking
// attempted. Core logic lives in lib/b2b-dropship-receive.ts.
//
// Returns { ok, steps: [{ step, ok, detail }] } so the admin page can show
// exactly what happened per PO / per accounting step.
//
// Permission: admin:b2b (same as the other money-path order endpoints)

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../../lib/authServer'
import { receiveDropShipPo } from '../../../../../../lib/b2b-dropship-receive'

export const config = { maxDuration: 120 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  try {
    const r = await receiveDropShipPo(id, { actorId: user.id })
    // Pre-flight failures (not found / nothing to bill / claim contention)
    // carry an error and no steps — surface them at their own status.
    if (r.error && r.steps.length === 0) return res.status(r.httpStatus).json({ error: r.error })
    return res.status(200).json({ ok: r.ok, steps: r.steps })
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (/not connected|company file/i.test(msg)) {
      return res.status(503).json({ error: 'MYOB config incomplete — fix B2B Settings first.', detail: msg })
    }
    return res.status(500).json({ error: msg })
  }
})
