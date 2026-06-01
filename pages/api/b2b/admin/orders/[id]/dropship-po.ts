// pages/api/b2b/admin/orders/[id]/dropship-po.ts
// Manual admin trigger to raise drop-ship purchase orders for a B2B order
// (also runs automatically on payment via the Stripe webhook). The core logic
// lives in lib/b2b-dropship.ts so both paths stay identical.
//
// POST /api/b2b/admin/orders/{id}/dropship-po
//   ?force=1                          raise again even if already raised
//   body { resend_supplier_uid }      re-email an already-raised PO (no new PO)

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../../lib/authServer'
import { raiseDropShipPOsForOrder, resendDropShipPoEmail } from '../../../../../../lib/b2b-dropship'

export const config = { maxDuration: 60 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const force = String(req.query.force || '') === '1'
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const resendSupplierUid = typeof body.resend_supplier_uid === 'string' ? body.resend_supplier_uid.trim() : ''

  try {
    if (resendSupplierUid) {
      const r = await resendDropShipPoEmail(id, resendSupplierUid, user.id)
      const status = r.ok ? 200 : (r.email_status === 'no_email' ? 200 : 502)
      return res.status(status).json(r)
    }

    const r = await raiseDropShipPOsForOrder(id, { actorId: user.id, force })
    if (r.alreadyRaised) return res.status(409).json({ error: 'Drop-ship POs already raised for this order. Pass ?force=1 to raise again.' })
    if (r.raised.length === 0 && r.failures.length === 0) {
      if (r.missingSupplier.length > 0) {
        return res.status(400).json({ error: 'Drop-ship lines found but their MYOB items have no reorder supplier set. Add one in MYOB (Buying Details).', details: r.missingSupplier })
      }
      if (r.error) return res.status(404).json({ error: r.error })
      return res.status(400).json({ error: 'This order has no drop-ship line items.' })
    }
    return res.status(r.failures.length > 0 && r.raised.length === 0 ? 502 : 200).json({
      ok: r.raised.length > 0, raised: r.raised, failures: r.failures,
      missing_supplier: r.missingSupplier, missing_item: r.missingItem,
    })
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (/config incomplete|not connected|company file/i.test(msg)) {
      return res.status(503).json({ error: 'MYOB/Stripe config incomplete — fix B2B Settings first.', detail: msg })
    }
    return res.status(500).json({ error: msg })
  }
})
