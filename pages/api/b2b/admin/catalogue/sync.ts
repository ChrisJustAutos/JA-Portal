// pages/api/b2b/admin/catalogue/sync.ts
// POST /api/b2b/admin/catalogue/sync
// Triggers a full sync from MYOB JAWS Inventory into b2b_catalogue.
//
// Permission: edit:b2b_catalogue (admin / manager).
// Long-running — Vercel maxDuration set to 300s. If the JAWS catalogue ever
// regularly times this out, move to GH Actions following the stocktake worker
// pattern (lib/mechanicdesk-stocktake.ts + .github/workflows/mechanicdesk-stocktake.yml).

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../lib/authServer'
import { syncJawsCatalogue } from '../../../../../lib/b2b-catalogue-sync'

export const config = {
  maxDuration: 300, // seconds — Vercel Pro
}

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  try {
    const result = await syncJawsCatalogue(user.id)
    return res.status(200).json(result)
  } catch (e: any) {
    console.error('b2b catalogue sync failed:', e?.message || e)
    return res.status(500).json({
      error: e?.message || 'Catalogue sync failed',
    })
  }
})
