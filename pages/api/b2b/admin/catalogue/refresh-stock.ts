// pages/api/b2b/admin/catalogue/refresh-stock.ts
// POST → force a full JAWS inventory refresh so the catalogue's cached stock
// columns (qty_available / is_inventoried / stock_cached_at) are current.
// Backs the "Refresh stock" button on the admin catalogue page.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../lib/authServer'
import { refreshAllStock } from '../../../../../lib/b2b-stock'

export const config = { maxDuration: 60 }

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  try {
    const r = await refreshAllStock()
    return res.status(200).json({ ok: true, ...r })
  } catch (e: any) {
    return res.status(502).json({ error: e?.message || 'Stock refresh failed' })
  }
})
